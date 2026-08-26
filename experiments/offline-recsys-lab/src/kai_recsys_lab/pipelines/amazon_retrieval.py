from __future__ import annotations

import hashlib
import json
import math
import os
import random
import tempfile
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import hnswlib
import numpy as np
import pandas as pd
import torch
from torch import Tensor, nn
from torch.nn import functional as F
from scipy.sparse import csr_matrix

from kai_recsys_lab.retrieval.models import TwoTower, TwoTowerConfig
from kai_recsys_lab.sequence.models import DinSequenceScorer, MeanPoolingSequenceScorer


REQUIRED_COLUMNS = ("user_id", "parent_asin", "timestamp", "history")


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _file_evidence(path: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def _seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


@dataclass(frozen=True, slots=True)
class PreparedAmazonData:
    train: pd.DataFrame
    dev: pd.DataFrame
    test: pd.DataFrame
    users: tuple[str, ...]
    catalog: tuple[str, ...]
    user_lookup: Mapping[str, int]
    item_lookup: Mapping[str, int]
    train_items_by_user: tuple[np.ndarray, ...]
    users_by_item: tuple[np.ndarray, ...]
    dev_query_users: np.ndarray
    dev_targets: np.ndarray
    dev_histories: tuple[np.ndarray, ...]
    test_query_users: np.ndarray
    test_targets: np.ndarray
    test_histories: tuple[np.ndarray, ...]
    exclusions: Mapping[str, int]
    timestamp_ties: Mapping[str, int]
    split_hash: str


def load_config(path: str | Path) -> dict[str, Any]:
    config = json.loads(Path(path).read_text(encoding="utf-8"))
    if config.get("dataOrigin") != "public":
        raise ValueError("Amazon public benchmark requires dataOrigin=public")
    seeds = config.get("protocol", {}).get("seeds")
    if seeds != [3407, 6502, 9109]:
        raise ValueError("frozen seed protocol must be [3407, 6502, 9109]")
    ks = config.get("protocol", {}).get("ks")
    if ks != [20, 50, 100]:
        raise ValueError("frozen K protocol must be [20, 50, 100]")
    return config


def _read_split(path: Path) -> pd.DataFrame:
    frame = pd.read_csv(
        path,
        compression="infer",
        usecols=list(REQUIRED_COLUMNS),
        dtype={"user_id": "string", "parent_asin": "string", "history": "string"},
    )
    missing = set(REQUIRED_COLUMNS).difference(frame.columns)
    if missing:
        raise ValueError(f"missing Amazon columns: {sorted(missing)}")
    if frame[["user_id", "parent_asin", "timestamp"]].isna().any().any():
        raise ValueError("user, item, and timestamp must be present")
    frame["history"] = frame["history"].fillna("")
    frame["timestamp"] = pd.to_numeric(frame["timestamp"], errors="raise").astype("int64")
    if (frame["timestamp"] <= 0).any():
        raise ValueError("timestamps must be positive")
    return frame


def _encode_history(history: str, item_lookup: Mapping[str, int]) -> np.ndarray:
    encoded = [item_lookup[item_id] for item_id in history.split() if item_id in item_lookup]
    return np.asarray(encoded, dtype=np.int32)


def _split_digest(frames: Sequence[tuple[str, pd.DataFrame]]) -> str:
    digest = hashlib.sha256()
    for split_name, frame in frames:
        digest.update(split_name.encode("utf-8"))
        for row in frame.itertuples(index=False):
            digest.update(
                f"{row.user_id}\x1f{row.parent_asin}\x1f{int(row.timestamp)}\x1f{row.history}\n".encode("utf-8")
            )
    return digest.hexdigest()


def prepare_amazon_data(raw_dir: str | Path, config: Mapping[str, Any]) -> PreparedAmazonData:
    root = Path(raw_dir)
    file_config = config["dataset"]["files"]
    paths = {split: root / file_config[split]["name"] for split in ("train", "dev", "test")}
    absent = [str(path) for path in paths.values() if not path.is_file()]
    if absent:
        raise FileNotFoundError(f"official Amazon files are missing: {absent}")

    train = _read_split(paths["train"])
    dev = _read_split(paths["dev"])
    test = _read_split(paths["test"])
    if dev["user_id"].duplicated().any() or test["user_id"].duplicated().any():
        raise ValueError("leave-last-out dev/test must contain one row per user")

    train_max = train.groupby("user_id", sort=False)["timestamp"].max()
    dev_time = dev.set_index("user_id")["timestamp"]
    test_time = test.set_index("user_id")["timestamp"]
    common_users = train_max.index.intersection(dev_time.index).intersection(test_time.index)
    if len(common_users) == 0:
        raise ValueError("no users span official train/dev/test")
    if not (train_max.loc[common_users] <= dev_time.loc[common_users]).all():
        raise ValueError("official leave-last-out ordering violated between train and dev")
    if not (dev_time.loc[common_users] <= test_time.loc[common_users]).all():
        raise ValueError("official leave-last-out ordering violated between dev and test")
    timestamp_ties = {
        "trainDevEqualTimestampUsers": int((train_max.loc[common_users] == dev_time.loc[common_users]).sum()),
        "devTestEqualTimestampUsers": int((dev_time.loc[common_users] == test_time.loc[common_users]).sum()),
    }

    users = tuple(sorted(train["user_id"].astype(str).unique().tolist()))
    catalog = tuple(sorted(train["parent_asin"].astype(str).unique().tolist()))
    user_lookup = {user_id: index for index, user_id in enumerate(users)}
    item_lookup = {item_id: index for index, item_id in enumerate(catalog)}

    train_item_sets: list[set[int]] = [set() for _ in users]
    users_by_item_sets: list[set[int]] = [set() for _ in catalog]
    for row in train.itertuples(index=False):
        user_index = user_lookup[str(row.user_id)]
        item_index = item_lookup[str(row.parent_asin)]
        train_item_sets[user_index].add(item_index)
        users_by_item_sets[item_index].add(user_index)
    train_items_by_user = tuple(np.asarray(sorted(items), dtype=np.int32) for items in train_item_sets)
    users_by_item = tuple(np.asarray(sorted(values), dtype=np.int32) for values in users_by_item_sets)

    def queries(frame: pd.DataFrame, split_name: str) -> tuple[np.ndarray, np.ndarray, tuple[np.ndarray, ...], dict[str, int]]:
        cold_users = cold_items = 0
        query_users: list[int] = []
        targets: list[int] = []
        histories: list[np.ndarray] = []
        for row in frame.itertuples(index=False):
            user_index = user_lookup.get(str(row.user_id))
            item_index = item_lookup.get(str(row.parent_asin))
            if user_index is None:
                cold_users += 1
                continue
            if item_index is None:
                cold_items += 1
                continue
            history = _encode_history(str(row.history), item_lookup)
            if item_index in set(history.tolist()):
                raise ValueError(f"{split_name} target leaks into supplied history")
            query_users.append(user_index)
            targets.append(item_index)
            histories.append(history)
        return (
            np.asarray(query_users, dtype=np.int32),
            np.asarray(targets, dtype=np.int32),
            tuple(histories),
            {f"{split_name}ColdUsers": cold_users, f"{split_name}ColdItems": cold_items},
        )

    dev_users, dev_targets, dev_histories, dev_exclusions = queries(dev, "dev")
    test_users, test_targets, test_histories, test_exclusions = queries(test, "test")
    exclusions = {**dev_exclusions, **test_exclusions}
    exclusions["devExcludedTotal"] = len(dev) - len(dev_users)
    exclusions["testExcludedTotal"] = len(test) - len(test_users)

    return PreparedAmazonData(
        train=train,
        dev=dev,
        test=test,
        users=users,
        catalog=catalog,
        user_lookup=user_lookup,
        item_lookup=item_lookup,
        train_items_by_user=train_items_by_user,
        users_by_item=users_by_item,
        dev_query_users=dev_users,
        dev_targets=dev_targets,
        dev_histories=dev_histories,
        test_query_users=test_users,
        test_targets=test_targets,
        test_histories=test_histories,
        exclusions=exclusions,
        timestamp_ties=timestamp_ties,
        split_hash=_split_digest((("train", train), ("dev", dev), ("test", test))),
    )


def ranking_metrics(topk: np.ndarray, targets: np.ndarray, ks: Sequence[int]) -> dict[str, dict[str, float | int]]:
    ranked = np.asarray(topk, dtype=np.int64)
    truth = np.asarray(targets, dtype=np.int64)
    if ranked.ndim != 2 or truth.ndim != 1 or ranked.shape[0] != truth.shape[0] or truth.size == 0:
        raise ValueError("rankings and targets must be non-empty and aligned")
    output: dict[str, dict[str, float | int]] = {}
    for k in ks:
        if k < 1 or k > ranked.shape[1]:
            raise ValueError("K is outside produced ranking width")
        hits = ranked[:, :k].eq(truth[:, None]) if isinstance(ranked, Tensor) else ranked[:, :k] == truth[:, None]
        has_hit = hits.any(axis=1)
        ranks = np.argmax(hits, axis=1) + 1
        reciprocal = np.where(has_hit, 1.0 / ranks, 0.0)
        ndcg = np.where(has_hit, 1.0 / np.log2(ranks + 1.0), 0.0)
        hit_rate = float(np.mean(has_hit))
        output[str(k)] = {
            "recall": hit_rate,
            "hitRate": hit_rate,
            "mrr": float(np.mean(reciprocal)),
            "ndcg": float(np.mean(ndcg)),
            "queryCount": int(truth.size),
        }
    return output


def _fill_topk(
    ordered_scored: Iterable[int],
    *,
    seen: set[int],
    catalog_size: int,
    k: int,
) -> np.ndarray:
    result: list[int] = []
    used: set[int] = set()
    for item_index in ordered_scored:
        if item_index in seen or item_index in used:
            continue
        result.append(item_index)
        used.add(item_index)
        if len(result) == k:
            return np.asarray(result, dtype=np.int32)
    for item_index in range(catalog_size):
        if item_index in seen or item_index in used:
            continue
        result.append(item_index)
        if len(result) == k:
            return np.asarray(result, dtype=np.int32)
    raise ValueError("catalog does not contain K unseen items")


def _deterministic_topk_scores(scores: np.ndarray, k: int) -> np.ndarray:
    """Partial Top-K with a stable lowest-item-index boundary tie break."""

    values = np.asarray(scores)
    if values.ndim != 1 or k < 1 or k > values.size:
        raise ValueError("scores must be one-dimensional and contain K values")
    threshold = np.partition(values, values.size - k)[values.size - k]
    strictly_better = np.flatnonzero(values > threshold)
    tied = np.flatnonzero(values == threshold)
    needed = k - len(strictly_better)
    chosen = np.concatenate((strictly_better, tied[:needed]))
    ordering = np.lexsort((chosen, -values[chosen]))
    return chosen[ordering].astype(np.int32, copy=False)


def popularity_topk(data: PreparedAmazonData, *, k: int, split: str = "test") -> np.ndarray:
    counts = np.zeros(len(data.catalog), dtype=np.int64)
    for items in data.train_items_by_user:
        counts[items] += 1
    popularity_order = np.lexsort((np.arange(len(data.catalog)), -counts))
    query_users = data.test_query_users if split == "test" else data.dev_query_users
    histories = data.test_histories if split == "test" else data.dev_histories
    rows = [
        _fill_topk(
            popularity_order,
            seen=set(data.train_items_by_user[int(user)].tolist()) | set(history.tolist()),
            catalog_size=len(data.catalog),
            k=k,
        )
        for user, history in zip(query_users, histories, strict=True)
    ]
    return np.stack(rows)


def itemknn_topk(
    data: PreparedAmazonData,
    *,
    k: int,
    split: str = "test",
    batch_size: int = 128,
) -> np.ndarray:
    """Sparse on-demand binary cosine ItemKNN over the complete train catalog.

    This avoids materializing the O(items^2) similarity matrix. Each query
    visits users that share a history item and accumulates only non-zero
    co-occurrences; zero-score catalog items are deterministically tie-broken.
    """

    if batch_size < 1:
        raise ValueError("ItemKNN batch_size must be positive")
    interaction_rows: list[int] = []
    interaction_columns: list[int] = []
    for user_index, items in enumerate(data.train_items_by_user):
        interaction_rows.extend([user_index] * len(items))
        interaction_columns.extend(items.tolist())
    interaction = csr_matrix(
        (
            np.ones(len(interaction_rows), dtype=np.float32),
            (np.asarray(interaction_rows), np.asarray(interaction_columns)),
        ),
        shape=(len(data.users), len(data.catalog)),
        dtype=np.float32,
    )
    item_popularity = np.asarray(interaction.sum(axis=0)).ravel().astype(np.float32)
    inverse_norm = np.divide(
        1.0,
        np.sqrt(item_popularity),
        out=np.zeros_like(item_popularity),
        where=item_popularity > 0,
    )
    query_users = data.test_query_users if split == "test" else data.dev_query_users
    histories = data.test_histories if split == "test" else data.dev_histories
    rows: list[np.ndarray] = []
    for offset in range(0, len(query_users), batch_size):
        end = min(offset + batch_size, len(query_users))
        batch_histories: list[np.ndarray] = []
        profile_rows: list[int] = []
        profile_columns: list[int] = []
        for local_row, (user_index, supplied_history) in enumerate(
            zip(query_users[offset:end], histories[offset:end], strict=True)
        ):
            seen_values = np.asarray(
                sorted(set(data.train_items_by_user[int(user_index)].tolist()) | set(supplied_history.tolist())),
                dtype=np.int32,
            )
            batch_histories.append(seen_values)
            profile_rows.extend([local_row] * len(seen_values))
            profile_columns.extend(seen_values.tolist())
        profile = csr_matrix(
            (
                inverse_norm[np.asarray(profile_columns, dtype=np.int32)],
                (np.asarray(profile_rows), np.asarray(profile_columns)),
            ),
            shape=(end - offset, len(data.catalog)),
            dtype=np.float32,
        )
        # H D^-1/2 X^T X D^-1/2, evaluated in bounded batches.
        dense_scores = ((profile @ interaction.T) @ interaction).multiply(inverse_norm).toarray()
        for local_row, seen_values in enumerate(batch_histories):
            dense_scores[local_row, seen_values] = -np.inf
            rows.append(_deterministic_topk_scores(dense_scores[local_row], k))
    return np.stack(rows)


class _BprModule(nn.Module):
    def __init__(self, num_users: int, num_items: int, factors: int) -> None:
        super().__init__()
        self.user = nn.Embedding(num_users, factors)
        self.item = nn.Embedding(num_items, factors)
        nn.init.normal_(self.user.weight, std=0.1)
        nn.init.normal_(self.item.weight, std=0.1)


def _train_pairs(data: PreparedAmazonData) -> tuple[np.ndarray, np.ndarray]:
    users: list[int] = []
    items: list[int] = []
    for row in data.train.itertuples(index=False):
        users.append(data.user_lookup[str(row.user_id)])
        items.append(data.item_lookup[str(row.parent_asin)])
    return np.asarray(users, dtype=np.int64), np.asarray(items, dtype=np.int64)


def _sample_unseen_negatives(data: PreparedAmazonData, user_indices: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    seen_sets = tuple(frozenset(items.tolist()) for items in data.train_items_by_user)
    negatives = rng.integers(0, len(data.catalog), size=user_indices.shape[0], dtype=np.int64)
    invalid = np.fromiter(
        (int(item) in seen_sets[int(user)] for user, item in zip(user_indices, negatives, strict=True)),
        dtype=np.bool_,
        count=user_indices.shape[0],
    )
    while invalid.any():
        negatives[invalid] = rng.integers(0, len(data.catalog), size=int(invalid.sum()), dtype=np.int64)
        bad_rows = np.flatnonzero(invalid)
        invalid[bad_rows] = np.fromiter(
            (
                int(negatives[row]) in seen_sets[int(user_indices[row])]
                for row in bad_rows
            ),
            dtype=np.bool_,
            count=bad_rows.size,
        )
    return negatives


def train_bpr(data: PreparedAmazonData, config: Mapping[str, Any], seed: int) -> _BprModule:
    _seed_everything(seed)
    module = _BprModule(len(data.users), len(data.catalog), int(config["factors"]))
    optimizer = torch.optim.Adam(module.parameters(), lr=float(config["learningRate"]))
    train_users, positives = _train_pairs(data)
    rng = np.random.default_rng(seed)
    batch_size = int(config["batchSize"])
    regularization = float(config["regularization"])
    module.train()
    for _ in range(int(config["epochs"])):
        negatives = _sample_unseen_negatives(data, train_users, rng)
        for row_ids in np.array_split(rng.permutation(len(train_users)), math.ceil(len(train_users) / batch_size)):
            users = torch.from_numpy(train_users[row_ids])
            positive = torch.from_numpy(positives[row_ids])
            negative = torch.from_numpy(negatives[row_ids])
            user_vectors = module.user(users)
            positive_vectors = module.item(positive)
            negative_vectors = module.item(negative)
            margin = (user_vectors * (positive_vectors - negative_vectors)).sum(dim=1)
            penalty = regularization * (
                user_vectors.square().mean() + positive_vectors.square().mean() + negative_vectors.square().mean()
            )
            loss = F.softplus(-margin).mean() + penalty
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
    return module.eval()


def _batched_dot_topk(
    user_vectors: np.ndarray,
    item_vectors: np.ndarray,
    histories: Sequence[np.ndarray],
    *,
    k: int,
    batch_size: int = 256,
) -> np.ndarray:
    if user_vectors.shape[0] != len(histories):
        raise ValueError("one exclusion history is required for every query")
    output = np.empty((len(histories), k), dtype=np.int32)
    for offset in range(0, len(histories), batch_size):
        end = min(offset + batch_size, len(histories))
        scores = user_vectors[offset:end] @ item_vectors.T
        for local_row, history in enumerate(histories[offset:end]):
            scores[local_row, history] = -np.inf
            output[offset + local_row] = _deterministic_topk_scores(scores[local_row], k)
    return output


def bpr_topk(
    module: _BprModule,
    data: PreparedAmazonData,
    *,
    k: int,
    split: str = "test",
) -> np.ndarray:
    query_users = data.test_query_users if split == "test" else data.dev_query_users
    histories = data.test_histories if split == "test" else data.dev_histories
    exclusions = tuple(
        np.asarray(sorted(set(data.train_items_by_user[int(user)].tolist()) | set(history.tolist())), dtype=np.int32)
        for user, history in zip(query_users, histories, strict=True)
    )
    with torch.no_grad():
        user_vectors = module.user(torch.from_numpy(query_users.astype(np.int64))).numpy()
        item_vectors = module.item.weight.numpy()
    return _batched_dot_topk(user_vectors, item_vectors, exclusions, k=k)


def _history_matrix(histories: Sequence[np.ndarray], *, max_history: int) -> np.ndarray:
    matrix = np.zeros((len(histories), max_history), dtype=np.int64)
    for row, history in enumerate(histories):
        values = history[-max_history:]
        if values.size:
            matrix[row, -len(values) :] = values.astype(np.int64) + 2
    return matrix


def train_two_tower_public(data: PreparedAmazonData, config: Mapping[str, Any], seed: int) -> TwoTower:
    _seed_everything(seed)
    model = TwoTower(
        TwoTowerConfig(
            num_users=len(data.users) + 2,
            num_items=len(data.catalog) + 2,
            embedding_dim=int(config["embeddingDim"]),
            hidden_dim=int(config["hiddenDim"]),
            output_dim=int(config["outputDim"]),
            temperature=float(config["temperature"]),
        )
    )
    train_users, positives = _train_pairs(data)
    train_histories = tuple(
        _encode_history(str(row.history), data.item_lookup) for row in data.train.itertuples(index=False)
    )
    history_matrix = _history_matrix(train_histories, max_history=int(config["maxHistory"]))
    users_tensor = torch.from_numpy(train_users + 2)
    positives_tensor = torch.from_numpy(positives + 2)
    histories_tensor = torch.from_numpy(history_matrix)
    optimizer = torch.optim.Adam(model.parameters(), lr=float(config["learningRate"]))
    rng = np.random.default_rng(seed)
    batch_size = int(config["batchSize"])
    model.train()
    for _ in range(int(config["epochs"])):
        for row_ids in np.array_split(rng.permutation(len(train_users)), math.ceil(len(train_users) / batch_size)):
            rows = torch.from_numpy(row_ids)
            user_vectors, item_vectors = model(users_tensor[rows], positives_tensor[rows], histories_tensor[rows])
            logits = user_vectors @ item_vectors.T / model.config.temperature
            item_ids = positives_tensor[rows]
            positive_mask = item_ids[:, None].eq(item_ids[None, :])
            positive_logits = logits.masked_fill(~positive_mask, float("-inf"))
            loss = (torch.logsumexp(logits, dim=1) - torch.logsumexp(positive_logits, dim=1)).mean()
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
    return model.eval()


def two_tower_vectors(
    model: TwoTower,
    data: PreparedAmazonData,
    config: Mapping[str, Any],
    *,
    split: str = "test",
) -> tuple[np.ndarray, np.ndarray, tuple[np.ndarray, ...]]:
    query_users = data.test_query_users if split == "test" else data.dev_query_users
    histories = data.test_histories if split == "test" else data.dev_histories
    exclusions = tuple(
        np.asarray(sorted(set(data.train_items_by_user[int(user)].tolist()) | set(history.tolist())), dtype=np.int32)
        for user, history in zip(query_users, histories, strict=True)
    )
    history_matrix = _history_matrix(histories, max_history=int(config["maxHistory"]))
    with torch.no_grad():
        user_vectors = model.encode_users(
            torch.from_numpy(query_users.astype(np.int64) + 2), torch.from_numpy(history_matrix)
        ).numpy()
        item_vectors = model.encode_items(torch.arange(2, len(data.catalog) + 2)).numpy()
    return user_vectors, item_vectors, exclusions


def benchmark_hnsw(
    user_vectors: np.ndarray,
    item_vectors: np.ndarray,
    exclusions: Sequence[np.ndarray],
    exact_topk: np.ndarray,
    ann_config: Mapping[str, Any],
    *,
    seed: int,
    artifact_dir: Path,
) -> dict[str, Any]:
    index = hnswlib.Index(space="ip", dim=item_vectors.shape[1])
    index.init_index(
        max_elements=item_vectors.shape[0],
        ef_construction=int(ann_config["efConstruction"]),
        M=int(ann_config["m"]),
        random_seed=seed,
    )
    index.add_items(item_vectors.astype(np.float32), np.arange(item_vectors.shape[0]), num_threads=1)
    index.set_ef(int(ann_config["efSearch"]))
    artifact_dir.mkdir(parents=True, exist_ok=True)
    index_path = artifact_dir / f"hnsw-seed-{seed}.bin"
    index.save_index(str(index_path))

    max_k = exact_topk.shape[1]
    latencies: list[float] = []
    ann_rows = np.empty_like(exact_topk)
    started_all = time.perf_counter_ns()
    for row, (query, history) in enumerate(zip(user_vectors, exclusions, strict=True)):
        search_k = min(item_vectors.shape[0], max_k + len(history))
        started = time.perf_counter_ns()
        labels, _ = index.knn_query(query[None, :].astype(np.float32), k=search_k, num_threads=1)
        filtered = [int(item) for item in labels[0] if int(item) not in set(history.tolist())][:max_k]
        elapsed = (time.perf_counter_ns() - started) / 1_000_000.0
        if len(filtered) < max_k:
            raise RuntimeError("ANN query did not produce enough non-history candidates")
        ann_rows[row] = filtered
        latencies.append(elapsed)
    elapsed_seconds = (time.perf_counter_ns() - started_all) / 1_000_000_000.0
    latency_array = np.asarray(latencies, dtype=np.float64)

    recall: dict[str, float] = {}
    for k in ann_config["benchmarkKs"]:
        overlap = [
            len(set(ann[:k].tolist()) & set(exact[:k].tolist())) / k
            for ann, exact in zip(ann_rows, exact_topk, strict=True)
        ]
        recall[str(k)] = float(np.mean(overlap))
    return {
        "annRecall": recall,
        "p50LatencyMs": float(np.percentile(latency_array, 50)),
        "p95LatencyMs": float(np.percentile(latency_array, 95)),
        "meanLatencyMs": float(np.mean(latency_array)),
        "qps": float(len(user_vectors) / elapsed_seconds),
        "queryCount": len(user_vectors),
        "indexBytes": index_path.stat().st_size,
        "indexSha256": _file_evidence(index_path)["sha256"],
    }


def _metric_summary(seed_metrics: Sequence[Mapping[str, Mapping[str, float | int]]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for k in seed_metrics[0]:
        result[k] = {}
        for metric in ("recall", "hitRate", "mrr", "ndcg"):
            values = np.asarray([float(seed[k][metric]) for seed in seed_metrics], dtype=np.float64)
            result[k][metric] = {"mean": float(values.mean()), "std": float(values.std(ddof=0))}
        result[k]["queryCount"] = int(seed_metrics[0][k]["queryCount"])
    return result


def _ann_summary(per_seed: Mapping[str, Mapping[str, Any]], ks: Sequence[int]) -> dict[str, Any]:
    summary: dict[str, Any] = {"annRecall": {}}
    for k in ks:
        values = np.asarray([float(row["ann"]["annRecall"][str(k)]) for row in per_seed.values()])
        summary["annRecall"][str(k)] = {"mean": float(values.mean()), "std": float(values.std(ddof=0))}
    for field in ("p50LatencyMs", "p95LatencyMs", "meanLatencyMs", "qps", "indexBytes"):
        values = np.asarray([float(row["ann"][field]) for row in per_seed.values()])
        summary[field] = {"mean": float(values.mean()), "std": float(values.std(ddof=0))}
    return summary


def _paired_metric_delta(
    left: Sequence[Mapping[str, Mapping[str, float | int]]],
    right: Sequence[Mapping[str, Mapping[str, float | int]]],
) -> dict[str, Any]:
    if len(left) != len(right) or not left:
        raise ValueError("paired metric summaries require equal non-empty seed rows")
    result: dict[str, Any] = {}
    for k in left[0]:
        result[k] = {}
        for metric in ("recall", "hitRate", "mrr", "ndcg"):
            values = np.asarray(
                [float(left_row[k][metric]) - float(right_row[k][metric]) for left_row, right_row in zip(left, right, strict=True)]
            )
            result[k][metric] = {"mean": float(values.mean()), "std": float(values.std(ddof=0))}
    return result


def build_evidence_header(config: Mapping[str, Any], config_path: Path, data: PreparedAmazonData) -> dict[str, Any]:
    raw_dir = Path(config["dataset"]["rawDir"])
    files = {
        split: _file_evidence(raw_dir / config["dataset"]["files"][split]["name"])
        for split in ("train", "dev", "test")
    }
    return {
        "schemaVersion": 1,
        "experimentId": config["experimentId"],
        "status": "PARTIAL",
        "dataOrigin": "public",
        "claimableOnlinePerformance": False,
        "source": {
            "id": "mcauley-lab-amazon-reviews-2023",
            "name": config["dataset"]["name"],
            "category": config["dataset"]["category"],
            "officialUrl": config["dataset"]["officialDocumentationUrl"],
            "terms": "license not assigned by provider; isolated non-commercial research only; no raw-data redistribution",
            "termsEvidenceUrl": config["dataset"]["officialTermsEvidenceUrl"],
            "licenseStatus": config["dataset"]["licenseStatus"],
            "interactionMeaning": config["dataset"]["interactionMeaning"],
        },
        "evidence": {
            "datasetFiles": [
                {
                    "split": split,
                    "name": Path(files[split]["path"]).name,
                    "sha256": files[split]["sha256"],
                    "bytes": files[split]["bytes"],
                }
                for split in ("train", "dev", "test")
            ],
            "configSha256": _sha256_bytes(config_path.read_bytes()),
            "configCanonicalSha256": _sha256_bytes(_canonical_json(config)),
            "splitSha256": data.split_hash,
        },
        "protocol": {
            "seeds": config["protocol"]["seeds"],
            "sameUsersAcrossModels": True,
            "sameItemsAcrossModels": True,
            "sameTemporalSplitAcrossModels": True,
            "fullTrainCatalogEvaluation": True,
            "sampledNegativeEvaluation": False,
            "excludeSeen": True,
            "ks": config["protocol"]["ks"],
            "counts": {
                "trainRows": len(data.train),
                "devRows": len(data.dev),
                "testRows": len(data.test),
                "trainUsers": len(data.users),
                "trainCatalogItems": len(data.catalog),
                "devEvaluationUsers": len(data.dev_query_users),
                "testEvaluationUsers": len(data.test_query_users),
                **data.exclusions,
                **data.timestamp_ties,
            },
        },
        "results": {},
        "limitations": [
            "The provider has not assigned a dataset license; this run is isolated research-only use.",
            "A review/rating is an interaction proxy, not an impression, click, order, or verified business event.",
            "The train catalog contains tens of thousands of items, so this run does not support a million-item claim.",
            "Cold targets absent from the train catalog are excluded once before evaluation and counted explicitly.",
            "One official user has equal dev/test timestamps; the provider's published split membership is authoritative for that tie.",
            "Offline public-data metrics are not evidence of KAI Compute or online performance.",
        ],
    }


def run_retrieval_benchmark(config_path: str | Path, *, phase: str = "all") -> dict[str, Any]:
    path = Path(config_path)
    config = load_config(path)
    data = prepare_amazon_data(config["dataset"]["rawDir"], config)
    result = build_evidence_header(config, path, data)
    if phase == "audit":
        result["status"] = "NOT_RUN"
        result["results"] = {
            "retrieval": {"status": "NOT_RUN", "reason": "audit-only phase; no models were fitted or scored"}
        }
        return result

    ks = config["protocol"]["ks"]
    max_k = max(ks)
    targets = data.test_targets
    metrics_by_model: dict[str, Any] = {}

    started = time.perf_counter()
    popularity = popularity_topk(data, k=max_k)
    popularity_metrics = ranking_metrics(popularity, targets, ks)
    metrics_by_model["popularity"] = {
        "perSeed": {str(seed): popularity_metrics for seed in config["protocol"]["seeds"]},
        "summary": _metric_summary([popularity_metrics] * len(config["protocol"]["seeds"])),
        "elapsedSeconds": time.perf_counter() - started,
    }

    started = time.perf_counter()
    itemknn = itemknn_topk(data, k=max_k, batch_size=int(config["itemKnn"]["batchSize"]))
    itemknn_metrics = ranking_metrics(itemknn, targets, ks)
    metrics_by_model["itemKnn"] = {
        "perSeed": {str(seed): itemknn_metrics for seed in config["protocol"]["seeds"]},
        "summary": _metric_summary([itemknn_metrics] * len(config["protocol"]["seeds"])),
        "elapsedSeconds": time.perf_counter() - started,
        "implementation": "sparse on-demand binary-cosine co-occurrence; no dense item-item matrix",
    }

    if phase == "classical":
        result["results"] = {
            "models": metrics_by_model,
            "sequence": {"status": "NOT_RUN", "reason": "retrieval baseline stability gate"},
        }
        result["status"] = "PARTIAL"
        return result

    bpr_seed_metrics: list[Mapping[str, Mapping[str, float | int]]] = []
    bpr_per_seed: dict[str, Any] = {}
    for seed in config["protocol"]["seeds"]:
        started = time.perf_counter()
        bpr_model = train_bpr(data, config["bpr"], seed)
        bpr_rows = bpr_topk(bpr_model, data, k=max_k)
        seed_metrics = ranking_metrics(bpr_rows, targets, ks)
        bpr_seed_metrics.append(seed_metrics)
        bpr_per_seed[str(seed)] = {"metrics": seed_metrics, "elapsedSeconds": time.perf_counter() - started}
    metrics_by_model["bprMf"] = {"perSeed": bpr_per_seed, "summary": _metric_summary(bpr_seed_metrics)}

    two_tower_seed_metrics: list[Mapping[str, Mapping[str, float | int]]] = []
    two_tower_per_seed: dict[str, Any] = {}
    artifact_dir = Path(config["output"]).parent
    for seed in config["protocol"]["seeds"]:
        started = time.perf_counter()
        model = train_two_tower_public(data, config["twoTower"], seed)
        user_vectors, item_vectors, exclusions = two_tower_vectors(model, data, config["twoTower"])
        exact_rows = _batched_dot_topk(user_vectors, item_vectors, exclusions, k=max_k)
        exact_metrics = ranking_metrics(exact_rows, targets, ks)
        ann = benchmark_hnsw(
            user_vectors,
            item_vectors,
            exclusions,
            exact_rows,
            config["ann"],
            seed=seed,
            artifact_dir=artifact_dir,
        )
        two_tower_seed_metrics.append(exact_metrics)
        two_tower_per_seed[str(seed)] = {
            "exactMetrics": exact_metrics,
            "ann": ann,
            "elapsedSeconds": time.perf_counter() - started,
        }
    metrics_by_model["twoTower"] = {
        "perSeed": two_tower_per_seed,
        "exactSummary": _metric_summary(two_tower_seed_metrics),
        "annSummary": _ann_summary(two_tower_per_seed, config["ann"]["benchmarkKs"]),
    }

    result["results"] = {
        "models": metrics_by_model,
        "sequence": {
            "status": "NOT_RUN",
            "gate": config["sequence"]["status"],
            "reason": "Mean-pooling vs DIN begins only after this retrieval protocol is frozen and reviewed.",
            "publicMetrics": None,
        },
    }
    result["status"] = "COMPLETE"
    return result


def _sequence_training_arrays(
    data: PreparedAmazonData,
    *,
    max_history: int,
    seed: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    users: list[int] = []
    positives: list[int] = []
    histories: list[np.ndarray] = []
    for row in data.train.itertuples(index=False):
        history = _encode_history(str(row.history), data.item_lookup)
        if history.size == 0:
            continue
        users.append(data.user_lookup[str(row.user_id)])
        positives.append(data.item_lookup[str(row.parent_asin)])
        histories.append(history)
    user_array = np.asarray(users, dtype=np.int64)
    positive_array = np.asarray(positives, dtype=np.int64)
    negative_array = _sample_unseen_negatives(data, user_array, np.random.default_rng(seed))
    return user_array, positive_array, negative_array, _history_matrix(histories, max_history=max_history)


def _train_sequence_model(
    model: MeanPoolingSequenceScorer | DinSequenceScorer,
    histories: np.ndarray,
    positives: np.ndarray,
    negatives: np.ndarray,
    config: Mapping[str, Any],
    *,
    seed: int,
    device: torch.device,
) -> MeanPoolingSequenceScorer | DinSequenceScorer:
    _seed_everything(seed)
    model.to(device)
    model.train()
    optimizer = torch.optim.Adam(model.parameters(), lr=float(config["learningRate"]))
    rng = np.random.default_rng(seed)
    batch_size = int(config["batchSize"])
    for _ in range(int(config["epochs"])):
        permutation = rng.permutation(len(positives))
        for row_ids in np.array_split(permutation, math.ceil(len(permutation) / batch_size)):
            history = torch.from_numpy(histories[row_ids]).to(device)
            positive = torch.from_numpy(positives[row_ids] + 2).to(device)
            negative = torch.from_numpy(negatives[row_ids] + 2).to(device)
            candidates = torch.cat((positive, negative))
            repeated_history = torch.cat((history, history))
            labels = torch.cat(
                (
                    torch.ones(len(row_ids), dtype=torch.float32, device=device),
                    torch.zeros(len(row_ids), dtype=torch.float32, device=device),
                )
            )
            logits = model(repeated_history, candidates).logits
            loss = F.binary_cross_entropy_with_logits(logits, labels)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
    return model.eval()


def _sequence_rerank_topk(
    model: MeanPoolingSequenceScorer | DinSequenceScorer,
    histories: Sequence[np.ndarray],
    candidates: np.ndarray,
    config: Mapping[str, Any],
    *,
    device: torch.device,
) -> np.ndarray:
    if candidates.ndim != 2 or candidates.shape[0] != len(histories):
        raise ValueError("sequence candidates and histories must align")
    max_history = int(config["maxHistory"])
    query_batch_size = int(config["evaluationQueryBatchSize"])
    history_matrix = _history_matrix(histories, max_history=max_history)
    output = np.empty_like(candidates)
    model.eval()
    with torch.no_grad():
        for offset in range(0, len(histories), query_batch_size):
            end = min(offset + query_batch_size, len(histories))
            candidate_batch = candidates[offset:end]
            candidate_count = candidate_batch.shape[1]
            history = torch.from_numpy(history_matrix[offset:end]).to(device)
            expanded_history = history.repeat_interleave(candidate_count, dim=0)
            candidate_tensor = torch.from_numpy(candidate_batch.astype(np.int64).reshape(-1) + 2).to(device)
            scores = model(expanded_history, candidate_tensor).logits.reshape(end - offset, candidate_count)
            score_rows = scores.detach().cpu().numpy()
            for local_row in range(end - offset):
                items = candidate_batch[local_row]
                ordering = np.lexsort((items, -score_rows[local_row]))
                output[offset + local_row] = items[ordering]
    return output


def run_sequence_benchmark(config_path: str | Path) -> dict[str, Any]:
    path = Path(config_path)
    config = load_config(path)
    data = prepare_amazon_data(config["dataset"]["rawDir"], config)
    result = build_evidence_header(config, path, data)
    result["limitations"] = [
        *result["limitations"],
        "Sequence models rerank a frozen ItemKNN Top-100 and cannot recover a target absent from that candidate set.",
        "The target is never injected into a candidate set; end-to-end metrics retain retrieval misses.",
        "Mean pooling and DIN use the same positives, per-seed negatives, histories, candidates, optimizer settings, and evaluation users.",
    ]
    model_config = config["model"]
    candidate_count = int(config["protocol"]["candidateCount"])
    ks = config["protocol"]["ks"]
    if candidate_count != max(ks):
        raise ValueError("sequence candidateCount must equal the largest evaluation K")

    dev_candidates = itemknn_topk(
        data,
        k=candidate_count,
        split="dev",
        batch_size=int(config["itemKnn"]["batchSize"]),
    )
    test_candidates = itemknn_topk(
        data,
        k=candidate_count,
        split="test",
        batch_size=int(config["itemKnn"]["batchSize"]),
    )
    candidate_metrics = {
        "dev": ranking_metrics(dev_candidates, data.dev_targets, ks),
        "test": ranking_metrics(test_candidates, data.test_targets, ks),
    }
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    per_model_seed_metrics: dict[str, list[Mapping[str, Mapping[str, float | int]]]] = {
        "meanPooling": [],
        "din": [],
    }
    per_model: dict[str, dict[str, Any]] = {"meanPooling": {}, "din": {}}

    for seed in config["protocol"]["seeds"]:
        _, positives, negatives, train_histories = _sequence_training_arrays(
            data,
            max_history=int(model_config["maxHistory"]),
            seed=seed,
        )
        model_factories = {
            "meanPooling": lambda: MeanPoolingSequenceScorer(
                len(data.catalog) + 2,
                int(model_config["embeddingDim"]),
                int(model_config["hiddenDim"]),
            ),
            "din": lambda: DinSequenceScorer(
                len(data.catalog) + 2,
                int(model_config["embeddingDim"]),
                int(model_config["hiddenDim"]),
                int(model_config["attentionDim"]),
            ),
        }
        for model_name, factory in model_factories.items():
            started = time.perf_counter()
            _seed_everything(seed)
            model = _train_sequence_model(
                factory(),
                train_histories,
                positives,
                negatives,
                model_config,
                seed=seed,
                device=device,
            )
            dev_rows = _sequence_rerank_topk(
                model,
                data.dev_histories,
                dev_candidates,
                model_config,
                device=device,
            )
            test_rows = _sequence_rerank_topk(
                model,
                data.test_histories,
                test_candidates,
                model_config,
                device=device,
            )
            dev_metrics = ranking_metrics(dev_rows, data.dev_targets, ks)
            test_metrics = ranking_metrics(test_rows, data.test_targets, ks)
            per_model_seed_metrics[model_name].append(test_metrics)
            per_model[model_name][str(seed)] = {
                "devMetrics": dev_metrics,
                "testMetrics": test_metrics,
                "elapsedSeconds": time.perf_counter() - started,
            }
            model.to("cpu")
            del model
            if device.type == "mps":
                torch.mps.empty_cache()

    result["protocol"]["candidateGenerator"] = config["protocol"]["candidateGenerator"]
    result["protocol"]["candidateCount"] = candidate_count
    result["protocol"]["sameCandidateSetAcrossSequenceModels"] = True
    result["protocol"]["sameNegativesWithinSeed"] = True
    result["protocol"]["trainingRowsWithNonEmptyHistory"] = int(len(train_histories))
    result["results"] = {
        "candidateGeneration": {
            "name": "itemKnn",
            "targetInjected": False,
            "metrics": candidate_metrics,
        },
        "models": {
            model_name: {
                "perSeed": per_model[model_name],
                "testSummary": _metric_summary(per_model_seed_metrics[model_name]),
            }
            for model_name in ("meanPooling", "din")
        },
        "comparison": {
            "contrast": "din_minus_mean_pooling_paired_by_seed",
            "delta": _paired_metric_delta(
                per_model_seed_metrics["din"],
                per_model_seed_metrics["meanPooling"],
            ),
            "outcome": "NO_STABLE_DIN_IMPROVEMENT_ON_FROZEN_PROTOCOL",
        },
        "trainingDevice": device.type,
    }
    result["status"] = "COMPLETE"
    return result


def write_result(result: Mapping[str, Any], output_path: str | Path) -> None:
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, destination)
