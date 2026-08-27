from __future__ import annotations

import copy
import csv
import gzip
import hashlib
import json
import math
import statistics
import time
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable, Generic, Mapping, Sequence, TypeVar

import numpy as np
import torch
from torch import nn

from ..conversion.models import ESMM, NaivePostClickCVR, esmm_loss, post_click_cvr_loss
from ..ctr.encoding import FeatureValue, TabularBatch, VocabularyFeatureEncoder
from ..ctr.metrics import BinaryPredictionMetrics, evaluate_binary_predictions


OFFICIAL_COLUMNS = (
    "timestamp",
    "uid",
    "campaign",
    "conversion",
    "conversion_timestamp",
    "conversion_id",
    "attribution",
    "click",
    "click_pos",
    "click_nb",
    "cost",
    "cpo",
    "time_since_last_click",
    "cat1",
    "cat2",
    "cat3",
    "cat4",
    "cat5",
    "cat6",
    "cat7",
    "cat8",
    "cat9",
)
NUMERIC_FEATURES = ("cost",)
CATEGORICAL_FEATURES = ("campaign",) + tuple(f"cat{index}" for index in range(1, 10))
FEATURE_ALLOWLIST = NUMERIC_FEATURES + CATEGORICAL_FEATURES
LEAKAGE_EXCLUSIONS = {
    "uid": "anonymized user identifier excluded for privacy minimization and memorization risk",
    "timestamp": "used only for ordered splitting and audits, not as a model feature",
    "conversion": "raw outcome label",
    "conversion_timestamp": "post-impression outcome timestamp",
    "conversion_id": "post-impression outcome identifier",
    "attribution": "downstream attribution outcome; audit-only label, never a feature",
    "click": "outcome label",
    "click_pos": "post-click/post-conversion field",
    "click_nb": "post-click/post-conversion field",
    "cpo": "cost-per-order is available only for an attributed conversion",
    "time_since_last_click": "contains click-history information not registered as impression-time context",
}
THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60


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


class ArtifactGateError(RuntimeError):
    """Raised before parsing or training when the pinned artifact is not verified."""

    def __init__(self, readiness: Mapping[str, Any]) -> None:
        super().__init__(str(readiness["reason"]))
        self.readiness = dict(readiness)


@dataclass(frozen=True, slots=True)
class AttributionImpression:
    row_id: int
    timestamp: int
    click: int
    raw_conversion_30d: int
    ctcvr: int
    attribution: int
    features: Mapping[str, float | str]


@dataclass(frozen=True, slots=True)
class FrozenTemporalSplit:
    train: tuple[AttributionImpression, ...]
    dev: tuple[AttributionImpression, ...]
    test: tuple[AttributionImpression, ...]
    digest: str


T = TypeVar("T")


class FrozenTestOnceGate(Generic[T]):
    """Own the frozen test payload and allow exactly one bundled evaluation."""

    def __init__(self, payload_factory: Callable[[], T]) -> None:
        self._payload_factory = payload_factory
        self._consumed = False
        self.access_count = 0

    def consume(self) -> T:
        if self._consumed:
            raise RuntimeError("frozen test payload has already been consumed")
        self._consumed = True
        self.access_count = 1
        return self._payload_factory()


def _resolve_artifact_path(
    config: Mapping[str, Any], config_path: str | Path | None
) -> Path:
    configured = Path(str(config["dataset"]["artifactPath"]))
    if configured.is_absolute():
        return configured
    if config_path is None:
        return configured
    # Configs live at <lab>/configs/*.json; data paths are relative to <lab>.
    return Path(config_path).resolve().parent.parent / configured


def assess_artifact_readiness(
    config: Mapping[str, Any], *, config_path: str | Path | None = None
) -> dict[str, Any]:
    dataset = config["dataset"]
    source = config["source"]
    artifact_path = _resolve_artifact_path(config, config_path)
    expected_bytes = int(dataset["expectedBytes"])
    expected_sha256 = str(dataset["expectedSha256"]).lower()
    origin = str(dataset["dataOrigin"])

    if origin == "official_public":
        if source.get("license") != "CC-BY-NC-SA-4.0":
            return {
                "status": "BLOCKED_NOT_RUN",
                "reason": "official run requires the pinned CC-BY-NC-SA-4.0 license boundary",
                "artifactPath": str(artifact_path),
            }
        if source.get("usage") != "noncommercial_offline_research_only":
            return {
                "status": "BLOCKED_NOT_RUN",
                "reason": "official run is limited to noncommercial offline research",
                "artifactPath": str(artifact_path),
            }
        if not source.get("officialRepositoryRevision"):
            return {
                "status": "BLOCKED_NOT_RUN",
                "reason": "official repository revision must be pinned",
                "artifactPath": str(artifact_path),
            }
    elif origin != "synthetic_test_only":
        return {
            "status": "BLOCKED_NOT_RUN",
            "reason": f"unsupported dataOrigin: {origin}",
            "artifactPath": str(artifact_path),
        }

    if not artifact_path.is_file():
        return {
            "status": "DEFERRED_NOT_RUN",
            "reason": "pinned dataset artifact is absent; no training or metrics were run",
            "artifactPath": str(artifact_path),
            "expectedBytes": expected_bytes,
            "expectedSha256": expected_sha256,
        }
    observed_bytes = artifact_path.stat().st_size
    if observed_bytes != expected_bytes:
        return {
            "status": "BLOCKED_NOT_RUN",
            "reason": "artifact byte size does not match the pinned identity",
            "artifactPath": str(artifact_path),
            "expectedBytes": expected_bytes,
            "observedBytes": observed_bytes,
            "expectedSha256": expected_sha256,
        }
    observed_sha256 = sha256_file(artifact_path)
    if observed_sha256 != expected_sha256:
        return {
            "status": "BLOCKED_NOT_RUN",
            "reason": "artifact SHA-256 does not match the pinned identity",
            "artifactPath": str(artifact_path),
            "expectedBytes": expected_bytes,
            "observedBytes": observed_bytes,
            "expectedSha256": expected_sha256,
            "observedSha256": observed_sha256,
        }
    return {
        "status": "VERIFIED",
        "reason": "pinned artifact byte size and SHA-256 match",
        "artifactPath": str(artifact_path),
        "bytes": observed_bytes,
        "sha256": observed_sha256,
    }


def _parse_binary(row: Mapping[str, str], name: str, row_number: int) -> int:
    value = row[name]
    if value not in {"0", "1"}:
        raise ValueError(f"row {row_number}: {name} must be 0 or 1")
    return int(value)


def load_attribution_impressions(
    path: str | Path, *, row_limit: int
) -> tuple[AttributionImpression, ...]:
    if row_limit < 30:
        raise ValueError("rowLimit must be at least 30 for a three-way evaluation")
    rows: list[AttributionImpression] = []
    previous_timestamp = -1
    with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        if tuple(reader.fieldnames or ()) != OFFICIAL_COLUMNS:
            raise ValueError("dataset header does not exactly match the official pinned schema")
        for row_number, row in enumerate(reader, start=1):
            if row_number > row_limit:
                break
            timestamp = int(row["timestamp"])
            if timestamp < previous_timestamp:
                raise ValueError(f"row {row_number}: timestamps are not nondecreasing")
            if timestamp < 0:
                raise ValueError(f"row {row_number}: timestamp must be non-negative")
            previous_timestamp = timestamp
            click = _parse_binary(row, "click", row_number)
            raw_conversion = _parse_binary(row, "conversion", row_number)
            attribution = _parse_binary(row, "attribution", row_number)
            if attribution > raw_conversion:
                raise ValueError(f"row {row_number}: attribution cannot exist without conversion")
            conversion_timestamp = int(row["conversion_timestamp"])
            conversion_id = int(row["conversion_id"])
            if raw_conversion == 0 and (conversion_timestamp != -1 or conversion_id != -1):
                raise ValueError(
                    f"row {row_number}: non-conversion must use -1 conversion timestamp/id"
                )
            if raw_conversion == 1:
                delay = conversion_timestamp - timestamp
                if conversion_id < 0 or not 0 <= delay <= THIRTY_DAYS_SECONDS:
                    raise ValueError(
                        f"row {row_number}: conversion timestamp/id violates the 30-day label"
                    )
            cost = float(row["cost"])
            if not math.isfinite(cost) or cost < 0:
                raise ValueError(f"row {row_number}: cost must be finite and non-negative")
            categorical = {name: row[name] for name in CATEGORICAL_FEATURES}
            if any(value == "" for value in categorical.values()):
                raise ValueError(f"row {row_number}: categorical features must be non-empty")
            rows.append(
                AttributionImpression(
                    row_id=row_number,
                    timestamp=timestamp,
                    click=click,
                    raw_conversion_30d=raw_conversion,
                    ctcvr=click * raw_conversion,
                    attribution=attribution,
                    features={"cost": cost, **categorical},
                )
            )
    if len(rows) != row_limit:
        raise ValueError(f"artifact has only {len(rows)} data rows; rowLimit requires {row_limit}")
    return tuple(rows)


def frozen_temporal_split(
    rows: Sequence[AttributionImpression], *, train_fraction: float, dev_fraction: float
) -> FrozenTemporalSplit:
    if not rows:
        raise ValueError("cannot split an empty dataset")
    if not 0 < train_fraction < 1 or not 0 < dev_fraction < 1:
        raise ValueError("split fractions must be in (0, 1)")
    if train_fraction + dev_fraction >= 1:
        raise ValueError("train and dev fractions must leave a test partition")
    if any(right.timestamp < left.timestamp for left, right in zip(rows, rows[1:])):
        raise ValueError("temporal split requires nondecreasing timestamps")
    train_end = int(len(rows) * train_fraction)
    dev_end = train_end + int(len(rows) * dev_fraction)
    if train_end < 2 or dev_end <= train_end or dev_end >= len(rows):
        raise ValueError("all split partitions must be non-empty")
    partitions = (
        ("train", tuple(rows[:train_end])),
        ("dev", tuple(rows[train_end:dev_end])),
        ("test", tuple(rows[dev_end:])),
    )
    digest = hashlib.sha256()
    for name, partition in partitions:
        for row in partition:
            digest.update(
                f"{name}\t{row.row_id}\t{row.timestamp}\t{row.click}\t{row.raw_conversion_30d}"
                f"\t{row.ctcvr}\t{row.attribution}\n".encode()
            )
    return FrozenTemporalSplit(
        train=partitions[0][1],
        dev=partitions[1][1],
        test=partitions[2][1],
        digest=digest.hexdigest(),
    )


class TrainOnlyAttributionPreprocessor:
    """Fit cost normalization and categorical vocab caps on train rows only."""

    def __init__(self, *, min_category_count: int, max_categories_per_feature: int) -> None:
        if min_category_count < 1 or max_categories_per_feature < 1:
            raise ValueError("categorical thresholds must be positive")
        self.min_category_count = min_category_count
        self.max_categories_per_feature = max_categories_per_feature
        self.cost_mean: float | None = None
        self.cost_std: float | None = None
        self.categories: dict[str, frozenset[str]] = {}
        self.fitted_row_ids: tuple[int, ...] = ()

    def fit(
        self, rows: Sequence[AttributionImpression]
    ) -> "TrainOnlyAttributionPreprocessor":
        if not rows:
            raise ValueError("preprocessor requires train rows")
        self.fitted_row_ids = tuple(row.row_id for row in rows)
        costs = np.asarray([math.log1p(float(row.features["cost"])) for row in rows])
        self.cost_mean = float(costs.mean())
        standard_deviation = float(costs.std())
        self.cost_std = standard_deviation if standard_deviation > 1e-12 else 1.0
        for name in CATEGORICAL_FEATURES:
            counts = Counter(str(row.features[name]) for row in rows)
            kept = [(value, count) for value, count in counts.items() if count >= self.min_category_count]
            kept.sort(key=lambda item: (-item[1], item[0]))
            self.categories[name] = frozenset(
                value for value, _ in kept[: self.max_categories_per_feature]
            )
        return self

    def transform(
        self, rows: Sequence[AttributionImpression]
    ) -> list[dict[str, float | str]]:
        if self.cost_mean is None or self.cost_std is None or not self.categories:
            raise RuntimeError("preprocessor must be fitted on train rows first")
        records: list[dict[str, float | str]] = []
        for row in rows:
            record: dict[str, float | str] = {
                "cost": (math.log1p(float(row.features["cost"])) - self.cost_mean)
                / self.cost_std
            }
            record.update(
                {
                    name: (
                        str(row.features[name])
                        if str(row.features[name]) in self.categories[name]
                        else "__OOV__"
                    )
                    for name in CATEGORICAL_FEATURES
                }
            )
            records.append(record)
        return records

    def report(self) -> dict[str, Any]:
        return {
            "fitScope": "train_only",
            "fitRows": len(self.fitted_row_ids),
            "numericTransform": "log1p_nonnegative_then_train_zscore",
            "categoricalTransform": "train_frequency_cap_then_oov",
            "minCategoryCount": self.min_category_count,
            "maxCategoriesPerFeature": self.max_categories_per_feature,
            "keptCategories": {name: len(values) for name, values in self.categories.items()},
        }


def _labels(rows: Sequence[AttributionImpression], name: str) -> np.ndarray:
    if name == "click":
        return np.asarray([row.click for row in rows], dtype=np.int64)
    if name == "raw_conversion_30d":
        return np.asarray([row.raw_conversion_30d for row in rows], dtype=np.int64)
    if name == "ctcvr":
        return np.asarray([row.ctcvr for row in rows], dtype=np.int64)
    if name == "attribution":
        return np.asarray([row.attribution for row in rows], dtype=np.int64)
    raise ValueError(f"unknown label: {name}")


def _subset_batch(batch: TabularBatch, indices: torch.Tensor) -> TabularBatch:
    return TabularBatch(
        numeric=batch.numeric[indices], categorical=batch.categorical[indices]
    )


def _device(requested: str) -> torch.device:
    if requested == "auto":
        return torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    if requested not in {"cpu", "mps"}:
        raise ValueError("device must be auto, cpu, or mps")
    if requested == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("MPS requested but unavailable")
    return torch.device(requested)


def _initialize_model(model: nn.Module, *, seed: int) -> None:
    torch.manual_seed(seed)
    for module in model.modules():
        if isinstance(module, nn.Embedding):
            nn.init.normal_(module.weight, mean=0.0, std=0.01)
            if module.padding_idx is not None:
                with torch.no_grad():
                    module.weight[module.padding_idx].zero_()
        elif isinstance(module, nn.Linear):
            nn.init.xavier_uniform_(module.weight)
            if module.bias is not None:
                nn.init.zeros_(module.bias)


def _predict_naive(
    model: NaivePostClickCVR, batch: TabularBatch, *, device: torch.device, batch_size: int
) -> np.ndarray:
    model.eval()
    result: list[np.ndarray] = []
    with torch.no_grad():
        for start in range(0, batch.batch_size, batch_size):
            stop = min(batch.batch_size, start + batch_size)
            current = TabularBatch(
                numeric=batch.numeric[start:stop].to(device),
                categorical=batch.categorical[start:stop].to(device),
            )
            result.append(torch.sigmoid(model(current)).cpu().numpy())
    return np.concatenate(result)


def _predict_esmm(
    model: ESMM, batch: TabularBatch, *, device: torch.device, batch_size: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    model.eval()
    ctr: list[np.ndarray] = []
    ctcvr: list[np.ndarray] = []
    cvr: list[np.ndarray] = []
    with torch.no_grad():
        for start in range(0, batch.batch_size, batch_size):
            stop = min(batch.batch_size, start + batch_size)
            current = TabularBatch(
                numeric=batch.numeric[start:stop].to(device),
                categorical=batch.categorical[start:stop].to(device),
            )
            output = model(current)
            ctr.append(output.ctr_probability.cpu().numpy())
            ctcvr.append(output.ctcvr_probability.cpu().numpy())
            cvr.append(output.inferred_cvr().cpu().numpy())
    return np.concatenate(ctr), np.concatenate(ctcvr), np.concatenate(cvr)


def _train_naive(
    model: NaivePostClickCVR,
    *,
    train_batch: TabularBatch,
    train_click: np.ndarray,
    train_ctcvr: np.ndarray,
    dev_batch: TabularBatch,
    dev_click: np.ndarray,
    dev_ctcvr: np.ndarray,
    seed: int,
    epochs: int,
    batch_size: int,
    learning_rate: float,
    weight_decay: float,
    device: torch.device,
    calibration_bins: int,
) -> tuple[NaivePostClickCVR, dict[str, Any]]:
    clicked_train = np.flatnonzero(train_click == 1)
    if clicked_train.size == 0 or np.unique(train_ctcvr[clicked_train]).size != 2:
        raise ValueError("clicked train rows require both CVR classes")
    clicked_dev = dev_click == 1
    if not clicked_dev.any() or np.unique(dev_ctcvr[clicked_dev]).size != 2:
        raise ValueError("clicked dev rows require both CVR classes")
    model = model.to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=learning_rate, weight_decay=weight_decay
    )
    generator = torch.Generator(device="cpu").manual_seed(seed)
    train_ctcvr_tensor = torch.tensor(train_ctcvr, dtype=torch.float32)
    best_loss = math.inf
    best_epoch = 0
    best_state: dict[str, torch.Tensor] | None = None
    history: list[dict[str, float | int]] = []
    started = time.perf_counter()
    clicked_indices = torch.tensor(clicked_train, dtype=torch.long)
    for epoch in range(1, epochs + 1):
        model.train()
        permutation = clicked_indices[torch.randperm(clicked_indices.numel(), generator=generator)]
        loss_sum = 0.0
        seen = 0
        for start in range(0, permutation.numel(), batch_size):
            indices = permutation[start : start + batch_size]
            current = _subset_batch(train_batch, indices)
            current = TabularBatch(
                numeric=current.numeric.to(device), categorical=current.categorical.to(device)
            )
            converted = train_ctcvr_tensor[indices].to(device)
            clicked = torch.ones_like(converted)
            optimizer.zero_grad(set_to_none=True)
            loss = post_click_cvr_loss(model(current), clicked, converted)
            loss.backward()
            optimizer.step()
            count = int(indices.numel())
            seen += count
            loss_sum += float(loss.detach().cpu()) * count
        dev_probability = _predict_naive(
            model, dev_batch, device=device, batch_size=batch_size
        )
        dev_metrics = evaluate_binary_predictions(
            dev_ctcvr[clicked_dev],
            dev_probability[clicked_dev],
            n_calibration_bins=calibration_bins,
        )
        history.append(
            {
                "epoch": epoch,
                "clickedTrainLogLoss": loss_sum / seen,
                "clickedDevLogLoss": dev_metrics.log_loss,
            }
        )
        if dev_metrics.log_loss < best_loss:
            best_loss = dev_metrics.log_loss
            best_epoch = epoch
            best_state = copy.deepcopy(model.state_dict())
    if best_state is None:
        raise RuntimeError("naive CVR training produced no checkpoint")
    model.load_state_dict(best_state)
    return model, {
        "selectionMetric": "clicked_dev_log_loss",
        "bestEpoch": best_epoch,
        "bestDevLogLoss": best_loss,
        "history": history,
        "trainRows": int(clicked_train.size),
        "trainPopulation": "clicked_impressions_only",
        "trainSeconds": time.perf_counter() - started,
    }


def _train_esmm(
    model: ESMM,
    *,
    train_batch: TabularBatch,
    train_click: np.ndarray,
    train_ctcvr: np.ndarray,
    dev_batch: TabularBatch,
    dev_click: np.ndarray,
    dev_ctcvr: np.ndarray,
    seed: int,
    epochs: int,
    batch_size: int,
    learning_rate: float,
    weight_decay: float,
    device: torch.device,
    calibration_bins: int,
) -> tuple[ESMM, dict[str, Any]]:
    for name, labels in (("train click", train_click), ("train CTCVR", train_ctcvr), ("dev click", dev_click), ("dev CTCVR", dev_ctcvr)):
        if np.unique(labels).size != 2:
            raise ValueError(f"{name} requires both classes")
    model = model.to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=learning_rate, weight_decay=weight_decay
    )
    generator = torch.Generator(device="cpu").manual_seed(seed)
    click_tensor = torch.tensor(train_click, dtype=torch.float32)
    ctcvr_tensor = torch.tensor(train_ctcvr, dtype=torch.float32)
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
        for start in range(0, permutation.numel(), batch_size):
            indices = permutation[start : start + batch_size]
            current = _subset_batch(train_batch, indices)
            current = TabularBatch(
                numeric=current.numeric.to(device), categorical=current.categorical.to(device)
            )
            optimizer.zero_grad(set_to_none=True)
            loss = esmm_loss(
                model(current),
                click_tensor[indices].to(device),
                ctcvr_tensor[indices].to(device),
            )
            loss.backward()
            optimizer.step()
            count = int(indices.numel())
            seen += count
            loss_sum += float(loss.detach().cpu()) * count
        dev_ctr, dev_ctcvr_probability, _ = _predict_esmm(
            model, dev_batch, device=device, batch_size=batch_size
        )
        dev_ctr_metrics = evaluate_binary_predictions(
            dev_click, dev_ctr, n_calibration_bins=calibration_bins
        )
        dev_ctcvr_metrics = evaluate_binary_predictions(
            dev_ctcvr, dev_ctcvr_probability, n_calibration_bins=calibration_bins
        )
        selection_loss = dev_ctr_metrics.log_loss + dev_ctcvr_metrics.log_loss
        history.append(
            {
                "epoch": epoch,
                "trainJointLogLoss": loss_sum / seen,
                "devCtrLogLoss": dev_ctr_metrics.log_loss,
                "devCtcvrLogLoss": dev_ctcvr_metrics.log_loss,
                "devJointLogLoss": selection_loss,
            }
        )
        if selection_loss < best_loss:
            best_loss = selection_loss
            best_epoch = epoch
            best_state = copy.deepcopy(model.state_dict())
    if best_state is None:
        raise RuntimeError("ESMM training produced no checkpoint")
    model.load_state_dict(best_state)
    return model, {
        "selectionMetric": "dev_ctr_log_loss_plus_dev_ctcvr_log_loss",
        "bestEpoch": best_epoch,
        "bestDevJointLogLoss": best_loss,
        "history": history,
        "trainRows": train_batch.batch_size,
        "trainPopulation": "all_impressions",
        "trainSeconds": time.perf_counter() - started,
    }


def _metric_payload(metrics: BinaryPredictionMetrics) -> dict[str, Any]:
    payload = asdict(metrics)
    return {
        "rows": payload["n_examples"],
        "positiveRate": payload["positive_rate"],
        "auc": payload["auc"],
        "logLoss": payload["log_loss"],
        "brier": payload["brier_score"],
        "ece": payload["expected_calibration_error"],
        "calibration": [
            {
                "lower": item["lower"],
                "upper": item["upper"],
                "count": item["count"],
                "meanPrediction": item["mean_prediction"],
                "positiveRate": item["positive_rate"],
            }
            for item in payload["calibration"]
        ],
    }


def _label_counts(rows: Sequence[AttributionImpression]) -> dict[str, int]:
    return {
        "rows": len(rows),
        "clicks": int(_labels(rows, "click").sum()),
        "rawConversions30d": int(_labels(rows, "raw_conversion_30d").sum()),
        "ctcvrPositives": int(_labels(rows, "ctcvr").sum()),
        "viewThroughConversionsExcludedFromCtcvr": int(
            sum(row.raw_conversion_30d == 1 and row.click == 0 for row in rows)
        ),
        "attributedConversions": int(_labels(rows, "attribution").sum()),
    }


def _time_range(rows: Sequence[AttributionImpression]) -> dict[str, int]:
    return {"minTimestamp": rows[0].timestamp, "maxTimestamp": rows[-1].timestamp}


def _summary(runs: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    paths = {
        "naivePostClickCvr": ("naiveClickedOnlyCvr", "postClickCvr"),
        "esmmCtr": ("esmm", "ctr"),
        "esmmCtcvr": ("esmm", "ctcvr"),
        "esmmPostClickCvr": ("esmm", "postClickCvr"),
    }
    result: dict[str, Any] = {}
    for name, path in paths.items():
        metric_summary: dict[str, Any] = {}
        for metric in ("auc", "logLoss", "brier", "ece"):
            values = [float(run["testMetrics"][path[0]][path[1]][metric]) for run in runs]
            metric_summary[metric] = {
                "mean": statistics.fmean(values),
                "populationStd": statistics.pstdev(values),
            }
        result[name] = metric_summary
    return result


def run_criteo_esmm_experiment(
    config: Mapping[str, Any], *, config_path: str | Path | None = None
) -> dict[str, Any]:
    if config.get("protocolVersion") != "criteo-esmm-v1":
        raise ValueError("protocolVersion must be criteo-esmm-v1")
    if config["labels"].get("ctcvrDefinition") != "click_x_raw_conversion_30d":
        raise ValueError("CTCVR definition is frozen to click_x_raw_conversion_30d")
    if tuple(config["features"]["allowlist"]) != FEATURE_ALLOWLIST:
        raise ValueError("feature allowlist differs from the frozen V1 contract")
    readiness = assess_artifact_readiness(config, config_path=config_path)
    if readiness["status"] != "VERIFIED":
        raise ArtifactGateError(readiness)

    dataset = config["dataset"]
    artifact_path = Path(readiness["artifactPath"])
    rows = load_attribution_impressions(
        artifact_path, row_limit=int(dataset["rowLimit"])
    )
    split = frozen_temporal_split(
        rows,
        train_fraction=float(config["split"]["trainFraction"]),
        dev_fraction=float(config["split"]["devFraction"]),
    )
    preprocessor = TrainOnlyAttributionPreprocessor(
        min_category_count=int(config["preprocessing"]["minCategoryCount"]),
        max_categories_per_feature=int(
            config["preprocessing"]["maxCategoriesPerFeature"]
        ),
    ).fit(split.train)
    train_records = preprocessor.transform(split.train)
    dev_records = preprocessor.transform(split.dev)
    encoder = VocabularyFeatureEncoder.fit(
        train_records,
        numeric_names=NUMERIC_FEATURES,
        categorical_names=CATEGORICAL_FEATURES,
    )
    train_batch = encoder.transform(train_records)
    dev_batch = encoder.transform(dev_records)
    train_click = _labels(split.train, "click")
    train_ctcvr = _labels(split.train, "ctcvr")
    dev_click = _labels(split.dev, "click")
    dev_ctcvr = _labels(split.dev, "ctcvr")

    training = config["training"]
    models_config = config["models"]
    seeds = [int(seed) for seed in config["seeds"]]
    if not seeds or len(set(seeds)) != len(seeds):
        raise ValueError("seeds must be a non-empty unique list")
    device = _device(str(training["device"]))
    trained_runs: list[dict[str, Any]] = []
    for seed in seeds:
        naive = NaivePostClickCVR(
            encoder.schema,
            embedding_dim=int(models_config["embeddingDim"]),
            hidden_dims=tuple(models_config["hiddenDims"]),
            seed=seed,
        )
        _initialize_model(naive, seed=seed)
        naive, naive_training = _train_naive(
            naive,
            train_batch=train_batch,
            train_click=train_click,
            train_ctcvr=train_ctcvr,
            dev_batch=dev_batch,
            dev_click=dev_click,
            dev_ctcvr=dev_ctcvr,
            seed=seed,
            epochs=int(training["epochs"]),
            batch_size=int(training["batchSize"]),
            learning_rate=float(training["learningRate"]),
            weight_decay=float(training["weightDecay"]),
            device=device,
            calibration_bins=int(config["metrics"]["eceBins"]),
        )
        esmm = ESMM(
            encoder.schema,
            embedding_dim=int(models_config["embeddingDim"]),
            hidden_dims=tuple(models_config["hiddenDims"]),
            seed=seed,
        )
        _initialize_model(esmm, seed=seed)
        esmm, esmm_training = _train_esmm(
            esmm,
            train_batch=train_batch,
            train_click=train_click,
            train_ctcvr=train_ctcvr,
            dev_batch=dev_batch,
            dev_click=dev_click,
            dev_ctcvr=dev_ctcvr,
            seed=seed,
            epochs=int(training["epochs"]),
            batch_size=int(training["batchSize"]),
            learning_rate=float(training["learningRate"]),
            weight_decay=float(training["weightDecay"]),
            device=device,
            calibration_bins=int(config["metrics"]["eceBins"]),
        )
        trained_runs.append(
            {
                "seed": seed,
                "naiveModel": naive,
                "esmmModel": esmm,
                "naiveTraining": naive_training,
                "esmmTraining": esmm_training,
            }
        )

    # Test records remain untransformed until every model/checkpoint is frozen.
    gate: FrozenTestOnceGate[
        tuple[TabularBatch, np.ndarray, np.ndarray]
    ] = FrozenTestOnceGate(
        lambda: (
            encoder.transform(preprocessor.transform(split.test)),
            _labels(split.test, "click"),
            _labels(split.test, "ctcvr"),
        )
    )
    test_batch, test_click, test_ctcvr = gate.consume()
    clicked_test = test_click == 1
    if not clicked_test.any() or np.unique(test_ctcvr[clicked_test]).size != 2:
        raise ValueError("clicked test rows require both CVR classes")
    runs: list[dict[str, Any]] = []
    for trained in trained_runs:
        naive_probability = _predict_naive(
            trained["naiveModel"],
            test_batch,
            device=device,
            batch_size=int(training["batchSize"]),
        )
        ctr_probability, ctcvr_probability, cvr_probability = _predict_esmm(
            trained["esmmModel"],
            test_batch,
            device=device,
            batch_size=int(training["batchSize"]),
        )
        bins = int(config["metrics"]["eceBins"])
        runs.append(
            {
                "seed": trained["seed"],
                "selection": {
                    "naiveClickedOnlyCvr": trained["naiveTraining"],
                    "esmm": trained["esmmTraining"],
                    "testDataUsedForSelection": False,
                },
                "testMetrics": {
                    "naiveClickedOnlyCvr": {
                        "postClickCvr": _metric_payload(
                            evaluate_binary_predictions(
                                test_ctcvr[clicked_test],
                                naive_probability[clicked_test],
                                n_calibration_bins=bins,
                            )
                        )
                    },
                    "esmm": {
                        "ctr": _metric_payload(
                            evaluate_binary_predictions(
                                test_click, ctr_probability, n_calibration_bins=bins
                            )
                        ),
                        "ctcvr": _metric_payload(
                            evaluate_binary_predictions(
                                test_ctcvr, ctcvr_probability, n_calibration_bins=bins
                            )
                        ),
                        "postClickCvr": _metric_payload(
                            evaluate_binary_predictions(
                                test_ctcvr[clicked_test],
                                cvr_probability[clicked_test],
                                n_calibration_bins=bins,
                            )
                        ),
                    },
                },
            }
        )
    if gate.access_count != 1:
        raise RuntimeError("test-once gate invariant failed")

    origin = str(dataset["dataOrigin"])
    status = "COMPLETE" if origin == "official_public" else "SYNTHETIC_TEST_ONLY"
    config_sha256 = (
        sha256_file(config_path)
        if config_path is not None
        else _sha256_bytes(_canonical_json(config))
    )
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "protocolVersion": "criteo-esmm-v1",
        "experimentId": config["experimentId"],
        "status": status,
        "dataOrigin": origin,
        "claimableOnlinePerformance": False,
        "source": config["source"],
        "artifact": {
            "fileName": artifact_path.name,
            "bytes": readiness["bytes"],
            "sha256": readiness["sha256"],
            "configSha256": config_sha256,
        },
        "dataBoundary": {
            "rowScope": dataset["samplingRule"],
            "labelDefinitions": config["labels"],
            "attributionBoundary": (
                "attribution is an audit-only downstream outcome and is excluded from features, "
                "training targets, model selection, and reported CVR/CTCVR metrics"
            ),
            "featureAllowlist": list(FEATURE_ALLOWLIST),
            "leakageExclusions": LEAKAGE_EXCLUSIONS,
        },
        "split": {
            "strategy": "fixed_contiguous_timestamp_order_70_15_15",
            "sha256": split.digest,
            "train": {**_label_counts(split.train), **_time_range(split.train)},
            "dev": {**_label_counts(split.dev), **_time_range(split.dev)},
            "test": {**_label_counts(split.test), **_time_range(split.test)},
        },
        "preprocessing": preprocessor.report(),
        "models": {
            "naiveClickedOnlyCvr": "trained only on clicked train impressions",
            "esmm": "joint CTR and click_x_raw_conversion_30d objectives on all train impressions",
            "sameFeatureSet": True,
        },
        "devSelection": {
            "naive": "minimum clicked-dev CVR LogLoss checkpoint",
            "esmm": "minimum dev CTR LogLoss plus dev CTCVR LogLoss checkpoint",
            "testUntouched": True,
        },
        "testOnceGate": {
            "accessCount": gate.access_count,
            "usedForSelection": False,
            "policy": "one bundled evaluation after all checkpoints are frozen",
        },
        "metrics": ["AUC", "LogLoss", "Brier", "ECE"],
        "results": {"runs": runs, "summary": _summary(runs)},
        "limitations": config["limitations"],
        "reproducibility": {
            "seeds": seeds,
            "device": str(device),
            "rowLimit": len(rows),
            "epochs": int(training["epochs"]),
            "batchSize": int(training["batchSize"]),
        },
    }
    report["resultSha256"] = _sha256_bytes(_canonical_json(report))
    return report


def load_config(path: str | Path) -> dict[str, Any]:
    with Path(path).open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("configuration root must be an object")
    return value


def write_report(report: Mapping[str, Any], path: str | Path) -> None:
    if report.get("status") != "COMPLETE" or report.get("dataOrigin") != "official_public":
        raise ValueError("only a complete official-public run may be persisted as a result report")
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def render_markdown_report(report: Mapping[str, Any]) -> str:
    if report.get("status") != "COMPLETE" or report.get("dataOrigin") != "official_public":
        raise ValueError("only a complete official-public run may be rendered")
    summary = report["results"]["summary"]
    model_names = (
        ("naivePostClickCvr", "Naive clicked-only CVR"),
        ("esmmCtr", "ESMM CTR"),
        ("esmmCtcvr", "ESMM CTCVR"),
        ("esmmPostClickCvr", "ESMM post-click CVR"),
    )
    table = [
        "| Evaluation | AUC | LogLoss | Brier | ECE |",
        "|---|---:|---:|---:|---:|",
    ]
    for key, label in model_names:
        values = []
        for metric in ("auc", "logLoss", "brier", "ece"):
            item = summary[key][metric]
            values.append(f"{item['mean']:.6f} ± {item['populationStd']:.6f}")
        table.append(f"| {label} | " + " | ".join(values) + " |")
    split = report["split"]
    limitations = "\n".join(f"- {item}" for item in report["limitations"])
    return "\n".join(
        [
            "# Criteo impression-level CVR / ESMM V1",
            "",
            f"Status: `{report['status']}`; online-performance claim: `false`.",
            "",
            "## Frozen evidence and boundary",
            "",
            f"- Artifact SHA-256: `{report['artifact']['sha256']}` ({report['artifact']['bytes']:,} bytes).",
            f"- Split SHA-256: `{split['sha256']}`.",
            "- CTCVR is pre-registered as `click × raw 30-day impression conversion`.",
            "- Raw conversion may include view-through association; attribution is audit-only and never a feature/target.",
            "- Preprocessing is fit on train only; test is consumed once after checkpoint freezing.",
            "",
            "## Split counts",
            "",
            f"- Train/dev/test rows: {split['train']['rows']:,} / {split['dev']['rows']:,} / {split['test']['rows']:,}.",
            f"- Train/dev/test CTCVR positives: {split['train']['ctcvrPositives']:,} / {split['dev']['ctcvrPositives']:,} / {split['test']['ctcvrPositives']:,}.",
            "",
            "## Frozen test metrics — mean ± population std across seeds",
            "",
            *table,
            "",
            "These are descriptive offline public-data measurements, not KAI production or online-lift evidence.",
            "",
            "## Limitations",
            "",
            limitations,
            "",
        ]
    )
