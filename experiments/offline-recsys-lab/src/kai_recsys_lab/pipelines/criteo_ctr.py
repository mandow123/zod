from __future__ import annotations

import copy
import hashlib
import json
import math
import statistics
import time
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
import torch
from torch import nn

from ..contracts import BinaryExample, DataOrigin, Split
from ..ctr.encoding import FeatureValue, TabularBatch, VocabularyFeatureEncoder
from ..ctr.metrics import BinaryPredictionMetrics, evaluate_binary_predictions
from ..ctr.models import DCNv2, DeepFM, SklearnLogisticRegressionCTR, binary_logit_loss
from ..data.criteo import (
    DISPLAY_CATEGORICAL_FEATURES,
    DISPLAY_INTEGER_FEATURES,
    load_criteo_display_tsv,
)
from ..public_report import canonical_sha256, validate_public_report


NUMERIC_NAMES = tuple(f"int_{index}" for index in range(1, DISPLAY_INTEGER_FEATURES + 1))
CATEGORICAL_NAMES = tuple(
    f"cat_{index}" for index in range(1, DISPLAY_CATEGORICAL_FEATURES + 1)
)


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True, slots=True)
class OrderedSplit:
    train: tuple[BinaryExample, ...]
    dev: tuple[BinaryExample, ...]
    test: tuple[BinaryExample, ...]
    digest: str


def fixed_source_order_split(
    examples: Sequence[BinaryExample],
    *,
    train_fraction: float,
    dev_fraction: float,
) -> OrderedSplit:
    """Make one fixed contiguous split without claiming wall-clock chronology."""

    if not examples:
        raise ValueError("cannot split an empty dataset")
    if not (0.0 < train_fraction < 1.0 and 0.0 < dev_fraction < 1.0):
        raise ValueError("split fractions must be in (0, 1)")
    if train_fraction + dev_fraction >= 1.0:
        raise ValueError("train and dev fractions must leave a test partition")
    train_end = int(len(examples) * train_fraction)
    dev_end = train_end + int(len(examples) * dev_fraction)
    if train_end < 2 or dev_end <= train_end or dev_end >= len(examples):
        raise ValueError("each fixed source-order split must be non-empty")

    assigned = (
        ("train", examples[:train_end]),
        ("dev", examples[train_end:dev_end]),
        ("test", examples[dev_end:]),
    )
    digest = hashlib.sha256()
    for split_name, rows in assigned:
        for row in rows:
            digest.update(f"{split_name}\t{row.example_id}\t{row.label}\n".encode())
    return OrderedSplit(
        train=tuple(assigned[0][1]),
        dev=tuple(assigned[1][1]),
        test=tuple(assigned[2][1]),
        digest=digest.hexdigest(),
    )


class TrainFittedCriteoPreprocessor:
    """Train-only numeric normalization and deterministic categorical capping."""

    def __init__(
        self,
        *,
        min_category_count: int,
        max_categories_per_feature: int,
    ) -> None:
        if min_category_count < 1 or max_categories_per_feature < 1:
            raise ValueError("categorical thresholds must be positive")
        self.min_category_count = min_category_count
        self.max_categories_per_feature = max_categories_per_feature
        self.numeric_mean: dict[str, float] = {}
        self.numeric_std: dict[str, float] = {}
        self.categories: dict[str, frozenset[str]] = {}
        self.fitted_example_ids: tuple[str, ...] = ()

    @staticmethod
    def _numeric(value: FeatureValue) -> float:
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("numeric features must be finite")
        return math.log1p(max(0.0, number))

    def fit(self, examples: Sequence[BinaryExample]) -> "TrainFittedCriteoPreprocessor":
        if not examples:
            raise ValueError("preprocessor requires train examples")
        self.fitted_example_ids = tuple(example.example_id for example in examples)
        for name in NUMERIC_NAMES:
            values = np.asarray(
                [self._numeric(example.features[name]) for example in examples],
                dtype=np.float64,
            )
            self.numeric_mean[name] = float(values.mean())
            std = float(values.std())
            self.numeric_std[name] = std if std > 1e-12 else 1.0
        for name in CATEGORICAL_NAMES:
            counts = Counter(str(example.features[name]) for example in examples)
            kept = [
                (value, count)
                for value, count in counts.items()
                if count >= self.min_category_count
            ]
            kept.sort(key=lambda item: (-item[1], item[0]))
            self.categories[name] = frozenset(
                value for value, _ in kept[: self.max_categories_per_feature]
            )
        return self

    def transform(self, examples: Sequence[BinaryExample]) -> list[dict[str, float | str]]:
        if not self.numeric_mean or not self.categories:
            raise RuntimeError("preprocessor must be fitted on train first")
        records: list[dict[str, float | str]] = []
        for example in examples:
            record: dict[str, float | str] = {
                name: (self._numeric(example.features[name]) - self.numeric_mean[name])
                / self.numeric_std[name]
                for name in NUMERIC_NAMES
            }
            record.update(
                {
                    name: (
                        str(example.features[name])
                        if str(example.features[name]) in self.categories[name]
                        else "__OOV__"
                    )
                    for name in CATEGORICAL_NAMES
                }
            )
            records.append(record)
        return records

    def report(self) -> dict[str, Any]:
        return {
            "fitRows": len(self.fitted_example_ids),
            "numericTransform": "log1p_nonnegative_then_train_zscore",
            "categoricalUnknown": "__OOV__",
            "minCategoryCount": self.min_category_count,
            "maxCategoriesPerFeature": self.max_categories_per_feature,
            "keptCategories": {name: len(values) for name, values in self.categories.items()},
        }


def _labels(examples: Sequence[BinaryExample]) -> np.ndarray:
    return np.asarray([example.label for example in examples], dtype=np.int64)


def _device(requested: str) -> torch.device:
    if requested == "auto":
        if torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")
    if requested not in {"cpu", "mps"}:
        raise ValueError("device must be auto, cpu, or mps")
    if requested == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("MPS requested but unavailable")
    return torch.device(requested)


def _predict_torch(
    model: nn.Module,
    batch: TabularBatch,
    *,
    device: torch.device,
    batch_size: int,
) -> np.ndarray:
    model.eval()
    result: list[np.ndarray] = []
    with torch.no_grad():
        for start in range(0, batch.batch_size, batch_size):
            stop = min(batch.batch_size, start + batch_size)
            inputs = TabularBatch(
                numeric=batch.numeric[start:stop].to(device),
                categorical=batch.categorical[start:stop].to(device),
            )
            result.append(torch.sigmoid(model(inputs)).cpu().numpy())
    return np.concatenate(result)


def _train_torch_model(
    model: nn.Module,
    *,
    train_batch: TabularBatch,
    train_labels: np.ndarray,
    dev_batch: TabularBatch,
    dev_labels: np.ndarray,
    seed: int,
    epochs: int,
    batch_size: int,
    learning_rate: float,
    weight_decay: float,
    device: torch.device,
) -> tuple[nn.Module, dict[str, Any]]:
    torch.manual_seed(seed)
    generator = torch.Generator(device="cpu").manual_seed(seed)
    model = model.to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(), learning_rate, weight_decay=weight_decay
    )
    labels = torch.tensor(train_labels, dtype=torch.float32)
    best_loss = math.inf
    best_epoch = 0
    best_state: dict[str, torch.Tensor] | None = None
    history: list[dict[str, float | int]] = []
    started = time.perf_counter()
    for epoch in range(1, epochs + 1):
        model.train()
        permutation = torch.randperm(train_batch.batch_size, generator=generator)
        loss_sum = 0.0
        seen = 0
        for start in range(0, train_batch.batch_size, batch_size):
            indices = permutation[start : start + batch_size]
            inputs = TabularBatch(
                numeric=train_batch.numeric[indices].to(device),
                categorical=train_batch.categorical[indices].to(device),
            )
            target = labels[indices].to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = binary_logit_loss(model(inputs), target)
            loss.backward()
            optimizer.step()
            count = int(indices.numel())
            seen += count
            loss_sum += float(loss.detach().cpu()) * count
        dev_probability = _predict_torch(
            model, dev_batch, device=device, batch_size=batch_size
        )
        dev_metrics = evaluate_binary_predictions(dev_labels, dev_probability)
        history.append(
            {
                "epoch": epoch,
                "trainLogLoss": loss_sum / seen,
                "devLogLoss": dev_metrics.log_loss,
            }
        )
        if dev_metrics.log_loss < best_loss:
            best_loss = dev_metrics.log_loss
            best_epoch = epoch
            best_state = copy.deepcopy(model.state_dict())
    if best_state is None:
        raise RuntimeError("training produced no checkpoint")
    model.load_state_dict(best_state)
    return model, {
        "bestEpoch": best_epoch,
        "bestDevLogLoss": best_loss,
        "history": history,
        "trainSeconds": time.perf_counter() - started,
        "device": str(device),
    }


def _metric_payload(metrics: BinaryPredictionMetrics) -> dict[str, Any]:
    value = asdict(metrics)
    return {
        "nExamples": value["n_examples"],
        "positiveRate": value["positive_rate"],
        "rocAuc": value["auc"],
        "prAuc": value["pr_auc"],
        "averagePrecision": value["average_precision"],
        "logLoss": value["log_loss"],
        "brierScore": value["brier_score"],
        "ece": value["expected_calibration_error"],
        "calibration": [
            {
                "lower": item["lower"],
                "upper": item["upper"],
                "count": item["count"],
                "meanPrediction": item["mean_prediction"],
                "positiveRate": item["positive_rate"],
            }
            for item in value["calibration"]
        ],
    }


def _summaries(runs: Sequence[dict[str, Any]]) -> dict[str, Any]:
    metrics = ("rocAuc", "prAuc", "logLoss", "brierScore", "ece")
    result: dict[str, Any] = {}
    for model_name in sorted({run["model"] for run in runs}):
        model_runs = [run for run in runs if run["model"] == model_name]
        summary: dict[str, Any] = {"seeds": [run["seed"] for run in model_runs]}
        for metric in metrics:
            values = [run["testMetrics"][metric] for run in model_runs]
            if any(value is None for value in values):
                summary[metric] = {"mean": None, "std": None}
            else:
                numeric = [float(value) for value in values]
                summary[metric] = {
                    "mean": statistics.fmean(numeric),
                    "std": statistics.pstdev(numeric),
                }
        result[model_name] = summary
    return result


def run_criteo_ctr_experiment(
    config: Mapping[str, Any],
    *,
    config_path: str | Path | None = None,
) -> dict[str, Any]:
    seeds = [int(seed) for seed in config["seeds"]]
    if seeds != [3407, 6502, 9109]:
        raise ValueError("Criteo CTR v1 seed protocol is frozen to [3407, 6502, 9109]")
    input_path = Path(config["dataset"]["inputTsv"])
    raw_path = Path(config["dataset"]["rawFile"])
    examples = load_criteo_display_tsv(
        input_path,
        split=Split.TRAIN,
        origin=DataOrigin.PUBLIC,
        limit=int(config["dataset"]["rowLimit"]),
    )
    split = fixed_source_order_split(
        examples,
        train_fraction=float(config["split"]["trainFraction"]),
        dev_fraction=float(config["split"]["devFraction"]),
    )
    preprocessor = TrainFittedCriteoPreprocessor(
        min_category_count=int(config["preprocessing"]["minCategoryCount"]),
        max_categories_per_feature=int(
            config["preprocessing"]["maxCategoriesPerFeature"]
        ),
    ).fit(split.train)
    train_records = preprocessor.transform(split.train)
    dev_records = preprocessor.transform(split.dev)
    test_records = preprocessor.transform(split.test)
    train_labels = _labels(split.train)
    dev_labels = _labels(split.dev)
    test_labels = _labels(split.test)

    encoder = VocabularyFeatureEncoder.fit(
        train_records,
        numeric_names=NUMERIC_NAMES,
        categorical_names=CATEGORICAL_NAMES,
    )
    train_batch = encoder.transform(train_records)
    dev_batch = encoder.transform(dev_records)
    test_batch = encoder.transform(test_records)
    device = _device(str(config["training"]["device"]))
    runs: list[dict[str, Any]] = []
    for seed in seeds:
        lr_started = time.perf_counter()
        logistic = SklearnLogisticRegressionCTR(
            numeric_names=NUMERIC_NAMES,
            categorical_names=CATEGORICAL_NAMES,
            seed=seed,
            max_iter=int(config["models"]["lr"]["maxIter"]),
        ).fit(train_records, train_labels)
        lr_dev = evaluate_binary_predictions(dev_labels, logistic.predict_proba(dev_records))
        lr_test = evaluate_binary_predictions(test_labels, logistic.predict_proba(test_records))
        runs.append(
            {
                "model": "logistic_regression",
                "seed": seed,
                "selectionMetric": {"name": "devLogLoss", "value": lr_dev.log_loss},
                "testMetrics": _metric_payload(lr_test),
                "trainSeconds": time.perf_counter() - lr_started,
            }
        )

        for name, model in (
            (
                "deepfm",
                DeepFM(
                    encoder.schema,
                    embedding_dim=int(config["models"]["deepfm"]["embeddingDim"]),
                    hidden_dims=tuple(config["models"]["deepfm"]["hiddenDims"]),
                    seed=seed,
                ),
            ),
            (
                "dcnv2",
                DCNv2(
                    encoder.schema,
                    embedding_dim=int(config["models"]["dcnv2"]["embeddingDim"]),
                    cross_depth=int(config["models"]["dcnv2"]["crossDepth"]),
                    hidden_dims=tuple(config["models"]["dcnv2"]["hiddenDims"]),
                    seed=seed,
                ),
            ),
        ):
            trained, training = _train_torch_model(
                model,
                train_batch=train_batch,
                train_labels=train_labels,
                dev_batch=dev_batch,
                dev_labels=dev_labels,
                seed=seed,
                epochs=int(config["training"]["epochs"]),
                batch_size=int(config["training"]["batchSize"]),
                learning_rate=float(config["training"]["learningRate"]),
                weight_decay=float(config["training"]["weightDecay"]),
                device=device,
            )
            test_probability = _predict_torch(
                trained,
                test_batch,
                device=device,
                batch_size=int(config["training"]["batchSize"]),
            )
            runs.append(
                {
                    "model": name,
                    "seed": seed,
                    "selectionMetric": {
                        "name": "devLogLoss",
                        "value": training["bestDevLogLoss"],
                    },
                    "testMetrics": _metric_payload(
                        evaluate_binary_predictions(test_labels, test_probability)
                    ),
                    "training": training,
                }
            )

    config_hash = (
        sha256_file(config_path) if config_path is not None else _sha256_bytes(_canonical_json(config))
    )
    dataset_files = [
        {
            "name": raw_path.name,
            "sha256": sha256_file(raw_path),
            "bytes": raw_path.stat().st_size,
            "role": "official_raw_parquet_shard",
        },
        {
            "name": input_path.name,
            "sha256": sha256_file(input_path),
            "bytes": input_path.stat().st_size,
            "role": "deterministic_fixed_prefix_tsv",
        },
    ]
    counts = {
        "allRows": len(examples),
        "allPositiveRows": int(_labels(examples).sum()),
        "trainRows": len(split.train),
        "trainPositiveRows": int(train_labels.sum()),
        "devRows": len(split.dev),
        "devPositiveRows": int(dev_labels.sum()),
        "testRows": len(split.test),
        "testPositiveRows": int(test_labels.sum()),
        "numericFeatures": len(NUMERIC_NAMES),
        "categoricalFeatures": len(CATEGORICAL_NAMES),
    }
    results = {"runs": runs, "summary": _summaries(runs)}
    report = {
        "schemaVersion": 1,
        "experimentId": config["experimentId"],
        "status": "COMPLETE",
        "dataOrigin": "public",
        "claimableOnlinePerformance": False,
        "source": config["source"],
        "evidence": {
            "datasetFiles": dataset_files,
            "configSha256": config_hash,
            "splitSha256": split.digest,
        },
        "dataset": {
            "scope": "one_official_parquet_shard_fixed_prefix_not_full_1tb_dataset",
            "samplingRule": config["dataset"]["samplingRule"],
            "rowsRead": len(examples),
            "positiveRows": int(_labels(examples).sum()),
        },
        "protocol": {
            "counts": counts,
            "splitSemantics": "fixed_contiguous_source_order_not_claimed_chronological",
            "seeds": seeds,
            "rows": {
                "train": len(split.train),
                "dev": len(split.dev),
                "test": len(split.test),
            },
            "positiveRows": {
                "train": int(train_labels.sum()),
                "dev": int(dev_labels.sum()),
                "test": int(test_labels.sum()),
            },
            "features": {
                "numeric": len(NUMERIC_NAMES),
                "categorical": len(CATEGORICAL_NAMES),
                "sameFeatureSetForAllModels": True,
            },
            "preprocessing": preprocessor.report(),
            "testDataUsedForSelection": False,
            "implementationAudit": config.get("implementationAudit"),
        },
        "results": results,
        "limitations": config["limitations"],
    }
    validate_public_report(report)
    report["resultSha256"] = canonical_sha256(report)
    return report


def load_config(path: str | Path) -> dict[str, Any]:
    with Path(path).open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("configuration root must be an object")
    return value


def write_report(report: Mapping[str, Any], path: str | Path) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def render_markdown_report(report: Mapping[str, Any]) -> str:
    summary = report["results"]["summary"]
    names = (
        ("logistic_regression", "Logistic Regression"),
        ("deepfm", "DeepFM"),
        ("dcnv2", "DCNv2"),
    )
    columns = (
        ("rocAuc", "ROC-AUC"),
        ("prAuc", "PR-AUC"),
        ("logLoss", "LogLoss"),
        ("brierScore", "Brier"),
        ("ece", "ECE"),
    )
    table = [
        "| Model | " + " | ".join(label for _, label in columns) + " |",
        "|---|" + "---:|" * len(columns),
    ]
    for key, label in names:
        values = [
            f"{float(summary[key][metric]['mean']):.6f} ± {float(summary[key][metric]['std']):.6f}"
            for metric, _ in columns
        ]
        table.append(f"| {label} | " + " | ".join(values) + " |")
    counts = report["protocol"]["counts"]
    audit = report["protocol"].get("implementationAudit") or {}
    limitations = "\n".join(f"- {value}" for value in report["limitations"])
    return "\n".join(
        [
            "# Criteo CTR public fixed-subset V1",
            "",
            f"Status: `{report['status']}`; data origin: `public`; online claim: `false`.",
            "",
            "## Frozen protocol",
            "",
            f"- Rows: {counts['trainRows']:,} train / {counts['devRows']:,} dev / {counts['testRows']:,} test.",
            "- Split: fixed contiguous source-order blocks; not claimed chronological.",
            "- Features: 13 numeric + 26 categorical, identical for all models; preprocessing fit on train only.",
            f"- Seeds: {', '.join(str(seed) for seed in report['protocol']['seeds'])}.",
            f"- Config SHA-256: `{report['evidence']['configSha256']}`.",
            f"- Split SHA-256: `{report['evidence']['splitSha256']}`.",
            f"- Result SHA-256: `{report['resultSha256']}`.",
            "",
            "## Test metrics — mean ± population std",
            "",
            *table,
            "",
            "The first DeepFM execution was invalidated before final reporting because unit-scale default factor "
            "initialization made train/dev loss explode. The implementation was corrected from train/dev evidence, "
            "then the same frozen split, seeds, feature set, epoch budget and test protocol were rerun. "
            f"Invalidated-run training digest: `{audit.get('priorRunDeepFmTrainingDigest', 'N/A')}`.",
            "",
            "LR has the strongest ROC-AUC and PR-AUC in this fixed subset; DeepFM has the lowest mean LogLoss/Brier; "
            "DeepFM and DCNv2 have lower mean ECE than LR. These are descriptive offline comparisons, not online lift.",
            "",
            "## Limitations",
            "",
            limitations,
            "",
        ]
    )
