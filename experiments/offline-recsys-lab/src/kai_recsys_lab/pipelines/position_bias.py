from __future__ import annotations

import hashlib
import json
import math
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
import pandas as pd
from sklearn.feature_extraction import DictVectorizer
from sklearn.linear_model import LogisticRegression


REQUIRED_LOG_COLUMNS = {
    "timestamp",
    "item_id",
    "position",
    "click",
    "propensity_score",
    "user_feature_0",
    "user_feature_1",
    "user_feature_2",
    "user_feature_3",
}
REQUIRED_ITEM_COLUMNS = {
    "item_id",
    "item_feature_0",
    "item_feature_1",
    "item_feature_2",
    "item_feature_3",
}


@dataclass(frozen=True, slots=True)
class WeightDiagnostics:
    count: int
    mean: float
    variance: float
    maximum: float
    effective_sample_size: float
    clipped_count: int
    clipping_floor: float | None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _validate_fraction(name: str, value: float) -> float:
    checked = float(value)
    if not math.isfinite(checked) or not 0 < checked < 1:
        raise ValueError(f"{name} must be finite and in (0, 1)")
    return checked


def validate_logged_frame(frame: pd.DataFrame, *, action_count: int) -> None:
    missing = REQUIRED_LOG_COLUMNS.difference(frame.columns)
    if missing:
        raise ValueError(f"logged frame is missing columns: {sorted(missing)}")
    if frame.empty:
        raise ValueError("logged frame must not be empty")
    if action_count < 2:
        raise ValueError("action_count must be at least two")
    if frame["timestamp"].isna().any():
        raise ValueError("timestamps must parse without missing values")
    if not frame["click"].isin((0, 1)).all():
        raise ValueError("click must be binary")
    if not frame["position"].isin((1, 2, 3)).all():
        raise ValueError("position must be one of 1, 2, 3")
    if not frame["item_id"].between(0, action_count - 1).all():
        raise ValueError("item_id is outside the declared action catalog")
    propensity = frame["propensity_score"].to_numpy(dtype=np.float64)
    if not np.isfinite(propensity).all() or not ((propensity > 0) & (propensity <= 1)).all():
        raise ValueError("propensity_score must be finite and in (0, 1]")


def load_open_bandit_frame(log_path: Path, item_context_path: Path, *, action_count: int) -> pd.DataFrame:
    frame = pd.read_csv(log_path)
    item_context = pd.read_csv(item_context_path)
    unnamed = [column for column in frame.columns if column.startswith("Unnamed:")]
    if unnamed:
        frame = frame.rename(columns={unnamed[0]: "source_row_id"})
    elif "source_row_id" not in frame:
        frame.insert(0, "source_row_id", np.arange(len(frame), dtype=np.int64))
    item_unnamed = [column for column in item_context.columns if column.startswith("Unnamed:")]
    if item_unnamed:
        item_context = item_context.drop(columns=item_unnamed)
    missing_item = REQUIRED_ITEM_COLUMNS.difference(item_context.columns)
    if missing_item:
        raise ValueError(f"item context is missing columns: {sorted(missing_item)}")
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce", format="mixed")
    validate_logged_frame(frame, action_count=action_count)

    affinity_columns = [f"user-item_affinity_{item_id}" for item_id in range(action_count)]
    missing_affinity = set(affinity_columns).difference(frame.columns)
    if missing_affinity:
        raise ValueError(f"logged frame is missing affinity columns: {sorted(missing_affinity)[:3]}")
    affinity = frame[affinity_columns].to_numpy(dtype=np.float64)
    item_ids = frame["item_id"].to_numpy(dtype=np.int64)
    frame["selected_user_item_affinity"] = affinity[np.arange(len(frame)), item_ids]
    frame = frame.merge(item_context[list(REQUIRED_ITEM_COLUMNS)], on="item_id", how="left", validate="many_to_one")
    if frame[list(REQUIRED_ITEM_COLUMNS - {"item_id"})].isna().any().any():
        raise ValueError("item context does not cover all logged item ids")
    return frame.sort_values(["timestamp", "source_row_id"], kind="stable").reset_index(drop=True)


def temporal_split(
    frame: pd.DataFrame,
    *,
    train_fraction: float,
    dev_fraction: float,
) -> dict[str, pd.DataFrame]:
    train_fraction = _validate_fraction("train_fraction", train_fraction)
    dev_fraction = _validate_fraction("dev_fraction", dev_fraction)
    if train_fraction + dev_fraction >= 1:
        raise ValueError("train_fraction + dev_fraction must be below one")
    ordered = frame.sort_values(["timestamp", "source_row_id"], kind="stable").reset_index(drop=True)
    train_end = int(len(ordered) * train_fraction)
    dev_end = int(len(ordered) * (train_fraction + dev_fraction))
    if train_end < 1 or dev_end <= train_end or dev_end >= len(ordered):
        raise ValueError("split fractions produce an empty partition")
    return {
        "train": ordered.iloc[:train_end].copy(),
        "dev": ordered.iloc[train_end:dev_end].copy(),
        "test": ordered.iloc[dev_end:].copy(),
    }


def importance_weights(
    behavior_propensity: Sequence[float],
    *,
    target_probability: float,
    clipping_floor: float | None = None,
    self_normalize: bool = False,
) -> tuple[np.ndarray, WeightDiagnostics]:
    propensity = np.asarray(behavior_propensity, dtype=np.float64)
    if propensity.ndim != 1 or propensity.size == 0:
        raise ValueError("behavior_propensity must be a non-empty vector")
    if not np.isfinite(propensity).all() or not ((propensity > 0) & (propensity <= 1)).all():
        raise ValueError("behavior propensities must be finite and in (0, 1]")
    target_probability = float(target_probability)
    if not math.isfinite(target_probability) or not 0 < target_probability <= 1:
        raise ValueError("target_probability must be finite and in (0, 1]")
    checked_floor: float | None = None
    denominator = propensity.copy()
    clipped_count = 0
    if clipping_floor is not None:
        checked_floor = float(clipping_floor)
        if not math.isfinite(checked_floor) or not 0 < checked_floor <= 1:
            raise ValueError("clipping_floor must be finite and in (0, 1]")
        clipped_count = int((denominator < checked_floor).sum())
        denominator = np.maximum(denominator, checked_floor)
    weights = target_probability / denominator
    if self_normalize:
        weight_mean = float(weights.mean())
        if weight_mean <= 0:
            raise ValueError("importance weights have zero mass")
        weights = weights / weight_mean
    squared_sum = float(np.square(weights).sum())
    weight_sum = float(weights.sum())
    diagnostics = WeightDiagnostics(
        count=int(weights.size),
        mean=float(weights.mean()),
        variance=float(weights.var()),
        maximum=float(weights.max()),
        effective_sample_size=weight_sum * weight_sum / squared_sum,
        clipped_count=clipped_count,
        clipping_floor=checked_floor,
    )
    return weights, diagnostics


def weighted_log_loss(labels: Sequence[int], probabilities: Sequence[float], weights: Sequence[float]) -> float:
    labels_array = np.asarray(labels, dtype=np.float64)
    probabilities_array = np.asarray(probabilities, dtype=np.float64)
    weights_array = np.asarray(weights, dtype=np.float64)
    if labels_array.shape != probabilities_array.shape or labels_array.shape != weights_array.shape:
        raise ValueError("labels, probabilities and weights must have identical shapes")
    if labels_array.ndim != 1 or labels_array.size == 0 or not np.isin(labels_array, (0, 1)).all():
        raise ValueError("labels must be a non-empty binary vector")
    if not np.isfinite(probabilities_array).all() or not ((probabilities_array >= 0) & (probabilities_array <= 1)).all():
        raise ValueError("probabilities must be finite and in [0, 1]")
    if not np.isfinite(weights_array).all() or (weights_array < 0).any() or weights_array.sum() <= 0:
        raise ValueError("weights must be finite, non-negative and have positive mass")
    clipped = np.clip(probabilities_array, 1e-15, 1 - 1e-15)
    loss = -(labels_array * np.log(clipped) + (1 - labels_array) * np.log(1 - clipped))
    return float(np.average(loss, weights=weights_array))


def expected_calibration_error(
    labels: Sequence[int], probabilities: Sequence[float], *, bin_count: int = 10
) -> float:
    labels_array = np.asarray(labels, dtype=np.int64)
    probabilities_array = np.asarray(probabilities, dtype=np.float64)
    if labels_array.shape != probabilities_array.shape or labels_array.ndim != 1 or labels_array.size == 0:
        raise ValueError("labels and probabilities must be equally sized non-empty vectors")
    if bin_count < 1:
        raise ValueError("bin_count must be positive")
    bins = np.minimum((probabilities_array * bin_count).astype(np.int64), bin_count - 1)
    result = 0.0
    for bin_index in range(bin_count):
        mask = bins == bin_index
        if mask.any():
            result += float(mask.mean()) * abs(float(labels_array[mask].mean() - probabilities_array[mask].mean()))
    return result


def calibration_by_position(
    positions: Sequence[int], labels: Sequence[int], probabilities: Sequence[float]
) -> dict[str, dict[str, float | int]]:
    position_array = np.asarray(positions, dtype=np.int64)
    label_array = np.asarray(labels, dtype=np.int64)
    probability_array = np.asarray(probabilities, dtype=np.float64)
    if position_array.shape != label_array.shape or position_array.shape != probability_array.shape:
        raise ValueError("positions, labels and probabilities must have identical shapes")
    result: dict[str, dict[str, float | int]] = {}
    for position in (1, 2, 3):
        mask = position_array == position
        if not mask.any():
            raise ValueError(f"position {position} is absent")
        observed = float(label_array[mask].mean())
        predicted = float(probability_array[mask].mean())
        result[str(position)] = {
            "rows": int(mask.sum()),
            "clicks": int(label_array[mask].sum()),
            "observedCtr": observed,
            "meanPredictedCtr": predicted,
            "absoluteCalibrationGap": abs(observed - predicted),
        }
    return result


def position_standardized_ctr(source: pd.DataFrame, target: pd.DataFrame) -> float:
    source_rate = source.groupby("position", observed=True)["click"].mean()
    target_share = target["position"].value_counts(normalize=True).sort_index()
    if set(source_rate.index) != {1, 2, 3} or set(target_share.index) != {1, 2, 3}:
        raise ValueError("all three positions are required for standardization")
    return float(sum(float(target_share[position]) * float(source_rate[position]) for position in (1, 2, 3)))


def policy_value_estimates(
    bts_test: pd.DataFrame,
    random_test: pd.DataFrame,
    *,
    target_probability: float,
    clipping_thresholds: Sequence[float],
) -> dict[str, dict[str, float | int | None]]:
    labels = bts_test["click"].to_numpy(dtype=np.float64)
    propensity = bts_test["propensity_score"].to_numpy(dtype=np.float64)
    on_policy = float(random_test["click"].mean())
    estimates: dict[str, dict[str, float | int | None]] = {}

    def add(name: str, estimate: float, diagnostics: WeightDiagnostics | None = None) -> None:
        entry: dict[str, float | int | None] = {
            "estimate": float(estimate),
            "absoluteErrorToOnPolicy": abs(float(estimate) - on_policy),
        }
        if diagnostics is not None:
            entry.update(
                {
                    "effectiveSampleSize": diagnostics.effective_sample_size,
                    "weightVariance": diagnostics.variance,
                    "maxWeight": diagnostics.maximum,
                    "meanWeight": diagnostics.mean,
                    "clippedCount": diagnostics.clipped_count,
                    "clippingFloor": diagnostics.clipping_floor,
                }
            )
        estimates[name] = entry

    add("on_policy_random", on_policy)
    add("naive_bts", float(labels.mean()))
    add("position_as_feature_standardization", position_standardized_ctr(bts_test, random_test))
    raw_weights, raw_diagnostics = importance_weights(propensity, target_probability=target_probability)
    add("ips", float(np.mean(raw_weights * labels)), raw_diagnostics)
    add("snips", float(np.sum(raw_weights * labels) / np.sum(raw_weights)), raw_diagnostics)
    for threshold in clipping_thresholds:
        clipped_weights, clipped_diagnostics = importance_weights(
            propensity,
            target_probability=target_probability,
            clipping_floor=float(threshold),
        )
        suffix = str(float(threshold)).replace(".", "p")
        add(f"ips_clipped_{suffix}", float(np.mean(clipped_weights * labels)), clipped_diagnostics)
        add(
            f"snips_clipped_{suffix}",
            float(np.sum(clipped_weights * labels) / np.sum(clipped_weights)),
            clipped_diagnostics,
        )
    return estimates


def _feature_records(frame: pd.DataFrame, *, include_position: bool) -> list[dict[str, float | str]]:
    records: list[dict[str, float | str]] = []
    for row in frame.itertuples(index=False):
        record: dict[str, float | str] = {
            "item_id": f"item:{int(row.item_id)}",
            "user_feature_0": f"u0:{row.user_feature_0}",
            "user_feature_1": f"u1:{row.user_feature_1}",
            "user_feature_2": f"u2:{row.user_feature_2}",
            "user_feature_3": f"u3:{row.user_feature_3}",
            "selected_user_item_affinity": float(row.selected_user_item_affinity),
            "item_feature_0": float(row.item_feature_0),
            "item_feature_1": f"i1:{row.item_feature_1}",
            "item_feature_2": f"i2:{row.item_feature_2}",
            "item_feature_3": f"i3:{row.item_feature_3}",
        }
        if include_position:
            record["position"] = f"position:{int(row.position)}"
        records.append(record)
    return records


def _int32_sparse(matrix: Any) -> Any:
    if hasattr(matrix, "indices") and matrix.indices.dtype != np.int32:
        matrix = matrix.copy()
        matrix.indices = matrix.indices.astype(np.int32)
        matrix.indptr = matrix.indptr.astype(np.int32)
    return matrix


def fit_reward_model(
    train: pd.DataFrame,
    evaluation: Mapping[str, pd.DataFrame],
    *,
    include_position: bool,
    seed: int,
    max_iterations: int,
    regularization_c: float,
    sample_weights: Sequence[float] | None = None,
) -> dict[str, np.ndarray]:
    labels = train["click"].to_numpy(dtype=np.int64)
    if np.unique(labels).size != 2:
        raise ValueError("reward-model training data must contain clicks and non-clicks")
    vectorizer = DictVectorizer(sparse=True, sort=True)
    train_matrix = _int32_sparse(vectorizer.fit_transform(_feature_records(train, include_position=include_position)))
    model = LogisticRegression(
        C=float(regularization_c),
        max_iter=int(max_iterations),
        random_state=int(seed),
        solver="liblinear",
    )
    checked_weights = None if sample_weights is None else np.asarray(sample_weights, dtype=np.float64)
    if checked_weights is not None and checked_weights.shape != labels.shape:
        raise ValueError("sample weights must match training labels")
    model.fit(train_matrix, labels, sample_weight=checked_weights)
    return {
        name: model.predict_proba(
            _int32_sparse(vectorizer.transform(_feature_records(frame, include_position=include_position)))
        )[:, 1]
        for name, frame in evaluation.items()
    }


def _prediction_metrics(
    frame: pd.DataFrame,
    probabilities: np.ndarray,
    *,
    weights: np.ndarray | None = None,
) -> dict[str, Any]:
    labels = frame["click"].to_numpy(dtype=np.int64)
    if weights is None:
        weights = np.ones(len(frame), dtype=np.float64)
    return {
        "rows": int(len(frame)),
        "clicks": int(labels.sum()),
        "logLoss": weighted_log_loss(labels, probabilities, weights),
        "brier": float(np.average(np.square(probabilities - labels), weights=weights)),
        "ece": expected_calibration_error(labels, probabilities, bin_count=10),
        "calibrationByPosition": calibration_by_position(frame["position"], labels, probabilities),
    }


def _model_protocols(
    bts_train: pd.DataFrame,
    *,
    target_probability: float,
    clipping_thresholds: Sequence[float],
) -> list[tuple[str, bool, np.ndarray | None, WeightDiagnostics]]:
    propensity = bts_train["propensity_score"].to_numpy(dtype=np.float64)
    unit = np.ones(len(bts_train), dtype=np.float64)
    unit_diagnostics = WeightDiagnostics(
        count=len(unit),
        mean=1.0,
        variance=0.0,
        maximum=1.0,
        effective_sample_size=float(len(unit)),
        clipped_count=0,
        clipping_floor=None,
    )
    protocols: list[tuple[str, bool, np.ndarray | None, WeightDiagnostics]] = [
        ("naive", False, None, unit_diagnostics),
        ("position_as_feature", True, None, unit_diagnostics),
    ]
    ips_weights, ips_diagnostics = importance_weights(propensity, target_probability=target_probability)
    snips_weights, snips_diagnostics = importance_weights(
        propensity,
        target_probability=target_probability,
        self_normalize=True,
    )
    protocols.extend(
        [
            ("ips", False, ips_weights, ips_diagnostics),
            ("snips", False, snips_weights, snips_diagnostics),
        ]
    )
    for threshold in clipping_thresholds:
        weights, diagnostics = importance_weights(
            propensity,
            target_probability=target_probability,
            clipping_floor=float(threshold),
        )
        suffix = str(float(threshold)).replace(".", "p")
        protocols.append((f"ips_clipped_{suffix}", False, weights, diagnostics))
    return protocols


def split_manifest_hash(splits: Mapping[str, Mapping[str, pd.DataFrame]]) -> str:
    rows: list[str] = []
    for policy in sorted(splits):
        for split_name in ("train", "dev", "test"):
            frame = splits[policy][split_name]
            for row in frame[["source_row_id", "timestamp"]].itertuples(index=False):
                rows.append(f"{policy}|{split_name}|{int(row.source_row_id)}|{row.timestamp.isoformat()}")
    return hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()


def _aggregate_seed_metrics(per_seed: Mapping[str, Mapping[str, Any]]) -> dict[str, dict[str, float]]:
    model_names = sorted(next(iter(per_seed.values())).keys())
    result: dict[str, dict[str, float]] = {}
    for model_name in model_names:
        for metric_name in ("logLoss", "brier", "ece"):
            values = np.asarray(
                [float(seed_metrics[model_name]["randomTest"][metric_name]) for seed_metrics in per_seed.values()],
                dtype=np.float64,
            )
            result.setdefault(model_name, {})[f"randomTest_{metric_name}_mean"] = float(values.mean())
            result[model_name][f"randomTest_{metric_name}_std"] = float(values.std(ddof=0))
        weighted_values = np.asarray(
            [
                float(seed_metrics[model_name]["btsTestWeightedToRandom"]["logLoss"])
                for seed_metrics in per_seed.values()
            ],
            dtype=np.float64,
        )
        result[model_name]["btsTestWeightedLogLoss_mean"] = float(weighted_values.mean())
        result[model_name]["btsTestWeightedLogLoss_std"] = float(weighted_values.std(ddof=0))
        for position in (1, 2, 3):
            gaps = np.asarray(
                [
                    float(
                        seed_metrics[model_name]["randomTest"]["calibrationByPosition"][str(position)][
                            "absoluteCalibrationGap"
                        ]
                    )
                    for seed_metrics in per_seed.values()
                ],
                dtype=np.float64,
            )
            result[model_name][f"position{position}CalibrationGap_mean"] = float(gaps.mean())
            result[model_name][f"position{position}CalibrationGap_std"] = float(gaps.std(ddof=0))
    return result


def run_position_bias_experiment(config_path: Path, *, project_root: Path) -> dict[str, Any]:
    config_bytes = config_path.read_bytes()
    config = json.loads(config_bytes)
    dataset = config["dataset"]
    verified_files: list[dict[str, Any]] = []
    paths: dict[str, Path] = {}
    for source in dataset["files"]:
        path = project_root / source["relativePath"]
        if not path.is_file():
            raise FileNotFoundError(f"required public source is missing: {path}")
        actual_bytes = path.stat().st_size
        actual_sha = sha256_file(path)
        if actual_bytes != int(source["bytes"]) or actual_sha != source["sha256"]:
            raise ValueError(f"public source integrity mismatch: {source['id']}")
        paths[source["id"]] = path
        verified_files.append(
            {
                "id": source["id"],
                "name": source["id"],
                "url": source["url"],
                "sha256": actual_sha,
                "bytes": actual_bytes,
            }
        )

    action_count = int(config["targetPolicy"]["actionCount"])
    target_probability = float(config["targetPolicy"]["actionProbabilityAtEachPosition"])
    bts = load_open_bandit_frame(paths["bts_all"], paths["item_context"], action_count=action_count)
    random = load_open_bandit_frame(paths["random_all"], paths["item_context"], action_count=action_count)
    expected_random_probability = np.full(len(random), target_probability, dtype=np.float64)
    if not np.allclose(random["propensity_score"].to_numpy(dtype=np.float64), expected_random_probability):
        raise ValueError("random-policy propensity does not match the declared uniform target")

    split_config = config["split"]
    splits = {
        "bts": temporal_split(
            bts,
            train_fraction=split_config["trainFraction"],
            dev_fraction=split_config["devFraction"],
        ),
        "random": temporal_split(
            random,
            train_fraction=split_config["trainFraction"],
            dev_fraction=split_config["devFraction"],
        ),
    }
    thresholds = tuple(float(value) for value in config["clippingThresholds"])
    policy_values = policy_value_estimates(
        splits["bts"]["test"],
        splits["random"]["test"],
        target_probability=target_probability,
        clipping_thresholds=thresholds,
    )

    evaluation = {"btsTest": splits["bts"]["test"], "randomTest": splits["random"]["test"]}
    per_seed: dict[str, dict[str, Any]] = {}
    bts_test_weights, _ = importance_weights(
        splits["bts"]["test"]["propensity_score"],
        target_probability=target_probability,
        self_normalize=True,
    )
    model_config = config["models"]
    for seed_value in config["seeds"]:
        seed = int(seed_value)
        models: dict[str, Any] = {}
        for name, include_position, train_weights, weight_diagnostics in _model_protocols(
            splits["bts"]["train"],
            target_probability=target_probability,
            clipping_thresholds=thresholds,
        ):
            probabilities = fit_reward_model(
                splits["bts"]["train"],
                evaluation,
                include_position=include_position,
                seed=seed,
                max_iterations=int(model_config["maxIterations"]),
                regularization_c=float(model_config["regularizationC"]),
                sample_weights=train_weights,
            )
            models[name] = {
                "weightDiagnostics": {
                    "effectiveSampleSize": weight_diagnostics.effective_sample_size,
                    "weightVariance": weight_diagnostics.variance,
                    "maxWeight": weight_diagnostics.maximum,
                    "meanWeight": weight_diagnostics.mean,
                    "clippedCount": weight_diagnostics.clipped_count,
                    "clippingFloor": weight_diagnostics.clipping_floor,
                },
                "randomTest": _prediction_metrics(splits["random"]["test"], probabilities["randomTest"]),
                "btsTestWeightedToRandom": _prediction_metrics(
                    splits["bts"]["test"], probabilities["btsTest"], weights=bts_test_weights
                ),
            }
        per_seed[str(seed)] = models

    counts = {
        policy: {
            "rows": int(len(frame)),
            "actions": int(frame["item_id"].nunique()),
            "positions": {str(key): int(value) for key, value in frame["position"].value_counts().sort_index().items()},
            "clicks": int(frame["click"].sum()),
            "splitRows": {name: int(len(partition)) for name, partition in splits[policy].items()},
            "testClicks": int(splits[policy]["test"]["click"].sum()),
        }
        for policy, frame in (("bts", bts), ("random", random))
    }
    evidence = {
        "datasetFiles": verified_files,
        "configSha256": hashlib.sha256(config_bytes).hexdigest(),
        "splitSha256": split_manifest_hash(splits),
    }
    flat_counts = {
        "btsRows": counts["bts"]["rows"],
        "btsClicks": counts["bts"]["clicks"],
        "btsTrainRows": counts["bts"]["splitRows"]["train"],
        "btsDevRows": counts["bts"]["splitRows"]["dev"],
        "btsTestRows": counts["bts"]["splitRows"]["test"],
        "randomRows": counts["random"]["rows"],
        "randomClicks": counts["random"]["clicks"],
        "randomTrainRows": counts["random"]["splitRows"]["train"],
        "randomDevRows": counts["random"]["splitRows"]["dev"],
        "randomTestRows": counts["random"]["splitRows"]["test"],
        "actions": max(counts["bts"]["actions"], counts["random"]["actions"]),
        "positions": 3,
    }
    protocol = {
        "seeds": [int(seed) for seed in config["seeds"]],
        "counts": flat_counts,
        "countDetails": counts,
        "propensity": config["propensity"],
        "targetPolicy": config["targetPolicy"],
        "clippingThresholds": list(thresholds),
        "featureParity": {
            "naive_ips_snips_and_clipped": "same_base_features_without_position",
            "position_as_feature": "same_base_features_plus_position_only",
        },
        "split": config["split"],
    }
    results = {
        "policyValueEstimates": policy_values,
        "rewardModelsBySeed": per_seed,
        "rewardModelAggregate": _aggregate_seed_metrics(per_seed),
    }
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "experimentId": config["experimentId"],
        "status": "COMPLETE",
        "dataOrigin": "public",
        "claimableOnlinePerformance": False,
        "datasetScope": "official_quickstart_sample_10000_rows_per_policy_not_full_26m",
        "source": {
            "id": "open-bandit-dataset-small",
            "officialUrl": dataset["officialSourceUrl"],
            "officialSourceUrl": dataset["officialSourceUrl"],
            "officialRepositoryUrl": dataset["officialRepositoryUrl"],
            "paperUrl": dataset["paperUrl"],
            "repositoryRevision": dataset["repositoryRevision"],
            "terms": "CC BY 4.0 dataset license; citation requested by the official provider.",
            "termsDetail": dataset["terms"],
        },
        "evidence": evidence,
        "protocol": protocol,
        "results": results,
        "limitations": [
            "The official small files contain only 10,000 rows per policy and very few clicks; estimates and calibration bins have high sampling uncertainty.",
            "The logged propensity is item-at-position action-selection probability, not user examination propensity; this run does not causally identify or remove position examination bias.",
            "Position-as-feature may learn the presentation shortcut and is an associational baseline, not a debiasing method.",
            "The reward models are trained only on the BTS train partition and evaluated on a temporally later random-policy sample; no test result selected a feature, clipping threshold, or model.",
            "The official full archive identifies the dataset license as CC BY 4.0; this offline run still makes no production-performance claim.",
            "Offline OPE and calibration results are not evidence of online CTR or revenue lift.",
            "The three seed runs use a deterministic convex LR solver, so zero between-seed standard deviation is not a sampling-uncertainty estimate.",
        ],
    }
    result["resultSha256"] = canonical_hash(result)
    return result


def _new_streaming_weight_accumulator() -> dict[str, Any]:
    return {
        "rows": 0,
        "clicks": 0,
        "weightSum": 0.0,
        "weightSquaredSum": 0.0,
        "weightedClickSum": 0.0,
        "maxWeight": 0.0,
        "clippedCount": 0,
        "byPosition": {
            str(position): {"rows": 0, "clicks": 0, "weightSum": 0.0, "weightedClickSum": 0.0}
            for position in (1, 2, 3)
        },
    }


def _finalize_streaming_weight_accumulator(
    accumulator: Mapping[str, Any], *, clipping_floor: float | None
) -> dict[str, Any]:
    rows = int(accumulator["rows"])
    if rows < 1:
        raise ValueError("streaming estimator has no rows")
    weight_sum = float(accumulator["weightSum"])
    squared_sum = float(accumulator["weightSquaredSum"])
    mean = weight_sum / rows
    variance = squared_sum / rows - mean * mean
    result = {
        "ips": float(accumulator["weightedClickSum"]) / rows,
        "snips": float(accumulator["weightedClickSum"]) / weight_sum,
        "effectiveSampleSize": weight_sum * weight_sum / squared_sum,
        "weightVariance": max(0.0, variance),
        "meanWeight": mean,
        "maxWeight": float(accumulator["maxWeight"]),
        "clippedCount": int(accumulator["clippedCount"]),
        "clippingFloor": clipping_floor,
        "byPosition": {},
    }
    for position, position_values in accumulator["byPosition"].items():
        position_rows = int(position_values["rows"])
        position_weight_sum = float(position_values["weightSum"])
        result["byPosition"][position] = {
            "rows": position_rows,
            "clicks": int(position_values["clicks"]),
            "ips": float(position_values["weightedClickSum"]) / position_rows,
            "snips": float(position_values["weightedClickSum"]) / position_weight_sum,
        }
    return result


def stream_full_policy_test_partition(
    archive_path: Path,
    member: str,
    *,
    total_rows: int,
    test_start_timestamp: str,
    action_count: int,
    target_probability: float,
    clipping_thresholds: Sequence[float],
    chunk_rows: int,
    include_importance_weights: bool,
) -> dict[str, Any]:
    if total_rows < 1 or chunk_rows < 1:
        raise ValueError("total_rows and chunk_rows must be positive")
    test_start = pd.Timestamp(test_start_timestamp)
    if test_start.tzinfo is None:
        raise ValueError("test_start_timestamp must include a timezone")
    thresholds = tuple(float(value) for value in clipping_thresholds)
    base = {
        "rows": 0,
        "clicks": 0,
        "actions": set(),
        "positions": {str(position): {"rows": 0, "clicks": 0} for position in (1, 2, 3)},
        "firstTimestamp": None,
        "lastTimestamp": None,
    }
    accumulators: dict[str, dict[str, Any]] = {}
    if include_importance_weights:
        accumulators["unclipped"] = _new_streaming_weight_accumulator()
        for threshold in thresholds:
            accumulators[str(threshold)] = _new_streaming_weight_accumulator()
    row_offset = 0
    use_columns = ["timestamp", "item_id", "position", "click", "propensity_score"]
    with zipfile.ZipFile(archive_path) as archive, archive.open(member) as source:
        for chunk in pd.read_csv(source, usecols=use_columns, chunksize=chunk_rows):
            chunk_length = len(chunk)
            timestamps = pd.to_datetime(chunk["timestamp"], utc=True, errors="coerce", format="mixed")
            if timestamps.isna().any():
                raise ValueError(f"full archive member contains an invalid timestamp: {member}")
            chunk_end = row_offset + chunk_length
            test_mask = timestamps >= test_start
            if not test_mask.any():
                row_offset = chunk_end
                continue
            selected = chunk.loc[test_mask].copy()
            selected["timestamp"] = timestamps.loc[test_mask].to_numpy()
            validate_logged_frame(selected.assign(
                user_feature_0="unused",
                user_feature_1="unused",
                user_feature_2="unused",
                user_feature_3="unused",
            ), action_count=action_count)
            labels = selected["click"].to_numpy(dtype=np.float64)
            positions = selected["position"].to_numpy(dtype=np.int64)
            propensities = selected["propensity_score"].to_numpy(dtype=np.float64)
            if base["firstTimestamp"] is None:
                base["firstTimestamp"] = selected["timestamp"].iloc[0].isoformat()
            base["lastTimestamp"] = selected["timestamp"].iloc[-1].isoformat()
            base["rows"] += len(selected)
            base["clicks"] += int(labels.sum())
            base["actions"].update(int(value) for value in selected["item_id"].unique())
            for position in (1, 2, 3):
                mask = positions == position
                base["positions"][str(position)]["rows"] += int(mask.sum())
                base["positions"][str(position)]["clicks"] += int(labels[mask].sum())

            if include_importance_weights:
                for key, accumulator in accumulators.items():
                    threshold = None if key == "unclipped" else float(key)
                    denominator = propensities if threshold is None else np.maximum(propensities, threshold)
                    weights = target_probability / denominator
                    accumulator["rows"] += len(selected)
                    accumulator["clicks"] += int(labels.sum())
                    accumulator["weightSum"] += float(weights.sum())
                    accumulator["weightSquaredSum"] += float(np.square(weights).sum())
                    accumulator["weightedClickSum"] += float(np.dot(weights, labels))
                    accumulator["maxWeight"] = max(float(accumulator["maxWeight"]), float(weights.max()))
                    if threshold is not None:
                        accumulator["clippedCount"] += int((propensities < threshold).sum())
                    for position in (1, 2, 3):
                        mask = positions == position
                        position_accumulator = accumulator["byPosition"][str(position)]
                        position_accumulator["rows"] += int(mask.sum())
                        position_accumulator["clicks"] += int(labels[mask].sum())
                        position_accumulator["weightSum"] += float(weights[mask].sum())
                        position_accumulator["weightedClickSum"] += float(np.dot(weights[mask], labels[mask]))
            row_offset = chunk_end
    if row_offset != total_rows:
        raise ValueError(f"configured row count does not match archive member: {member}")
    if int(base["rows"]) < 1 or int(base["rows"]) >= total_rows:
        raise ValueError("timestamp cutoff must produce a non-empty proper test partition")
    base["actions"] = len(base["actions"])
    base["ctr"] = float(base["clicks"]) / int(base["rows"])
    if include_importance_weights:
        base["importanceWeights"] = {
            key: _finalize_streaming_weight_accumulator(
                accumulator,
                clipping_floor=None if key == "unclipped" else float(key),
            )
            for key, accumulator in accumulators.items()
        }
    return base


def run_full_position_bias_ope(config_path: Path, *, project_root: Path) -> dict[str, Any]:
    config_bytes = config_path.read_bytes()
    config = json.loads(config_bytes)
    dataset = config["dataset"]
    archive_config = dataset["fullArchive"]
    archive_path = project_root / archive_config["relativePath"]
    if not archive_path.is_file():
        raise FileNotFoundError(f"required public full archive is missing: {archive_path}")
    archive_bytes = archive_path.stat().st_size
    archive_sha = sha256_file(archive_path)
    if archive_bytes != int(archive_config["bytes"]) or archive_sha != archive_config["sha256"]:
        raise ValueError("public full archive integrity mismatch")
    action_count = int(config["targetPolicy"]["actionCount"])
    target_probability = float(config["targetPolicy"]["actionProbabilityAtEachPosition"])
    test_start_timestamp = str(config["fullOpe"]["testStartTimestamp"])
    thresholds = tuple(float(value) for value in config["clippingThresholds"])
    campaign = archive_config["allCampaign"]
    chunk_rows = int(config["fullOpe"]["chunkRows"])
    bts = stream_full_policy_test_partition(
        archive_path,
        campaign["btsMember"],
        total_rows=int(campaign["btsRows"]),
        test_start_timestamp=test_start_timestamp,
        action_count=action_count,
        target_probability=target_probability,
        clipping_thresholds=thresholds,
        chunk_rows=chunk_rows,
        include_importance_weights=True,
    )
    random = stream_full_policy_test_partition(
        archive_path,
        campaign["randomMember"],
        total_rows=int(campaign["randomRows"]),
        test_start_timestamp=test_start_timestamp,
        action_count=action_count,
        target_probability=target_probability,
        clipping_thresholds=thresholds,
        chunk_rows=chunk_rows,
        include_importance_weights=False,
    )
    on_policy = float(random["ctr"])
    estimators: dict[str, Any] = {
        "on_policy_random": {"estimate": on_policy, "absoluteErrorToOnPolicy": 0.0},
        "naive_bts": {
            "estimate": float(bts["ctr"]),
            "absoluteErrorToOnPolicy": abs(float(bts["ctr"]) - on_policy),
        },
    }
    random_position_share = {
        position: float(values["rows"]) / int(random["rows"])
        for position, values in random["positions"].items()
    }
    position_standardized = sum(
        random_position_share[position]
        * (float(bts["positions"][position]["clicks"]) / int(bts["positions"][position]["rows"]))
        for position in ("1", "2", "3")
    )
    estimators["position_stratified_associational"] = {
        "estimate": position_standardized,
        "absoluteErrorToOnPolicy": abs(position_standardized - on_policy),
    }
    for key, weighted in bts["importanceWeights"].items():
        suffix = "" if key == "unclipped" else f"_clipped_{key.replace('.', 'p')}"
        for estimator_name in ("ips", "snips"):
            estimate = float(weighted[estimator_name])
            by_position = {}
            for position in ("1", "2", "3"):
                position_estimate = float(weighted["byPosition"][position][estimator_name])
                random_position_ctr = (
                    float(random["positions"][position]["clicks"]) / int(random["positions"][position]["rows"])
                )
                by_position[position] = {
                    "estimate": position_estimate,
                    "onPolicyRandomCtr": random_position_ctr,
                    "absoluteErrorToOnPolicy": abs(position_estimate - random_position_ctr),
                }
            estimators[f"{estimator_name}{suffix}"] = {
                "estimate": estimate,
                "absoluteErrorToOnPolicy": abs(estimate - on_policy),
                "effectiveSampleSize": weighted["effectiveSampleSize"],
                "weightVariance": weighted["weightVariance"],
                "meanWeight": weighted["meanWeight"],
                "maxWeight": weighted["maxWeight"],
                "clippedCount": weighted["clippedCount"],
                "clippingFloor": weighted["clippingFloor"],
                "calibrationByPosition": by_position,
            }
    split_manifest = {
        "archiveSha256": archive_sha,
        "method": config["fullOpe"]["splitMethod"],
        "testStartTimestamp": test_start_timestamp,
        "members": {
            "bts": {"name": campaign["btsMember"], "rows": campaign["btsRows"], "testRows": bts["rows"]},
            "random": {
                "name": campaign["randomMember"],
                "rows": campaign["randomRows"],
                "testRows": random["rows"],
            },
        },
    }
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "experimentId": "position-bias-open-bandit-full-ope-v1",
        "status": "COMPLETE",
        "dataOrigin": "public",
        "claimableOnlinePerformance": False,
        "source": {
            "id": "open-bandit-dataset-full-v1.0",
            "officialUrl": dataset["officialSourceUrl"],
            "paperUrl": dataset["paperUrl"],
            "terms": "CC BY 4.0 dataset license; citation requested by the official provider.",
            "termsDetail": dataset["terms"],
        },
        "evidence": {
            "datasetFiles": [
                {
                    "id": archive_config["id"],
                    "name": "Open Bandit Dataset full v1.0 archive",
                    "url": archive_config["url"],
                    "sha256": archive_sha,
                    "bytes": archive_bytes,
                }
            ],
            "configSha256": hashlib.sha256(config_bytes).hexdigest(),
            "splitSha256": canonical_hash(split_manifest),
            "splitManifest": split_manifest,
        },
        "protocol": {
            "seeds": [int(seed) for seed in config["seeds"]],
            "seedUsage": "Full OPE is deterministic; seeds apply only to the separate small reward-model calibration run.",
            "counts": {
                "btsTestRows": int(bts["rows"]),
                "btsTestClicks": int(bts["clicks"]),
                "randomTestRows": int(random["rows"]),
                "randomTestClicks": int(random["clicks"]),
                "btsActions": int(bts["actions"]),
                "randomActions": int(random["actions"]),
                "positions": 3,
            },
            "countDetails": {"btsTest": bts, "randomTest": random},
            "propensity": config["propensity"],
            "targetPolicy": config["targetPolicy"],
            "clippingThresholds": list(thresholds),
            "testSetPolicy": config["split"]["testSetPolicy"],
        },
        "results": {"policyValueEstimates": estimators},
        "limitations": [
            "The full-data OPE result evaluates the fixed final 20% time window of the seven-day ALL campaign only; traffic volume means this is not exactly 20% of rows, and it is not an online experiment.",
            "The logged propensity is item-at-position action-selection probability, not examination propensity; causal position-examination debiasing is not identified.",
            "The paper's OPE validity assumptions include overlap/consistency and a reward model depending on item and position; violations remain possible.",
            "Clipping thresholds were preregistered and all are reported; none was selected on test results.",
            "The deterministic full OPE has no between-seed variance; sampling uncertainty is not represented by the listed seeds.",
            "No production, revenue-lift, or online-CTR claim follows from this offline public-data result.",
        ],
    }
    result["resultSha256"] = canonical_hash(result)
    return result


def full_ope_markdown_report(result: Mapping[str, Any]) -> str:
    rows = [
        "| Estimator | Policy value | Abs. error | ESS | Weight variance | Clipped |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for name, metrics in result["results"]["policyValueEstimates"].items():
        rows.append(
            "| {name} | {estimate:.8f} | {error:.8f} | {ess} | {variance} | {clipped} |".format(
                name=name,
                estimate=float(metrics["estimate"]),
                error=float(metrics["absoluteErrorToOnPolicy"]),
                ess="-" if "effectiveSampleSize" not in metrics else f"{float(metrics['effectiveSampleSize']):.2f}",
                variance="-" if "weightVariance" not in metrics else f"{float(metrics['weightVariance']):.6f}",
                clipped="-" if "clippedCount" not in metrics else str(metrics["clippedCount"]),
            )
        )
    position_rows = [
        "| Estimator | Position 1 abs. error | Position 2 abs. error | Position 3 abs. error |",
        "|---|---:|---:|---:|",
    ]
    for name, metrics in result["results"]["policyValueEstimates"].items():
        if "calibrationByPosition" not in metrics:
            continue
        by_position = metrics["calibrationByPosition"]
        position_rows.append(
            "| {name} | {p1:.8f} | {p2:.8f} | {p3:.8f} |".format(
                name=name,
                p1=float(by_position["1"]["absoluteErrorToOnPolicy"]),
                p2=float(by_position["2"]["absoluteErrorToOnPolicy"]),
                p3=float(by_position["3"]["absoluteErrorToOnPolicy"]),
            )
        )
    counts = result["protocol"]["counts"]
    return "\n".join(
        [
            "# Position Bias Validity — Open Bandit Dataset Full OPE",
            "",
            f"- Status: `{result['status']}`",
            f"- Data origin: `{result['dataOrigin']}`",
            f"- Claimable online performance: `{str(result['claimableOnlinePerformance']).lower()}`",
            f"- BTS held-out rows/clicks: `{counts['btsTestRows']}` / `{counts['btsTestClicks']}`",
            f"- Random held-out rows/clicks: `{counts['randomTestRows']}` / `{counts['randomTestClicks']}`",
            f"- Config SHA-256: `{result['evidence']['configSha256']}`",
            f"- Split SHA-256: `{result['evidence']['splitSha256']}`",
            f"- Result SHA-256: `{result['resultSha256']}`",
            "",
            "This deterministic run streams every held-out row in the official ALL-campaign full archive. "
            "It evaluates logged action-selection IPS validity, not latent examination-propensity correction.",
            "",
            "## Full held-out OPE",
            "",
            *rows,
            "",
            "## Calibration by position",
            "",
            *position_rows,
            "",
            "Per-position OPE estimates, raw counts, source evidence and all clipping diagnostics are preserved in the JSON report.",
            "",
            "## Limitations",
            "",
            *(f"- {limitation}" for limitation in result["limitations"]),
            "",
        ]
    )


def markdown_report(result: Mapping[str, Any]) -> str:
    values = result["results"]["policyValueEstimates"]
    rows = [
        "| Estimator | Policy value | Absolute error to random on-policy | ESS | Weight variance | Clipped |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for name, metrics in values.items():
        rows.append(
            "| {name} | {estimate:.8f} | {error:.8f} | {ess} | {variance} | {clipped} |".format(
                name=name,
                estimate=float(metrics["estimate"]),
                error=float(metrics["absoluteErrorToOnPolicy"]),
                ess="-" if "effectiveSampleSize" not in metrics else f"{float(metrics['effectiveSampleSize']):.2f}",
                variance="-" if "weightVariance" not in metrics else f"{float(metrics['weightVariance']):.6f}",
                clipped="-" if "clippedCount" not in metrics else str(metrics["clippedCount"]),
            )
        )
    aggregate_rows = [
        "| Reward model | Random-test LogLoss mean/std | Brier mean/std | ECE mean/std |",
        "|---|---:|---:|---:|",
    ]
    for name, metrics in result["results"]["rewardModelAggregate"].items():
        aggregate_rows.append(
            "| {name} | {ll:.8f} / {lls:.8f} | {brier:.8f} / {briers:.8f} | {ece:.8f} / {eces:.8f} |".format(
                name=name,
                ll=metrics["randomTest_logLoss_mean"],
                lls=metrics["randomTest_logLoss_std"],
                brier=metrics["randomTest_brier_mean"],
                briers=metrics["randomTest_brier_std"],
                ece=metrics["randomTest_ece_mean"],
                eces=metrics["randomTest_ece_std"],
            )
        )
    calibration_rows = [
        "| Reward model | Position 1 gap | Position 2 gap | Position 3 gap | Weighted BTS-test LogLoss |",
        "|---|---:|---:|---:|---:|",
    ]
    for name, metrics in result["results"]["rewardModelAggregate"].items():
        calibration_rows.append(
            "| {name} | {p1:.8f} | {p2:.8f} | {p3:.8f} | {weighted:.8f} |".format(
                name=name,
                p1=metrics["position1CalibrationGap_mean"],
                p2=metrics["position2CalibrationGap_mean"],
                p3=metrics["position3CalibrationGap_mean"],
                weighted=metrics["btsTestWeightedLogLoss_mean"],
            )
        )
    return "\n".join(
        [
            "# Position Bias Validity — Open Bandit Dataset Small",
            "",
            f"- Status: `{result['status']}`",
            f"- Data origin: `{result['dataOrigin']}`",
            f"- Claimable online performance: `{str(result['claimableOnlinePerformance']).lower()}`",
            f"- Config SHA-256: `{result['evidence']['configSha256']}`",
            f"- Split SHA-256: `{result['evidence']['splitSha256']}`",
            f"- Result SHA-256: `{result['resultSha256']}`",
            "",
            "This run uses the official 10,000-row-per-policy quickstart sample, not the 26M-row full dataset. "
            "The logged propensity supports action-selection OPE under its assumptions, but it is not an examination propensity. "
            "Therefore the run does not claim causal removal of latent position examination bias.",
            "",
            "## Off-policy estimates",
            "",
            *rows,
            "",
            "## Reward-model calibration on random-policy test data",
            "",
            *aggregate_rows,
            "",
            "## Position calibration and weighted metric",
            "",
            *calibration_rows,
            "",
            "Per-position observed CTR, predicted CTR, calibration gaps, all seed-level metrics, raw file hashes, "
            "weight diagnostics and clipping results are preserved in the JSON report.",
            "",
            "## Limitations",
            "",
            *(f"- {limitation}" for limitation in result["limitations"]),
            "",
        ]
    )
