from __future__ import annotations

import hashlib
import json
import math
import os
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd
import torch
from torch import nn
from torch.nn import functional as F

from kai_recsys_lab.contracts import Split
from kai_recsys_lab.evaluation.cohorts import (
    AblationResult,
    AblationSuiteResult,
    AblationVariant,
    CohortDefinition,
    CohortDimension,
    CohortFeatureSnapshot,
    ColdStartCohort,
    HistoryLengthCohort,
    ItemPopularityCohort,
    assign_cohorts,
    group_queries_by_cohort,
)
from kai_recsys_lab.evaluation.statistics import paired_user_bootstrap_ci
from kai_recsys_lab.pipelines.amazon_retrieval import (
    PreparedAmazonData,
    _encode_history,
    _file_evidence,
    _history_matrix,
    _metric_summary,
    _seed_everything,
    _sha256_bytes,
    prepare_amazon_data,
    ranking_metrics,
)
from kai_recsys_lab.pipelines.amazon_two_tower_v2 import (
    MetadataCatalog,
    build_metadata_catalog,
    load_checkpoint,
)
from kai_recsys_lab.ranking.din import (
    DinRerankerConfig,
    DinStyleReranker,
    TemperatureCalibration,
    calibrated_probabilities,
    fit_temperature,
)
from kai_recsys_lab.ranking.dcn import DcnRerankerConfig, DcnStyleReranker
from kai_recsys_lab.retrieval.ann_sweep import HnswSweepConfig, run_hnsw_sweep
from kai_recsys_lab.retrieval.frozen_candidates import CandidateBatch, FrozenHnswIndex, exact_topk


SHA256_PATTERN = "0123456789abcdef"
DENSE_FEATURE_NAMES = (
    "retrieval_score",
    "inverse_log_rank",
    "history_length",
    "train_item_popularity",
    "train_time_position",
    "recency_hours",
    "title_token_coverage",
    "category_token_coverage",
)


@dataclass(frozen=True, slots=True)
class QuerySet:
    user_indices: np.ndarray
    targets: np.ndarray
    timestamps: np.ndarray
    previous_timestamps: np.ndarray
    histories: tuple[np.ndarray, ...]


@dataclass(frozen=True, slots=True)
class PreparedV3:
    config: Mapping[str, Any]
    config_path: Path
    root: Path
    data: PreparedAmazonData
    metadata: MetadataCatalog
    model: nn.Module
    checkpoint_payload: Mapping[str, Any]
    evidence: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class SnapshotQueries:
    queries: QuerySet
    user_vectors: np.ndarray


@dataclass(frozen=True, slots=True)
class RetrievalSnapshot:
    item_vectors: np.ndarray
    train: SnapshotQueries
    dev: SnapshotQueries


@dataclass(frozen=True, slots=True)
class TrainingExamples:
    query_indices: np.ndarray
    item_indices: np.ndarray
    dense_features: np.ndarray
    labels: np.ndarray
    calibration_query_mask: np.ndarray


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _is_sha256(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(character in SHA256_PATTERN for character in value)


def _resolve(root: Path, value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else root / path


def load_v3_config(path: str | Path) -> dict[str, Any]:
    config = json.loads(Path(path).read_text(encoding="utf-8"))
    if config.get("schemaVersion") != 1:
        raise ValueError("V3 config schemaVersion must be 1")
    if config.get("dataOrigin") != "public" or config.get("claimableOnlinePerformance") is not False:
        raise ValueError("V3 is public offline research and cannot claim online performance")
    protocol = config.get("protocol", {})
    required_protocol = {
        "selectionSplit": "dev",
        "selectionSeed": 3407,
        "selectionMetric": "ndcg@100",
        "seeds": [3407, 6502, 9109],
        "ks": [20, 50, 100],
        "testTuningForbidden": True,
        "testExecutionLimit": 1,
        "calibrationSplit": "train_only",
        "pairedEvaluation": True,
    }
    for key, expected in required_protocol.items():
        if protocol.get(key) != expected:
            raise ValueError(f"V3 protocol {key} must remain {expected!r}")
    retrieval = config.get("retrieval", {})
    if int(retrieval.get("candidateK", 0)) < max(protocol["ks"]):
        raise ValueError("retrieval candidateK must cover every evaluation K")
    if int(retrieval.get("exactBatchSize", 0)) < 1:
        raise ValueError("exact retrieval batch size must be positive")
    hnsw = retrieval.get("hnsw", {})
    if min(int(hnsw.get(key, 0)) for key in ("efConstruction", "m", "efSearch")) < 1:
        raise ValueError("HNSW parameters must be positive")
    training = config.get("training", {})
    if min(
        int(training.get(key, 0))
        for key in (
            "maxQueries", "hardNegatives", "maxHistory", "scoreBatchSize", "scoreQueryBatch", "ablationQueryLimit",
        )
    ) < 1:
        raise ValueError("training query, hard-negative, history, and scoring batch limits must be positive")
    fraction = float(training.get("calibrationFraction", 0.0))
    if not 0.0 < fraction < 0.5:
        raise ValueError("train-only calibration fraction must be between zero and one half")
    grid = training.get("temperatureGrid", [])
    if not grid or any(float(value) <= 0 or not math.isfinite(float(value)) for value in grid):
        raise ValueError("temperature grid must contain positive finite values")
    statistics = config.get("statistics", {})
    confidence_level = float(statistics.get("confidenceLevel", 0.0))
    if not 0.0 < confidence_level < 1.0:
        raise ValueError("paired confidence level must be between zero and one")
    if min(int(statistics.get(key, 0)) for key in ("bootstrapSamples", "bootstrapSeed")) < 1:
        raise ValueError("paired bootstrap samples and seed must be positive")
    candidates = config.get("candidateConfigs", [])
    if len(candidates) < 2 or len({row.get("id") for row in candidates}) != len(candidates):
        raise ValueError("V3 requires at least two uniquely named preregistered dev candidates")
    for candidate in candidates:
        if candidate.get("modelType") not in {"din_style", "dcn_style"} or candidate.get("retrievalMode") not in {
            "exact", "hnsw",
        }:
            raise ValueError("V3 supports preregistered DIN/DCN exact/HNSW candidates")
        if candidate.get("negativeSampling") not in {"hard", "uniform", "in_batch"}:
            raise ValueError("reranker negative sampling must be hard, uniform, or in_batch")
        if min(int(candidate.get(key, 0)) for key in ("epochs", "batchSize")) < 1:
            raise ValueError("reranker epochs and batch size must be positive")
        if not candidate.get("hiddenDims") or any(int(width) < 1 for width in candidate["hiddenDims"]):
            raise ValueError("reranker hidden dimensions must be positive")
        if float(candidate.get("learningRate", 0.0)) <= 0:
            raise ValueError("reranker learning rate must be positive")
        if candidate.get("modelType") == "dcn_style" and int(candidate.get("crossLayers", 0)) < 1:
            raise ValueError("DCN cross layer count must be positive")
    if {candidate["modelType"] for candidate in candidates} != {"din_style", "dcn_style"}:
        raise ValueError("V3 candidate grid must execute both DIN and DCN")
    if {candidate["negativeSampling"] for candidate in candidates} != {"hard", "uniform", "in_batch"}:
        raise ValueError("V3 candidate grid must execute hard, uniform, and in-batch negatives")
    sweep = config.get("hnswSweep", {})
    if int(sweep.get("queryLimit", 0)) < 1 or int(sweep.get("k", 0)) < 1:
        raise ValueError("HNSW sweep query limit and K must be positive")
    sweep_configs = sweep.get("configs", [])
    if len(sweep_configs) < 2:
        raise ValueError("HNSW sweep requires at least two preregistered configurations")
    for row in sweep_configs:
        if min(int(row.get(key, 0)) for key in ("efConstruction", "m", "efSearch")) < 1:
            raise ValueError("HNSW sweep parameters must be positive")
    frozen = config.get("frozenV2", {})
    for key in (
        "configSha256", "resultSha256", "checkpointSha256", "splitSha256", "metadataFeatureSha256",
    ):
        if not _is_sha256(frozen.get(key)):
            raise ValueError(f"frozen V2 {key} must be an exact SHA-256")
    for split in ("train", "dev", "test"):
        row = config.get("dataset", {}).get("files", {}).get(split, {})
        if not row.get("name") or int(row.get("expectedBytes", 0)) < 1 or not _is_sha256(row.get("expectedSha256")):
            raise ValueError(f"dataset {split} file evidence is incomplete")
    metadata = config.get("metadata", {})
    if int(metadata.get("expectedBytes", 0)) < 1 or not _is_sha256(metadata.get("expectedSha256")):
        raise ValueError("metadata evidence is incomplete")
    return config


def _verify_file(path: Path, expected: Mapping[str, Any], label: str) -> Mapping[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"{label} is missing: {path}")
    evidence = _file_evidence(path)
    if evidence["bytes"] != int(expected["expectedBytes"]):
        raise ValueError(f"{label} byte length differs from the frozen contract")
    if evidence["sha256"] != expected["expectedSha256"]:
        raise ValueError(f"{label} SHA-256 differs from the frozen contract")
    return evidence


def _artifact_evidence(path: Path) -> Mapping[str, Any]:
    evidence = _file_evidence(path)
    return {"name": path.name, "bytes": evidence["bytes"], "sha256": evidence["sha256"]}


def _prepare(config_path: Path) -> PreparedV3:
    config = load_v3_config(config_path)
    root = config_path.resolve().parent.parent
    raw_dir = _resolve(root, config["dataset"]["rawDir"])
    dataset_evidence = {}
    for split in ("train", "dev", "test"):
        row = config["dataset"]["files"][split]
        dataset_evidence[split] = _verify_file(raw_dir / row["name"], row, f"Amazon {split}")
    metadata_path = raw_dir / config["metadata"]["file"]
    metadata_file_evidence = _verify_file(metadata_path, config["metadata"], "Amazon metadata")
    data_config = {**config, "dataset": {**config["dataset"], "rawDir": str(raw_dir)}}
    data = prepare_amazon_data(raw_dir, data_config)
    frozen = config["frozenV2"]
    if data.split_hash != frozen["splitSha256"]:
        raise ValueError("Amazon split digest differs from the frozen V2 checkpoint contract")
    metadata = build_metadata_catalog(
        metadata_path,
        data.catalog,
        max_vocabulary=int(config["metadata"]["maxVocabulary"]),
        max_title_tokens=int(config["metadata"]["maxTitleTokens"]),
        max_category_tokens=int(config["metadata"]["maxCategoryTokens"]),
    )
    if metadata.evidence["featureSha256"] != frozen["metadataFeatureSha256"]:
        raise ValueError("metadata feature digest differs from the frozen V2 checkpoint contract")

    v2_config_path = _resolve(root, frozen["config"])
    v2_result_path = _resolve(root, frozen["result"])
    checkpoint_path = _resolve(root, frozen["checkpoint"])
    if _file_evidence(v2_config_path)["sha256"] != frozen["configSha256"]:
        raise ValueError("frozen V2 config SHA-256 mismatch")
    if _file_evidence(v2_result_path)["sha256"] != frozen["resultSha256"]:
        raise ValueError("frozen V2 result SHA-256 mismatch")
    if _file_evidence(checkpoint_path)["sha256"] != frozen["checkpointSha256"]:
        raise ValueError("frozen V2 checkpoint SHA-256 mismatch")
    v2_result = json.loads(v2_result_path.read_text(encoding="utf-8"))
    if v2_result.get("status") != "COMPLETE":
        raise ValueError("frozen V2 result is not complete")
    if v2_result.get("evidence", {}).get("splitSha256") != data.split_hash:
        raise ValueError("frozen V2 result does not bind the current split")
    if v2_result.get("evidence", {}).get("metadata", {}).get("featureSha256") != metadata.evidence["featureSha256"]:
        raise ValueError("frozen V2 result does not bind the current metadata features")
    if v2_result.get("selectedCandidate", {}).get("id") != frozen["selectedCandidateId"]:
        raise ValueError("frozen V2 selected candidate changed")
    seed_row = v2_result.get("test", {}).get("perSeed", {}).get(str(frozen["checkpointSeed"]), {})
    if seed_row.get("checkpoint", {}).get("sha256") != frozen["checkpointSha256"]:
        raise ValueError("frozen V2 result does not bind the required checkpoint")
    model, payload = load_checkpoint(checkpoint_path, data, metadata)
    if payload.get("schemaVersion") != 1 or payload.get("seed") != frozen["checkpointSeed"]:
        raise ValueError("frozen V2 checkpoint schema or seed is invalid")
    if payload.get("candidateConfig", {}).get("id") != frozen["selectedCandidateId"]:
        raise ValueError("frozen V2 checkpoint candidate is invalid")
    if int(payload["candidateConfig"]["maxHistory"]) != int(config["training"]["maxHistory"]):
        raise ValueError("V3 history width must equal the frozen V2 checkpoint history width")
    evidence = {
        "datasetFiles": dataset_evidence,
        "metadataFile": metadata_file_evidence,
        "v2Config": _file_evidence(v2_config_path),
        "v2Result": _file_evidence(v2_result_path),
        "v2Checkpoint": _file_evidence(checkpoint_path),
    }
    return PreparedV3(config, config_path, root, data, metadata, model, payload, evidence)


def _history_index_matrix(histories: Sequence[np.ndarray], max_history: int) -> np.ndarray:
    matrix = np.full((len(histories), max_history), -1, dtype=np.int32)
    for row, history in enumerate(histories):
        values = np.asarray(history[-max_history:], dtype=np.int32)
        if len(values):
            matrix[row, -len(values):] = values
    return matrix


def _query_vectors(prepared: PreparedV3, queries: QuerySet) -> np.ndarray:
    candidate = prepared.checkpoint_payload["candidateConfig"]
    matrix = _history_matrix(queries.histories, max_history=int(candidate["maxHistory"]))
    with torch.no_grad():
        vectors = prepared.model.encode_users(
            torch.from_numpy(queries.user_indices.astype(np.int64) + 2),
            torch.from_numpy(matrix),
        ).numpy()
    if not np.isfinite(vectors).all():
        raise ValueError("frozen V2 produced non-finite user vectors")
    return vectors.astype(np.float32, copy=False)


def _training_queries(data: PreparedAmazonData, *, limit: int) -> QuerySet:
    candidates: dict[int, tuple[int, int, int, int, np.ndarray]] = {}
    prior_timestamp: dict[int, int] = {}
    ordered = data.train.reset_index(drop=False).sort_values(["timestamp", "index"], kind="stable")
    for row in ordered.itertuples(index=False):
        user = data.user_lookup[str(row.user_id)]
        target = data.item_lookup[str(row.parent_asin)]
        history = _encode_history(str(row.history), data.item_lookup)
        timestamp = int(row.timestamp)
        previous = prior_timestamp.get(user, timestamp)
        prior_timestamp[user] = timestamp
        if len(history) and target not in set(history.tolist()):
            candidates[user] = (target, timestamp, previous, int(row.index), history)
    if len(candidates) < 2:
        raise ValueError("at least two eligible train users are required for train-only calibration")
    ordered_users = sorted(
        candidates,
        key=lambda user: hashlib.sha256(f"v3-train-query:{data.users[user]}".encode("utf-8")).digest(),
    )[:limit]
    values = [candidates[user] for user in ordered_users]
    return QuerySet(
        np.asarray(ordered_users, dtype=np.int32),
        np.asarray([value[0] for value in values], dtype=np.int32),
        np.asarray([value[1] for value in values], dtype=np.int64),
        np.asarray([value[2] for value in values], dtype=np.int64),
        tuple(value[4] for value in values),
    )


def _heldout_queries(data: PreparedAmazonData, split: str) -> QuerySet:
    if split not in {"dev", "test"}:
        raise ValueError("held-out query split must be dev or test")
    frame = data.dev if split == "dev" else data.test
    train_last = data.train.groupby("user_id", sort=False)["timestamp"].max().to_dict()
    dev_last = data.dev.set_index("user_id")["timestamp"].to_dict()
    users: list[int] = []
    targets: list[int] = []
    timestamps: list[int] = []
    previous: list[int] = []
    histories: list[np.ndarray] = []
    for row in frame.itertuples(index=False):
        user = data.user_lookup.get(str(row.user_id))
        target = data.item_lookup.get(str(row.parent_asin))
        if user is None or target is None:
            continue
        timestamp = int(row.timestamp)
        prior = int(dev_last[str(row.user_id)]) if split == "test" else int(train_last[str(row.user_id)])
        history = _encode_history(str(row.history), data.item_lookup)
        if target in set(history.tolist()):
            raise ValueError(f"{split} target leaks into supplied history")
        users.append(user)
        targets.append(target)
        timestamps.append(timestamp)
        previous.append(prior)
        histories.append(history)
    expected_users = data.dev_query_users if split == "dev" else data.test_query_users
    expected_targets = data.dev_targets if split == "dev" else data.test_targets
    if not np.array_equal(np.asarray(users, dtype=np.int32), expected_users) or not np.array_equal(
        np.asarray(targets, dtype=np.int32), expected_targets
    ):
        raise ValueError("held-out query reconstruction differs from the frozen Amazon protocol")
    return QuerySet(
        np.asarray(users, dtype=np.int32),
        np.asarray(targets, dtype=np.int32),
        np.asarray(timestamps, dtype=np.int64),
        np.asarray(previous, dtype=np.int64),
        tuple(histories),
    )


def _atomic_npz(destination: Path, **arrays: np.ndarray) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    with temporary.open("wb") as handle:
        np.savez_compressed(handle, **arrays)
    os.replace(temporary, destination)


def _snapshot_arrays(prefix: str, value: SnapshotQueries, max_history: int) -> dict[str, np.ndarray]:
    queries = value.queries
    return {
        f"{prefix}_users": queries.user_indices,
        f"{prefix}_targets": queries.targets,
        f"{prefix}_timestamps": queries.timestamps,
        f"{prefix}_previous_timestamps": queries.previous_timestamps,
        f"{prefix}_histories": _history_index_matrix(queries.histories, max_history),
        f"{prefix}_history_lengths": np.asarray([min(len(row), max_history) for row in queries.histories], dtype=np.int32),
        f"{prefix}_user_vectors": value.user_vectors,
    }


def freeze_dev_retrieval(prepared: PreparedV3, destination: Path) -> Mapping[str, Any]:
    if destination.exists():
        raise FileExistsError("frozen V3 dev retrieval snapshot cannot be overwritten")
    training = prepared.config["training"]
    train_queries = _training_queries(prepared.data, limit=int(training["maxQueries"]))
    dev_queries = _heldout_queries(prepared.data, "dev")
    train = SnapshotQueries(train_queries, _query_vectors(prepared, train_queries))
    dev = SnapshotQueries(dev_queries, _query_vectors(prepared, dev_queries))
    with torch.no_grad():
        item_vectors = prepared.model.encode_items(torch.arange(2, len(prepared.data.catalog) + 2)).numpy()
    item_vectors = item_vectors.astype(np.float32, copy=False)
    if not np.isfinite(item_vectors).all():
        raise ValueError("frozen V2 produced non-finite item vectors")
    arrays = {
        "schema_version": np.asarray([1], dtype=np.int32),
        "item_vectors": item_vectors,
        "split_sha256": np.asarray([prepared.data.split_hash]),
        "checkpoint_sha256": np.asarray([prepared.config["frozenV2"]["checkpointSha256"]]),
        **_snapshot_arrays("train", train, int(training["maxHistory"])),
        **_snapshot_arrays("dev", dev, int(training["maxHistory"])),
    }
    _atomic_npz(destination, **arrays)
    evidence = dict(_artifact_evidence(destination))
    evidence.update({
        "trainQueries": len(train_queries.user_indices),
        "devQueries": len(dev_queries.user_indices),
        "catalogItems": len(item_vectors),
        "vectorDimension": item_vectors.shape[1],
        "testVectorsIncluded": False,
    })
    return evidence


def _queries_from_npz(payload: Mapping[str, np.ndarray], prefix: str) -> SnapshotQueries:
    matrix = np.asarray(payload[f"{prefix}_histories"], dtype=np.int32)
    lengths = np.asarray(payload[f"{prefix}_history_lengths"], dtype=np.int32)
    histories = tuple(row[row >= 0][-int(length):].astype(np.int32) for row, length in zip(matrix, lengths, strict=True))
    queries = QuerySet(
        np.asarray(payload[f"{prefix}_users"], dtype=np.int32),
        np.asarray(payload[f"{prefix}_targets"], dtype=np.int32),
        np.asarray(payload[f"{prefix}_timestamps"], dtype=np.int64),
        np.asarray(payload[f"{prefix}_previous_timestamps"], dtype=np.int64),
        histories,
    )
    return SnapshotQueries(queries, np.asarray(payload[f"{prefix}_user_vectors"], dtype=np.float32))


def load_retrieval_snapshot(
    path: Path,
    *,
    expected_sha256: str | None = None,
    expected_split_sha256: str,
    expected_checkpoint_sha256: str,
) -> RetrievalSnapshot:
    evidence = _file_evidence(path)
    if expected_sha256 is not None and evidence["sha256"] != expected_sha256:
        raise ValueError("frozen V3 retrieval snapshot SHA-256 mismatch")
    with np.load(path, allow_pickle=False) as payload:
        if payload["schema_version"].tolist() != [1]:
            raise ValueError("frozen V3 retrieval snapshot schema is invalid")
        if payload["split_sha256"].tolist() != [expected_split_sha256]:
            raise ValueError("frozen V3 retrieval snapshot split is invalid")
        if payload["checkpoint_sha256"].tolist() != [expected_checkpoint_sha256]:
            raise ValueError("frozen V3 retrieval snapshot checkpoint is invalid")
        snapshot = RetrievalSnapshot(
            np.asarray(payload["item_vectors"], dtype=np.float32),
            _queries_from_npz(payload, "train"),
            _queries_from_npz(payload, "dev"),
        )
    if not np.isfinite(snapshot.item_vectors).all():
        raise ValueError("frozen V3 retrieval snapshot contains non-finite item vectors")
    return snapshot


def _exclusions(data: PreparedAmazonData, queries: QuerySet, *, include_target: bool) -> tuple[np.ndarray, ...]:
    rows = []
    for user, target, history in zip(queries.user_indices, queries.targets, queries.histories, strict=True):
        values = set(history.tolist())
        if not include_target:
            values.update(data.train_items_by_user[int(user)].tolist())
        else:
            values.add(int(target))
        rows.append(np.asarray(sorted(values), dtype=np.int32))
    return tuple(rows)


def _hnsw(prepared: PreparedV3, item_vectors: np.ndarray, path: Path, *, create: bool) -> FrozenHnswIndex:
    config = prepared.config["retrieval"]["hnsw"]
    if create:
        index = FrozenHnswIndex(
            dimension=item_vectors.shape[1], item_count=len(item_vectors),
            ef_construction=int(config["efConstruction"]), m=int(config["m"]),
            ef_search=int(config["efSearch"]), seed=int(config["seed"]),
        ).fit(item_vectors)
        index.save(path)
        return index
    return FrozenHnswIndex.load(
        path, dimension=item_vectors.shape[1], item_count=len(item_vectors), ef_search=int(config["efSearch"]),
    )


def _dense_features(
    prepared: PreparedV3,
    queries: QuerySet,
    candidates: CandidateBatch,
) -> np.ndarray:
    if candidates.item_indices.shape != candidates.scores.shape or candidates.item_indices.shape[0] != len(queries.user_indices):
        raise ValueError("candidate IDs and scores must align with queries")
    item_popularity = np.zeros(len(prepared.data.catalog), dtype=np.float64)
    for items in prepared.data.train_items_by_user:
        item_popularity[items] += 1.0
    max_popularity = max(1.0, float(item_popularity.max()))
    train_min = int(prepared.data.train["timestamp"].min())
    train_max = int(prepared.data.train["timestamp"].max())
    time_span = max(1, train_max - train_min)
    max_history = int(prepared.config["training"]["maxHistory"])
    title_width = prepared.metadata.title_token_ids.shape[1]
    category_width = prepared.metadata.category_token_ids.shape[1]
    output = np.empty((*candidates.item_indices.shape, len(DENSE_FEATURE_NAMES)), dtype=np.float32)
    for row, (timestamp, previous, history) in enumerate(
        zip(queries.timestamps, queries.previous_timestamps, queries.histories, strict=True)
    ):
        items = candidates.item_indices[row]
        ranks = np.arange(1, len(items) + 1, dtype=np.float64)
        output[row, :, 0] = candidates.scores[row]
        output[row, :, 1] = 1.0 / np.log2(ranks + 1.0)
        output[row, :, 2] = math.log1p(min(len(history), max_history)) / math.log1p(max_history)
        output[row, :, 3] = np.log1p(item_popularity[items]) / math.log1p(max_popularity)
        output[row, :, 4] = np.clip((int(timestamp) - train_min) / time_span, 0.0, 1.0)
        recency_hours = max(0.0, (int(timestamp) - int(previous)) / 3_600_000.0)
        output[row, :, 5] = math.log1p(recency_hours) / math.log1p(24.0 * 3650.0)
        output[row, :, 6] = np.count_nonzero(prepared.metadata.title_token_ids[items + 2], axis=1) / title_width
        output[row, :, 7] = np.count_nonzero(prepared.metadata.category_token_ids[items + 2], axis=1) / category_width
    if not np.isfinite(output).all():
        raise ValueError("reranker dense features contain non-finite values")
    return output


def _sample_training_negatives(
    prepared: PreparedV3,
    snapshot: RetrievalSnapshot,
    index: FrozenHnswIndex,
    *,
    strategy: str,
    seed: int,
) -> CandidateBatch:
    queries = snapshot.train.queries
    count = int(prepared.config["training"]["hardNegatives"])
    exclusions = _exclusions(prepared.data, queries, include_target=True)
    if strategy == "hard":
        return index.query(snapshot.train.user_vectors, snapshot.item_vectors, exclusions, k=count)
    if strategy not in {"uniform", "in_batch"}:
        raise ValueError("unknown reranker negative sampling strategy")
    rng = np.random.default_rng(seed)
    item_count = len(snapshot.item_vectors)
    items = np.empty((len(queries.user_indices), count), dtype=np.int32)
    target_pool = queries.targets[rng.permutation(len(queries.targets))]
    for row, excluded in enumerate(exclusions):
        blocked = set(excluded.tolist())
        selected: list[int] = []
        if strategy == "in_batch":
            for offset in range(len(target_pool)):
                candidate = int(target_pool[(row + offset) % len(target_pool)])
                if candidate not in blocked and candidate not in selected:
                    selected.append(candidate)
                    if len(selected) == count:
                        break
        if len(selected) < count:
            eligible = np.asarray(
                [item for item in range(item_count) if item not in blocked and item not in selected], dtype=np.int32
            )
            needed = count - len(selected)
            if len(eligible) < needed:
                raise ValueError("frozen catalog does not contain enough uniform training negatives")
            selected.extend(rng.choice(eligible, size=needed, replace=False).tolist())
        items[row] = np.asarray(selected, dtype=np.int32)
    scores = np.einsum(
        "qd,qkd->qk", snapshot.train.user_vectors, snapshot.item_vectors[items], optimize=True
    ).astype(np.float32, copy=False)
    return CandidateBatch(items, scores)


def _training_examples(
    prepared: PreparedV3,
    snapshot: RetrievalSnapshot,
    index: FrozenHnswIndex,
    *,
    strategy: str,
    seed: int,
) -> TrainingExamples:
    queries = snapshot.train.queries
    negatives = _sample_training_negatives(prepared, snapshot, index, strategy=strategy, seed=seed)
    positive_scores = np.sum(snapshot.train.user_vectors * snapshot.item_vectors[queries.targets], axis=1)
    item_rows = np.concatenate((queries.targets[:, None], negatives.item_indices), axis=1)
    score_rows = np.concatenate((positive_scores[:, None], negatives.scores), axis=1)
    ordered_items = np.empty_like(item_rows, dtype=np.int32)
    ordered_scores = np.empty_like(score_rows, dtype=np.float32)
    ordered_labels = np.empty_like(score_rows, dtype=np.float32)
    for row, (items, scores, target) in enumerate(zip(item_rows, score_rows, queries.targets, strict=True)):
        order = np.lexsort((items, -scores))
        ordered_items[row] = items[order]
        ordered_scores[row] = scores[order]
        ordered_labels[row] = (items[order] == target).astype(np.float32)
    dense = _dense_features(prepared, queries, CandidateBatch(ordered_items, ordered_scores))
    query_order = sorted(
        range(len(queries.user_indices)),
        key=lambda row: hashlib.sha256(
            f"v3-calibration:{prepared.data.users[int(queries.user_indices[row])]}".encode("utf-8")
        ).digest(),
    )
    calibration_count = max(1, min(len(query_order) - 1, round(len(query_order) * float(prepared.config["training"]["calibrationFraction"]))))
    calibration_query_mask = np.zeros(len(query_order), dtype=np.bool_)
    calibration_query_mask[np.asarray(query_order[:calibration_count], dtype=np.int32)] = True
    width = ordered_items.shape[1]
    return TrainingExamples(
        np.repeat(np.arange(len(queries.user_indices), dtype=np.int32), width),
        ordered_items.reshape(-1),
        dense.reshape(-1, dense.shape[2]),
        ordered_labels.reshape(-1),
        calibration_query_mask,
    )


def _model(candidate: Mapping[str, Any], vector_dim: int) -> DinStyleReranker | DcnStyleReranker:
    common = {
        "vector_dim": vector_dim,
        "dense_feature_dim": len(DENSE_FEATURE_NAMES),
        "hidden_dims": tuple(int(value) for value in candidate["hiddenDims"]),
        "dropout": float(candidate["dropout"]),
    }
    if candidate["modelType"] == "din_style":
        return DinStyleReranker(DinRerankerConfig(**common))
    if candidate["modelType"] == "dcn_style":
        return DcnStyleReranker(DcnRerankerConfig(**common, cross_layers=int(candidate["crossLayers"])))
    raise ValueError("unknown reranker model type")


def _model_inputs(
    snapshot: RetrievalSnapshot,
    history_matrix: np.ndarray,
    query_indices: np.ndarray,
    item_indices: np.ndarray,
    dense_features: np.ndarray,
) -> tuple[torch.Tensor, ...]:
    histories = history_matrix[query_indices]
    mask = histories >= 0
    padded_items = np.concatenate((np.zeros((1, snapshot.item_vectors.shape[1]), dtype=np.float32), snapshot.item_vectors))
    history_vectors = padded_items[histories + 1]
    return (
        torch.from_numpy(snapshot.train.user_vectors[query_indices]),
        torch.from_numpy(snapshot.item_vectors[item_indices]),
        torch.from_numpy(history_vectors),
        torch.from_numpy(mask),
        torch.from_numpy(dense_features.astype(np.float32, copy=False)),
    )


def _fit_reranker(
    prepared: PreparedV3,
    snapshot: RetrievalSnapshot,
    examples: TrainingExamples,
    candidate: Mapping[str, Any],
    *,
    seed: int,
) -> tuple[DinStyleReranker | DcnStyleReranker, TemperatureCalibration, tuple[float, ...]]:
    _seed_everything(seed)
    model = _model(candidate, snapshot.item_vectors.shape[1])
    fit_mask = ~examples.calibration_query_mask[examples.query_indices]
    calibration_mask = examples.calibration_query_mask[examples.query_indices]
    fit_rows = np.flatnonzero(fit_mask)
    calibration_rows = np.flatnonzero(calibration_mask)
    if not len(fit_rows) or not len(calibration_rows):
        raise ValueError("train fit and train calibration partitions must both be non-empty")
    labels = examples.labels[fit_rows]
    positives = float(labels.sum())
    negatives = float(len(labels) - positives)
    if positives <= 0 or negatives <= 0:
        raise ValueError("reranker fit partition requires positive and hard-negative examples")
    loss_function = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(negatives / positives, dtype=torch.float32))
    optimizer = torch.optim.Adam(model.parameters(), lr=float(candidate["learningRate"]), weight_decay=float(candidate["weightDecay"]))
    rng = np.random.default_rng(seed)
    batch_size = int(candidate["batchSize"])
    history_matrix = _history_index_matrix(
        snapshot.train.queries.histories, int(prepared.config["training"]["maxHistory"])
    )
    losses: list[float] = []
    model.train()
    for _ in range(int(candidate["epochs"])):
        total_loss = 0.0
        total_rows = 0
        for row_ids in np.array_split(rng.permutation(fit_rows), math.ceil(len(fit_rows) / batch_size)):
            inputs = _model_inputs(
                snapshot,
                history_matrix,
                examples.query_indices[row_ids],
                examples.item_indices[row_ids],
                examples.dense_features[row_ids],
            )
            logits = model(*inputs)
            loss = loss_function(logits, torch.from_numpy(examples.labels[row_ids]))
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            total_loss += float(loss.detach()) * len(row_ids)
            total_rows += len(row_ids)
        losses.append(total_loss / total_rows)
    model.eval()
    calibration_logits: list[np.ndarray] = []
    with torch.no_grad():
        for row_ids in np.array_split(calibration_rows, math.ceil(len(calibration_rows) / batch_size)):
            inputs = _model_inputs(
                snapshot,
                history_matrix,
                examples.query_indices[row_ids],
                examples.item_indices[row_ids],
                examples.dense_features[row_ids],
            )
            calibration_logits.append(model(*inputs).numpy())
    calibration = fit_temperature(
        np.concatenate(calibration_logits), examples.labels[calibration_rows], prepared.config["training"]["temperatureGrid"]
    )
    return model, calibration, tuple(losses)


def _score_candidates(
    prepared: PreparedV3,
    snapshot: RetrievalSnapshot,
    queries: SnapshotQueries,
    candidates: CandidateBatch,
    model: DinStyleReranker | DcnStyleReranker,
    calibration: TemperatureCalibration,
    *,
    ablation_variant: AblationVariant = AblationVariant.FULL,
) -> np.ndarray:
    history_width = int(prepared.config["training"]["maxHistory"])
    history_matrix = _history_index_matrix(queries.queries.histories, history_width)
    padded_items = np.concatenate((np.zeros((1, snapshot.item_vectors.shape[1]), dtype=np.float32), snapshot.item_vectors))
    scores = np.empty(candidates.item_indices.shape, dtype=np.float64)
    batch_size = int(prepared.config["training"]["scoreBatchSize"])
    query_batch_size = int(prepared.config["training"]["scoreQueryBatch"])
    model.eval()
    with torch.no_grad():
        for query_offset in range(0, len(queries.queries.user_indices), query_batch_size):
            query_end = min(query_offset + query_batch_size, len(queries.queries.user_indices))
            query_slice = QuerySet(
                queries.queries.user_indices[query_offset:query_end],
                queries.queries.targets[query_offset:query_end],
                queries.queries.timestamps[query_offset:query_end],
                queries.queries.previous_timestamps[query_offset:query_end],
                queries.queries.histories[query_offset:query_end],
            )
            candidate_slice = CandidateBatch(
                candidates.item_indices[query_offset:query_end], candidates.scores[query_offset:query_end]
            )
            dense = _dense_features(prepared, query_slice, candidate_slice)
            enabled = set(ablation_variant.enabled_features)
            if "title" not in enabled:
                dense[:, :, DENSE_FEATURE_NAMES.index("title_token_coverage")] = 0.0
            if "category" not in enabled:
                dense[:, :, DENSE_FEATURE_NAMES.index("category_token_coverage")] = 0.0
            row_count, candidate_count = candidate_slice.item_indices.shape
            flat_query = np.repeat(np.arange(row_count), candidate_count)
            flat_items = candidate_slice.item_indices.reshape(-1)
            flat_dense = dense.reshape(-1, dense.shape[2])
            batch_scores = np.empty(len(flat_query), dtype=np.float64)
            for offset in range(0, len(flat_query), batch_size):
                end = min(offset + batch_size, len(flat_query))
                local_rows = flat_query[offset:end]
                global_rows = local_rows + query_offset
                histories = history_matrix[global_rows]
                logits = model(
                    torch.from_numpy(queries.user_vectors[global_rows]),
                    torch.from_numpy(snapshot.item_vectors[flat_items[offset:end]]),
                    torch.from_numpy(padded_items[histories + 1]),
                    torch.from_numpy(histories >= 0),
                    torch.from_numpy(flat_dense[offset:end]),
                ).numpy()
                batch_scores[offset:end] = calibrated_probabilities(logits, calibration.temperature)
            scores[query_offset:query_end] = batch_scores.reshape(row_count, candidate_count)
    return scores


def _variant_vectors(
    prepared: PreparedV3,
    queries: QuerySet,
    variant: AblationVariant,
) -> tuple[np.ndarray, np.ndarray]:
    enabled = set(variant.enabled_features)
    model = prepared.model
    item_ids = torch.arange(2, len(prepared.data.catalog) + 2)
    history_ids = torch.from_numpy(
        _history_matrix(queries.histories, max_history=int(prepared.config["training"]["maxHistory"]))
    )
    user_ids = torch.from_numpy(queries.user_indices.astype(np.int64) + 2)
    with torch.no_grad():
        item_id = model.item_id_embedding(item_ids)
        title = model._mean_metadata(model.title_token_ids[item_ids])
        category = model._mean_metadata(model.category_token_ids[item_ids])
        item_features = torch.cat(
            (
                item_id if "id" in enabled else torch.zeros_like(item_id),
                title if "title" in enabled else torch.zeros_like(title),
                category if "category" in enabled else torch.zeros_like(category),
            ),
            dim=1,
        )
        item_vectors = F.normalize(model.item_mlp(item_features), dim=1)

        history_item_id = model.item_id_embedding(history_ids)
        history_title = model._mean_metadata(model.title_token_ids[history_ids])
        history_category = model._mean_metadata(model.category_token_ids[history_ids])
        history_features = torch.cat(
            (
                history_item_id if "id" in enabled else torch.zeros_like(history_item_id),
                history_title if "title" in enabled else torch.zeros_like(history_title),
                history_category if "category" in enabled else torch.zeros_like(history_category),
            ),
            dim=2,
        )
        history_mask = history_ids.ne(0).to(dtype=history_features.dtype).unsqueeze(-1)
        history = (history_features * history_mask).sum(dim=1) / history_mask.sum(dim=1).clamp_min(1.0)
        user = model.user_embedding(user_ids)
        if "id" not in enabled:
            user = torch.zeros_like(user)
        user_vectors = F.normalize(model.user_mlp(torch.cat((user, history), dim=1)), dim=1)
    arrays = (user_vectors.numpy().astype(np.float32), item_vectors.numpy().astype(np.float32))
    if not all(np.isfinite(array).all() for array in arrays):
        raise ValueError("metadata ablation produced non-finite frozen vectors")
    return arrays


def _ablation_snapshot(
    prepared: PreparedV3,
    snapshot: RetrievalSnapshot,
    variant: AblationVariant,
) -> RetrievalSnapshot:
    train_users, item_vectors = _variant_vectors(prepared, snapshot.train.queries, variant)
    dev_users, repeated_items = _variant_vectors(prepared, snapshot.dev.queries, variant)
    if not np.array_equal(item_vectors, repeated_items):
        raise ValueError("ablation item vectors changed between query populations")
    return RetrievalSnapshot(
        item_vectors,
        SnapshotQueries(snapshot.train.queries, train_users),
        SnapshotQueries(snapshot.dev.queries, dev_users),
    )


def _rescored_candidate_batch(snapshot: RetrievalSnapshot, queries: SnapshotQueries, original: CandidateBatch) -> CandidateBatch:
    scores = np.einsum(
        "qd,qkd->qk", queries.user_vectors, snapshot.item_vectors[original.item_indices], optimize=True
    ).astype(np.float32, copy=False)
    items = np.empty_like(original.item_indices)
    ordered_scores = np.empty_like(scores)
    for row, (row_items, row_scores) in enumerate(zip(original.item_indices, scores, strict=True)):
        order = np.lexsort((row_items, -row_scores))
        items[row] = row_items[order]
        ordered_scores[row] = row_scores[order]
    return CandidateBatch(items, ordered_scores)


def _ablation_report(
    prepared: PreparedV3,
    snapshot: RetrievalSnapshot,
    candidates: CandidateBatch,
    model: DinStyleReranker | DcnStyleReranker,
    calibration: TemperatureCalibration,
    *,
    seed: int,
) -> Mapping[str, Any]:
    query_limit = min(int(prepared.config["training"]["ablationQueryLimit"]), len(snapshot.dev.user_vectors))
    dev = SnapshotQueries(
        QuerySet(
            snapshot.dev.queries.user_indices[:query_limit],
            snapshot.dev.queries.targets[:query_limit],
            snapshot.dev.queries.timestamps[:query_limit],
            snapshot.dev.queries.previous_timestamps[:query_limit],
            snapshot.dev.queries.histories[:query_limit],
        ),
        snapshot.dev.user_vectors[:query_limit],
    )
    snapshot = RetrievalSnapshot(snapshot.item_vectors, snapshot.train, dev)
    candidates = CandidateBatch(candidates.item_indices[:query_limit], candidates.scores[:query_limit])
    query_ids = tuple(
        hashlib.sha256(f"v3-dev-query:{prepared.data.users[int(user)]}".encode("utf-8")).hexdigest()[:24]
        for user in snapshot.dev.queries.user_indices
    )
    query_set_sha256 = _sha256_bytes("\n".join(query_ids).encode("utf-8"))
    results: list[AblationResult] = []
    report_rows: list[Mapping[str, Any]] = []
    max_k = max(prepared.config["protocol"]["ks"])
    for variant in AblationVariant:
        ablated = _ablation_snapshot(prepared, snapshot, variant)
        fixed_candidates = _rescored_candidate_batch(ablated, ablated.dev, candidates)
        scores = _score_candidates(
            prepared,
            ablated,
            ablated.dev,
            fixed_candidates,
            model,
            calibration,
            ablation_variant=variant,
        )
        ranking = _rerank(fixed_candidates, scores, max_k)
        metrics = ranking_metrics(ranking, ablated.dev.queries.targets, prepared.config["protocol"]["ks"])
        flat = {
            f"{metric}@{k}": float(metrics[str(k)][metric])
            for k in prepared.config["protocol"]["ks"]
            for metric in ("hitRate", "mrr", "ndcg")
        }
        result = AblationResult(variant, flat, len(query_ids), query_set_sha256, Split.DEV, seed)
        results.append(result)
        report_rows.append({
            "variant": variant.value,
            "enabledFeatures": variant.enabled_features,
            "metrics": metrics,
            "queryCount": len(query_ids),
            "querySetSha256": query_set_sha256,
        })
    suite = AblationSuiteResult("amazon-end-to-end-v3-frozen-input-zeroing", tuple(results))
    return {
        "protocolId": suite.protocol_id,
        "evaluationSplit": "dev",
        "seed": seed,
        "intervention": "frozen_selected_reranker_inference_input_zeroing",
        "candidateSet": "fixed_from_full_selected_retrieval_then_rescored",
        "querySelection": "first_frozen_dev_queries",
        "retrainedPerVariant": False,
        "rows": report_rows,
        "ndcgAt100DifferenceFromFull": dict(suite.differences_from_full("ndcg@100")),
    }


def _hnsw_sweep_report(prepared: PreparedV3, snapshot: RetrievalSnapshot) -> Mapping[str, Any]:
    config = prepared.config["hnswSweep"]
    query_count = min(int(config["queryLimit"]), len(snapshot.dev.user_vectors))
    k = int(config["k"])
    queries = snapshot.dev.user_vectors[:query_count]
    exact = exact_topk(
        queries,
        snapshot.item_vectors,
        tuple(np.asarray([], dtype=np.int32) for _ in range(query_count)),
        k=k,
        batch_size=int(prepared.config["retrieval"]["exactBatchSize"]),
    )
    artifact_root = _paths(prepared)["root"]
    artifact_root.mkdir(parents=True, exist_ok=True)
    result = run_hnsw_sweep(
        np.arange(len(snapshot.item_vectors), dtype=np.int64),
        snapshot.item_vectors,
        queries,
        exact.item_indices,
        configs=tuple(
            HnswSweepConfig(int(row["efConstruction"]), int(row["m"]), int(row["efSearch"]))
            for row in config["configs"]
        ),
        k=k,
        warmup_queries=int(config["warmupQueries"]),
        seed=int(config["seed"]),
        work_directory=artifact_root,
    )
    return {
        **asdict(result),
        "split": "dev",
        "querySelection": "first_frozen_dev_queries",
        "exclusionsApplied": False,
        "winnerSelected": False,
        "latencyScope": "local_process_wall_clock_not_production_sla",
    }


def _cohort_report(
    prepared: PreparedV3,
    queries: QuerySet,
    rankings: Sequence[np.ndarray],
    *,
    split: str,
) -> Mapping[str, Any]:
    if split not in {"dev", "test"} or not rankings:
        raise ValueError("cohort reporting requires dev/test rankings")
    evaluation_split = Split.DEV if split == "dev" else Split.TEST
    source_split = Split.TRAIN if split == "dev" else Split.DEV
    source = prepared.data.train if split == "dev" else pd.concat((prepared.data.train, prepared.data.dev))
    popularity = source["parent_asin"].astype(str).value_counts().to_dict()
    query_ids: list[str] = []
    assignments = []
    index_by_id: dict[str, int] = {}
    tied_timestamp_exclusions = 0
    for query_index, (user, target, timestamp, previous, history) in enumerate(zip(
        queries.user_indices,
        queries.targets,
        queries.timestamps,
        queries.previous_timestamps,
        queries.histories,
        strict=True,
    )):
        if int(previous) >= int(timestamp):
            tied_timestamp_exclusions += 1
            continue
        user_id = prepared.data.users[int(user)]
        query_id = hashlib.sha256(f"v3-{split}-cohort:{user_id}".encode("utf-8")).hexdigest()[:24]
        query_ids.append(query_id)
        index_by_id[query_id] = query_index
        assignments.append(assign_cohorts(CohortFeatureSnapshot(
            query_id=query_id,
            user_seen_before_cutoff=True,
            history_length_before_cutoff=len(history),
            item_interactions_before_cutoff=int(popularity.get(prepared.data.catalog[int(target)], 0)),
            source_split=source_split,
            evaluation_split=evaluation_split,
            feature_cutoff_timestamp_ms=int(previous),
            evaluation_timestamp_ms=int(timestamp),
        ), CohortDefinition()))
    if any(ranking.shape[0] != len(queries.user_indices) for ranking in rankings):
        raise ValueError("cohort rankings must align with the frozen query population")
    if not assignments:
        raise ValueError("no cohort query has a strict pre-evaluation feature cutoff")
    expected = {
        CohortDimension.COLD_START: tuple(value.value for value in ColdStartCohort),
        CohortDimension.HISTORY_LENGTH: tuple(value.value for value in HistoryLengthCohort),
        CohortDimension.ITEM_POPULARITY: tuple(value.value for value in ItemPopularityCohort),
    }
    dimensions: dict[str, Any] = {}
    for dimension, cohort_names in expected.items():
        groups = group_queries_by_cohort(assignments, dimension)
        rows: dict[str, Any] = {}
        for cohort_name in cohort_names:
            member_ids = groups.get(cohort_name, ())
            indices = np.asarray([index_by_id[query_id] for query_id in member_ids], dtype=np.int32)
            if not len(indices):
                rows[cohort_name] = {
                    "queryCount": 0,
                    "metrics": None,
                    "reason": "cohort_not_observed_in_frozen_split",
                }
                continue
            metrics = [
                ranking_metrics(ranking[indices], queries.targets[indices], prepared.config["protocol"]["ks"])
                for ranking in rankings
            ]
            rows[cohort_name] = {"queryCount": len(indices), "metrics": _metric_summary(metrics)}
        dimensions[dimension.value] = rows
    return {
        "split": split,
        "featureSourceSplit": source_split.value,
        "queryCount": len(query_ids),
        "equalTimestampQueriesExcluded": tied_timestamp_exclusions,
        "querySetSha256": _sha256_bytes("\n".join(query_ids).encode("utf-8")),
        "evaluationOutcomeUsedForAssignment": False,
        "targetIdentityUsedOnlyForPreCutoffItemPopularity": True,
        "dimensions": dimensions,
        "fiveCoreProtocolNote": "new-user cohorts may be empty because the frozen two-tower vocabulary contains train users only",
    }


def _rerank(candidates: CandidateBatch, scores: np.ndarray, k: int) -> np.ndarray:
    if scores.shape != candidates.item_indices.shape or k > scores.shape[1]:
        raise ValueError("reranker scores must align with candidate IDs and cover K")
    rows = np.empty((scores.shape[0], k), dtype=np.int32)
    for row, (items, values) in enumerate(zip(candidates.item_indices, scores, strict=True)):
        order = np.lexsort((items, -values))[:k]
        rows[row] = items[order]
    return rows


def _save_reranker(
    destination: Path,
    model: DinStyleReranker | DcnStyleReranker,
    calibration: TemperatureCalibration,
    *,
    candidate: Mapping[str, Any],
    seed: int,
    prepared: PreparedV3,
    snapshot_sha256: str,
) -> Mapping[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    torch.save({
        "schemaVersion": 1,
        "modelClass": model.__class__.__name__,
        "modelConfig": asdict(model.config),
        "candidateConfig": dict(candidate),
        "calibration": asdict(calibration),
        "calibrationSource": "train_only",
        "seed": seed,
        "configCanonicalSha256": _sha256_bytes(_canonical_json(prepared.config)),
        "splitSha256": prepared.data.split_hash,
        "v2CheckpointSha256": prepared.config["frozenV2"]["checkpointSha256"],
        "retrievalSnapshotSha256": snapshot_sha256,
        "stateDict": model.state_dict(),
    }, temporary)
    os.replace(temporary, destination)
    return _artifact_evidence(destination)


def _load_reranker(
    path: Path,
    *,
    prepared: PreparedV3,
    snapshot_sha256: str,
    candidate: Mapping[str, Any],
    seed: int,
) -> tuple[DinStyleReranker | DcnStyleReranker, TemperatureCalibration]:
    payload = torch.load(path, map_location="cpu", weights_only=False)
    expected = {
        "schemaVersion": 1,
        "modelClass": "DinStyleReranker" if candidate["modelType"] == "din_style" else "DcnStyleReranker",
        "calibrationSource": "train_only",
        "seed": seed,
        "configCanonicalSha256": _sha256_bytes(_canonical_json(prepared.config)),
        "splitSha256": prepared.data.split_hash,
        "v2CheckpointSha256": prepared.config["frozenV2"]["checkpointSha256"],
        "retrievalSnapshotSha256": snapshot_sha256,
    }
    if any(payload.get(key) != value for key, value in expected.items()):
        raise ValueError("reranker checkpoint provenance is invalid")
    if payload.get("candidateConfig") != dict(candidate):
        raise ValueError("reranker checkpoint candidate config changed")
    model = _model(candidate, int(payload["modelConfig"]["vector_dim"]))
    model.load_state_dict(payload["stateDict"], strict=True)
    calibration = TemperatureCalibration(**payload["calibration"])
    return model.eval(), calibration


def _retrieval_batches(
    prepared: PreparedV3,
    snapshot: RetrievalSnapshot,
    queries: SnapshotQueries,
    index: FrozenHnswIndex,
) -> dict[str, CandidateBatch]:
    exclusions = _exclusions(prepared.data, queries.queries, include_target=False)
    k = int(prepared.config["retrieval"]["candidateK"])
    return {
        "exact": exact_topk(
            queries.user_vectors,
            snapshot.item_vectors,
            exclusions,
            k=k,
            batch_size=int(prepared.config["retrieval"]["exactBatchSize"]),
        ),
        "hnsw": index.query(queries.user_vectors, snapshot.item_vectors, exclusions, k=k),
    }


def _paths(prepared: PreparedV3) -> dict[str, Path]:
    artifact_root = _resolve(prepared.root, prepared.config["artifactsDir"])
    return {
        "root": artifact_root,
        "snapshot": artifact_root / "dev-retrieval-snapshot.npz",
        "hnsw": artifact_root / "hnsw-index.bin",
        "selection": artifact_root / "dev-selection.json",
        "receipt": artifact_root / "test-final-receipt.json",
        "testVectors": artifact_root / "test-user-vectors.npz",
        "output": _resolve(prepared.root, prepared.config["output"]),
    }


def _atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def run_dev_selection(config_path: str | Path) -> Mapping[str, Any]:
    prepared = _prepare(Path(config_path))
    paths = _paths(prepared)
    if any(paths[key].exists() for key in ("snapshot", "hnsw", "selection", "receipt", "testVectors", "output")):
        raise FileExistsError("V3 frozen selection/test artifacts cannot be overwritten")
    snapshot_evidence = freeze_dev_retrieval(prepared, paths["snapshot"])
    snapshot = load_retrieval_snapshot(
        paths["snapshot"], expected_sha256=snapshot_evidence["sha256"],
        expected_split_sha256=prepared.data.split_hash,
        expected_checkpoint_sha256=prepared.config["frozenV2"]["checkpointSha256"],
    )
    index = _hnsw(prepared, snapshot.item_vectors, paths["hnsw"], create=True)
    index_evidence = _artifact_evidence(paths["hnsw"])
    retrieval = _retrieval_batches(prepared, snapshot, snapshot.dev, index)
    hnsw_sweep = _hnsw_sweep_report(prepared, snapshot)
    max_k = max(prepared.config["protocol"]["ks"])
    rows: list[Mapping[str, Any]] = []
    trained: dict[str, tuple[DinStyleReranker | DcnStyleReranker, TemperatureCalibration]] = {}
    examples_by_strategy: dict[str, TrainingExamples] = {}
    for candidate in prepared.config["candidateConfigs"]:
        started = time.perf_counter()
        strategy = str(candidate["negativeSampling"])
        if strategy not in examples_by_strategy:
            examples_by_strategy[strategy] = _training_examples(
                prepared,
                snapshot,
                index,
                strategy=strategy,
                seed=int(prepared.config["protocol"]["selectionSeed"]),
            )
        model, calibration, losses = _fit_reranker(
            prepared,
            snapshot,
            examples_by_strategy[strategy],
            candidate,
            seed=int(prepared.config["protocol"]["selectionSeed"]),
        )
        trained[str(candidate["id"])] = (model, calibration)
        candidate_batch = retrieval[candidate["retrievalMode"]]
        scores = _score_candidates(prepared, snapshot, snapshot.dev, candidate_batch, model, calibration)
        reranked = _rerank(candidate_batch, scores, max_k)
        metrics = ranking_metrics(reranked, snapshot.dev.queries.targets, prepared.config["protocol"]["ks"])
        checkpoint_path = paths["root"] / "rerankers" / f"{candidate['id']}-seed-3407.pt"
        checkpoint_evidence = _save_reranker(
            checkpoint_path, model, calibration, candidate=candidate,
            seed=int(prepared.config["protocol"]["selectionSeed"]), prepared=prepared,
            snapshot_sha256=snapshot_evidence["sha256"],
        )
        rows.append({
            "id": candidate["id"], "config": dict(candidate), "epochLosses": losses,
            "trainOnlyCalibration": asdict(calibration), "devMetrics": metrics,
            "selectionValue": metrics["100"]["ndcg"],
            "checkpoint": {"name": checkpoint_path.name, **checkpoint_evidence},
            "elapsedSeconds": time.perf_counter() - started,
        })
    winner = sorted(rows, key=lambda row: (-float(row["selectionValue"]), str(row["id"])))[0]
    winner_model, winner_calibration = trained[str(winner["id"])]
    ablations = _ablation_report(
        prepared,
        snapshot,
        retrieval[winner["config"]["retrievalMode"]],
        winner_model,
        winner_calibration,
        seed=int(prepared.config["protocol"]["selectionSeed"]),
    )
    retrieval_dev_metrics = {
        mode: ranking_metrics(batch.item_indices[:, :max_k], snapshot.dev.queries.targets, prepared.config["protocol"]["ks"])
        for mode, batch in retrieval.items()
    }
    manifest = {
        "schemaVersion": 1,
        "status": "DEV_SELECTION_COMPLETE_TEST_UNSEEN",
        "experimentId": prepared.config["experimentId"],
        "configCanonicalSha256": _sha256_bytes(_canonical_json(prepared.config)),
        "configFileSha256": _file_evidence(prepared.config_path)["sha256"],
        "splitSha256": prepared.data.split_hash,
        "v2": {
            "configSha256": prepared.evidence["v2Config"]["sha256"],
            "resultSha256": prepared.evidence["v2Result"]["sha256"],
            "checkpointSha256": prepared.evidence["v2Checkpoint"]["sha256"],
            "checkpointSeed": prepared.config["frozenV2"]["checkpointSeed"],
            "selectedCandidateId": prepared.config["frozenV2"]["selectedCandidateId"],
        },
        "retrievalSnapshot": snapshot_evidence,
        "hnswIndex": index_evidence,
        "featureContract": {"denseFeatures": DENSE_FEATURE_NAMES, "source": "train_and_public_metadata_only"},
        "negativeSamplingContract": {
            "executedStrategies": sorted(examples_by_strategy),
            "hardSource": "frozen_v2_hnsw_neighbors",
            "uniformSource": "frozen_train_catalog",
            "inBatchSource": "other_positive_targets_with_uniform_fallback_if_needed",
            "perPositive": prepared.config["training"]["hardNegatives"],
            "targetAndHistoryExcluded": True,
        },
        "calibrationContract": {"split": "train_only", "devLabelsUsed": False, "testLabelsUsed": False},
        "retrievalDevMetrics": retrieval_dev_metrics,
        "hnswSweep": hnsw_sweep,
        "devCohorts": {
            mode: _cohort_report(
                prepared,
                snapshot.dev.queries,
                [batch.item_indices[:, :max_k]],
                split="dev",
            )
            for mode, batch in retrieval.items()
        },
        "selectionSeed": prepared.config["protocol"]["selectionSeed"],
        "selectionMetric": prepared.config["protocol"]["selectionMetric"],
        "candidates": rows,
        "selectedCandidateId": winner["id"],
        "selectedConfig": winner["config"],
        "modelComparison": {
            model_type: [row["id"] for row in rows if row["config"]["modelType"] == model_type]
            for model_type in ("din_style", "dcn_style")
        },
        "negativeSamplingComparison": {
            strategy: [row["id"] for row in rows if row["config"]["negativeSampling"] == strategy]
            for strategy in ("hard", "uniform", "in_batch")
        },
        "metadataAblations": ablations,
        "testMetrics": None,
    }
    _atomic_json(paths["selection"], manifest)
    return manifest


def _paired_comparison(
    baseline: np.ndarray,
    treatment: np.ndarray,
    targets: np.ndarray,
    user_ids: Sequence[str],
    ks: Sequence[int],
    *,
    confidence_level: float,
    bootstrap_samples: int,
    bootstrap_seed: int,
) -> Mapping[str, Any]:
    if baseline.shape != treatment.shape or baseline.shape[0] != len(targets) or len(user_ids) != len(targets):
        raise ValueError("paired evaluation requires identical query and ranking shapes")
    output: dict[str, Any] = {}
    for k in ks:
        rows = {}
        for name, ranking in (("baseline", baseline), ("treatment", treatment)):
            hits = ranking[:, :k] == targets[:, None]
            has_hit = hits.any(axis=1)
            rank = np.argmax(hits, axis=1) + 1
            rows[name] = {
                "mrr": np.where(has_hit, 1.0 / rank, 0.0),
                "ndcg": np.where(has_hit, 1.0 / np.log2(rank + 1.0), 0.0),
                "hitRate": has_hit.astype(np.float64),
            }
        output[str(k)] = {}
        for metric in ("mrr", "ndcg", "hitRate"):
            deltas = rows["treatment"][metric] - rows["baseline"][metric]
            output[str(k)][metric] = {
                "meanDelta": float(deltas.mean()),
                "wins": int((deltas > 0).sum()),
                "ties": int((deltas == 0).sum()),
                "losses": int((deltas < 0).sum()),
                "queryCount": int(len(deltas)),
                "confidenceInterval": None,
                "intervalExcludesZero": None,
                "inferenceScope": "descriptive_per_seed",
            }
    return output


def _paired_across_seeds(
    baseline: np.ndarray,
    treatments: Sequence[np.ndarray],
    targets: np.ndarray,
    user_ids: Sequence[str],
    ks: Sequence[int],
    *,
    confidence_level: float,
    bootstrap_samples: int,
    bootstrap_seed: int,
) -> Mapping[str, Any]:
    if not treatments or any(treatment.shape != baseline.shape for treatment in treatments):
        raise ValueError("paired seed aggregation requires aligned rankings")
    output: dict[str, Any] = {}
    for k in ks:
        baseline_hits = baseline[:, :k] == targets[:, None]
        baseline_has_hit = baseline_hits.any(axis=1)
        baseline_rank = np.argmax(baseline_hits, axis=1) + 1
        baseline_metrics = {
            "mrr": np.where(baseline_has_hit, 1.0 / baseline_rank, 0.0),
            "ndcg": np.where(baseline_has_hit, 1.0 / np.log2(baseline_rank + 1.0), 0.0),
            "hitRate": baseline_has_hit.astype(np.float64),
        }
        treatment_metrics: dict[str, list[np.ndarray]] = {"mrr": [], "ndcg": [], "hitRate": []}
        for treatment in treatments:
            hits = treatment[:, :k] == targets[:, None]
            has_hit = hits.any(axis=1)
            rank = np.argmax(hits, axis=1) + 1
            treatment_metrics["mrr"].append(np.where(has_hit, 1.0 / rank, 0.0))
            treatment_metrics["ndcg"].append(np.where(has_hit, 1.0 / np.log2(rank + 1.0), 0.0))
            treatment_metrics["hitRate"].append(has_hit.astype(np.float64))
        output[str(k)] = {}
        for metric in ("mrr", "ndcg", "hitRate"):
            treatment_mean = np.mean(np.stack(treatment_metrics[metric]), axis=0)
            deltas = treatment_mean - baseline_metrics[metric]
            interval = None
            if int(k) == max(int(value) for value in ks) and metric == "ndcg":
                interval = paired_user_bootstrap_ci(
                    dict(zip(user_ids, baseline_metrics[metric], strict=True)),
                    dict(zip(user_ids, treatment_mean, strict=True)),
                    confidence_level=confidence_level,
                    bootstrap_samples=bootstrap_samples,
                    seed=bootstrap_seed,
                )
            output[str(k)][metric] = {
                "meanDelta": float(deltas.mean()),
                "wins": int((deltas > 0).sum()),
                "ties": int((deltas == 0).sum()),
                "losses": int((deltas < 0).sum()),
                "queryCount": int(len(deltas)),
                "seedAggregation": "per_user_mean_before_bootstrap",
                "confidenceInterval": asdict(interval) if interval is not None else None,
                "intervalExcludesZero": interval.excludes_zero if interval is not None else None,
                "inferenceScope": "primary_paired_user_bootstrap" if interval is not None else "descriptive",
            }
    return output


def _test_vectors(prepared: PreparedV3, destination: Path) -> SnapshotQueries:
    if destination.exists():
        raise FileExistsError("V3 test user vectors cannot be overwritten")
    queries = _heldout_queries(prepared.data, "test")
    user_vectors = _query_vectors(prepared, queries)
    _atomic_npz(
        destination,
        schema_version=np.asarray([1], dtype=np.int32),
        split_sha256=np.asarray([prepared.data.split_hash]),
        checkpoint_sha256=np.asarray([prepared.config["frozenV2"]["checkpointSha256"]]),
        **_snapshot_arrays("test", SnapshotQueries(queries, user_vectors), int(prepared.config["training"]["maxHistory"])),
    )
    return SnapshotQueries(queries, user_vectors)


def run_final_test(config_path: str | Path) -> Mapping[str, Any]:
    prepared = _prepare(Path(config_path))
    paths = _paths(prepared)
    if not paths["selection"].is_file():
        raise FileNotFoundError("V3 dev selection must be frozen before test can be opened")
    if paths["receipt"].exists() or paths["testVectors"].exists() or paths["output"].exists():
        raise FileExistsError("the one permitted V3 test phase has already started or completed")
    selection = json.loads(paths["selection"].read_text(encoding="utf-8"))
    if selection.get("status") != "DEV_SELECTION_COMPLETE_TEST_UNSEEN" or selection.get("testMetrics") is not None:
        raise ValueError("V3 selection does not preserve the test-unseen gate")
    if selection.get("configCanonicalSha256") != _sha256_bytes(_canonical_json(prepared.config)):
        raise ValueError("V3 config changed after dev selection")
    if selection.get("configFileSha256") != _file_evidence(prepared.config_path)["sha256"]:
        raise ValueError("V3 config file changed after dev selection")
    if selection.get("splitSha256") != prepared.data.split_hash:
        raise ValueError("Amazon split changed after V3 dev selection")
    if selection.get("v2", {}).get("checkpointSha256") != prepared.config["frozenV2"]["checkpointSha256"]:
        raise ValueError("V2 checkpoint changed after V3 dev selection")
    snapshot_sha256 = selection["retrievalSnapshot"]["sha256"]
    snapshot = load_retrieval_snapshot(
        paths["snapshot"], expected_sha256=snapshot_sha256,
        expected_split_sha256=prepared.data.split_hash,
        expected_checkpoint_sha256=prepared.config["frozenV2"]["checkpointSha256"],
    )
    if _file_evidence(paths["hnsw"])["sha256"] != selection["hnswIndex"]["sha256"]:
        raise ValueError("HNSW artifact changed after V3 dev selection")
    index = _hnsw(prepared, snapshot.item_vectors, paths["hnsw"], create=False)
    test_queries = _test_vectors(prepared, paths["testVectors"])
    test_vector_evidence = _file_evidence(paths["testVectors"])
    test_snapshot = RetrievalSnapshot(snapshot.item_vectors, snapshot.train, test_queries)
    retrieval = _retrieval_batches(prepared, test_snapshot, test_queries, index)
    max_k = max(prepared.config["protocol"]["ks"])
    selected = selection["selectedConfig"]
    per_seed: dict[str, Any] = {}
    reranked_metrics: list[Mapping[str, Mapping[str, float | int]]] = []
    paired_rows: list[Mapping[str, Any]] = []
    reranked_rankings: list[np.ndarray] = []
    user_ids = tuple(prepared.data.users[int(user)] for user in test_queries.queries.user_indices)
    statistics = prepared.config["statistics"]
    for seed in prepared.config["protocol"]["seeds"]:
        started = time.perf_counter()
        examples = _training_examples(
            prepared,
            snapshot,
            index,
            strategy=str(selected["negativeSampling"]),
            seed=int(seed),
        )
        model, calibration, losses = _fit_reranker(prepared, snapshot, examples, selected, seed=int(seed))
        baseline = retrieval[selected["retrievalMode"]]
        scores = _score_candidates(prepared, test_snapshot, test_queries, baseline, model, calibration)
        reranked = _rerank(baseline, scores, max_k)
        metrics = ranking_metrics(reranked, test_queries.queries.targets, prepared.config["protocol"]["ks"])
        paired = _paired_comparison(
            baseline.item_indices[:, :max_k],
            reranked,
            test_queries.queries.targets,
            user_ids,
            prepared.config["protocol"]["ks"],
            confidence_level=float(statistics["confidenceLevel"]),
            bootstrap_samples=int(statistics["bootstrapSamples"]),
            bootstrap_seed=int(statistics["bootstrapSeed"]) + int(seed),
        )
        checkpoint_path = paths["root"] / "rerankers" / f"{selected['id']}-final-seed-{seed}.pt"
        checkpoint_evidence = _save_reranker(
            checkpoint_path, model, calibration, candidate=selected, seed=int(seed), prepared=prepared,
            snapshot_sha256=snapshot_sha256,
        )
        reloaded, reloaded_calibration = _load_reranker(
            checkpoint_path, prepared=prepared, snapshot_sha256=snapshot_sha256, candidate=selected, seed=int(seed)
        )
        if reloaded_calibration != calibration:
            raise ValueError("reranker calibration changed during checkpoint round trip")
        del reloaded
        reranked_metrics.append(metrics)
        paired_rows.append(paired)
        reranked_rankings.append(reranked)
        per_seed[str(seed)] = {
            "epochLosses": losses,
            "trainOnlyCalibration": asdict(calibration),
            "testMetrics": metrics,
            "pairedAgainstSelectedRetrieval": paired,
            "checkpoint": {**checkpoint_evidence, "name": checkpoint_path.name, "roundTripLoaded": True},
            "elapsedSeconds": time.perf_counter() - started,
        }
    retrieval_metrics = {
        mode: ranking_metrics(batch.item_indices[:, :max_k], test_queries.queries.targets, prepared.config["protocol"]["ks"])
        for mode, batch in retrieval.items()
    }
    exact_hnsw_overlap = {}
    for k in prepared.config["protocol"]["ks"]:
        overlaps = [
            len(set(exact[:k].tolist()) & set(ann[:k].tolist())) / k
            for exact, ann in zip(retrieval["exact"].item_indices, retrieval["hnsw"].item_indices, strict=True)
        ]
        exact_hnsw_overlap[str(k)] = float(np.mean(overlaps))
    summary = _metric_summary(reranked_metrics)
    paired_summary: dict[str, Any] = {}
    for k in prepared.config["protocol"]["ks"]:
        paired_summary[str(k)] = {}
        for metric in ("mrr", "ndcg", "hitRate"):
            values = [float(row[str(k)][metric]["meanDelta"]) for row in paired_rows]
            paired_summary[str(k)][metric] = {"mean": float(np.mean(values)), "std": float(np.std(values, ddof=0))}
    selected_baseline = retrieval[selected["retrievalMode"]].item_indices[:, :max_k]
    paired_across_seeds = _paired_across_seeds(
        selected_baseline,
        reranked_rankings,
        test_queries.queries.targets,
        user_ids,
        prepared.config["protocol"]["ks"],
        confidence_level=float(statistics["confidenceLevel"]),
        bootstrap_samples=int(statistics["bootstrapSamples"]),
        bootstrap_seed=int(statistics["bootstrapSeed"]),
    )
    primary = paired_across_seeds["100"]["ndcg"]
    primary_delta = float(primary["meanDelta"])
    cohort_results = {
        "selectedRetrieval": _cohort_report(
            prepared,
            test_queries.queries,
            [selected_baseline],
            split="test",
        ),
        "selectedReranker": _cohort_report(
            prepared,
            test_queries.queries,
            reranked_rankings,
            split="test",
        ),
    }
    result = {
        "schemaVersion": 1,
        "experimentId": prepared.config["experimentId"],
        "status": "COMPLETE",
        "outcome": "POSITIVE_PAIRED_TEST_DELTA" if primary_delta > 0 else "NON_POSITIVE_PAIRED_TEST_DELTA",
        "dataOrigin": "public",
        "claimableOnlinePerformance": False,
        "evidence": {
            "configSha256": _file_evidence(prepared.config_path)["sha256"],
            "configCanonicalSha256": _sha256_bytes(_canonical_json(prepared.config)),
            "splitSha256": prepared.data.split_hash,
            "v2ConfigSha256": prepared.evidence["v2Config"]["sha256"],
            "v2ResultSha256": prepared.evidence["v2Result"]["sha256"],
            "v2CheckpointSha256": prepared.evidence["v2Checkpoint"]["sha256"],
            "retrievalSnapshotSha256": snapshot_sha256,
            "hnswIndexSha256": selection["hnswIndex"]["sha256"],
            "testUserVectorsSha256": test_vector_evidence["sha256"],
            "selectionManifestSha256": _file_evidence(paths["selection"])["sha256"],
        },
        "protocol": {
            "selectionSplit": "dev", "calibrationSplit": "train_only",
            "testOpenedAfterSelectionFrozen": True, "testExecutionCount": 1,
            "testTuningForbidden": True, "pairedEvaluation": True,
            "sameQueriesWithinPair": True, "fullTrainCatalogRetrieval": True,
            "candidateRerankingK": prepared.config["retrieval"]["candidateK"],
            "selectedNegativeSampling": selected["negativeSampling"],
            "selectedModelType": selected["modelType"],
            "seeds": prepared.config["protocol"]["seeds"], "ks": prepared.config["protocol"]["ks"],
            "testEvaluationUsers": len(test_queries.queries.user_indices),
        },
        "selectedCandidate": selected,
        "devSelection": selection,
        "test": {
            "retrieval": retrieval_metrics,
            "exactHnswCandidateOverlap": exact_hnsw_overlap,
            "rerankedPerSeed": per_seed,
            "rerankedSummary": summary,
            "pairedSummary": paired_summary,
            "pairedAcrossSeeds": paired_across_seeds,
            "cohorts": cohort_results,
        },
        "results": {
            "primaryMetric": "paired_ndcg@100_delta",
            "primaryMetricMean": primary_delta,
            "significanceClaimed": False,
            "confidenceInterval": primary["confidenceInterval"],
            "intervalExcludesZero": primary["intervalExcludesZero"],
        },
        "limitations": [
            "Amazon Reviews'23 review/rating interactions are proxies, not impression, click, order, or KAI business labels.",
            "The provider has not assigned a dataset license; raw data, vectors, indexes, and checkpoints remain local research artifacts.",
            "The frozen Metadata Two-Tower checkpoint is reused without fine-tuning; hard negatives come only from its train-query neighbors.",
            "Calibration uses a deterministic train-only partition; dev selects once and test is evaluated once after selection is frozen.",
            "Confidence intervals use a paired percentile bootstrap over users after averaging each user's reranker metric across fixed seeds; no causal or online significance is claimed.",
            "No production, 0066, benchmark, README, or recommendation playground behavior is changed.",
        ],
    }
    _atomic_json(paths["output"], result)
    receipt = {
        "schemaVersion": 1, "status": "TEST_FINAL_EXECUTED_ONCE",
        "resultSha256": _file_evidence(paths["output"])["sha256"],
        "selectedCandidateId": selected["id"], "testSeeds": prepared.config["protocol"]["seeds"],
    }
    _atomic_json(paths["receipt"], receipt)
    return result
