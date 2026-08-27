from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import hnswlib
import numpy as np


@dataclass(frozen=True, slots=True)
class CandidateBatch:
    item_indices: np.ndarray
    scores: np.ndarray


def _validated_vectors(user_vectors: np.ndarray, item_vectors: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    users = np.asarray(user_vectors, dtype=np.float32)
    items = np.asarray(item_vectors, dtype=np.float32)
    if users.ndim != 2 or items.ndim != 2 or users.shape[1] != items.shape[1]:
        raise ValueError("user and item vectors must be aligned rank-two matrices")
    if users.shape[0] == 0 or items.shape[0] == 0 or not np.isfinite(users).all() or not np.isfinite(items).all():
        raise ValueError("candidate retrieval requires non-empty finite vectors")
    return users, items


def _validated_exclusions(
    exclusions: Sequence[np.ndarray],
    *,
    query_count: int,
    item_count: int,
) -> tuple[np.ndarray, ...]:
    if len(exclusions) != query_count:
        raise ValueError("one exclusion row is required for every query")
    rows: list[np.ndarray] = []
    for raw in exclusions:
        row = np.unique(np.asarray(raw, dtype=np.int64))
        if row.ndim != 1 or ((row < 0) | (row >= item_count)).any():
            raise ValueError("exclusion item indices are outside the frozen catalog")
        rows.append(row)
    return tuple(rows)


def _deterministic_topk(scores: np.ndarray, k: int) -> np.ndarray:
    if scores.ndim != 1 or k < 1 or k > scores.size:
        raise ValueError("scores must be one-dimensional and contain K values")
    threshold = np.partition(scores, scores.size - k)[scores.size - k]
    better = np.flatnonzero(scores > threshold)
    tied = np.flatnonzero(scores == threshold)
    selected = np.concatenate((better, tied[: k - len(better)]))
    order = np.lexsort((selected, -scores[selected]))
    return selected[order].astype(np.int32, copy=False)


def exact_topk(
    user_vectors: np.ndarray,
    item_vectors: np.ndarray,
    exclusions: Sequence[np.ndarray],
    *,
    k: int,
    batch_size: int = 256,
) -> CandidateBatch:
    users, items = _validated_vectors(user_vectors, item_vectors)
    excluded = _validated_exclusions(exclusions, query_count=len(users), item_count=len(items))
    if batch_size < 1 or k < 1:
        raise ValueError("K and batch size must be positive")
    if any(len(row) + k > len(items) for row in excluded):
        raise ValueError("frozen catalog does not contain K eligible candidates")
    indices = np.empty((len(users), k), dtype=np.int32)
    top_scores = np.empty((len(users), k), dtype=np.float32)
    for offset in range(0, len(users), batch_size):
        end = min(offset + batch_size, len(users))
        scores = users[offset:end] @ items.T
        for local_row, row_exclusions in enumerate(excluded[offset:end]):
            row_scores = scores[local_row]
            row_scores[row_exclusions] = -np.inf
            selected = _deterministic_topk(row_scores, k)
            indices[offset + local_row] = selected
            top_scores[offset + local_row] = row_scores[selected]
    return CandidateBatch(indices, top_scores)


class FrozenHnswIndex:
    """Deterministic inner-product HNSW over an immutable item-vector matrix."""

    def __init__(
        self,
        *,
        dimension: int,
        item_count: int,
        ef_construction: int,
        m: int,
        ef_search: int,
        seed: int,
    ) -> None:
        if min(dimension, item_count, ef_construction, m, ef_search) < 1:
            raise ValueError("HNSW parameters must be positive")
        self.dimension = int(dimension)
        self.item_count = int(item_count)
        self.ef_search = int(ef_search)
        self._index = hnswlib.Index(space="ip", dim=self.dimension)
        self._index.init_index(
            max_elements=self.item_count,
            ef_construction=int(ef_construction),
            M=int(m),
            random_seed=int(seed),
        )
        self._fitted = False

    def fit(self, item_vectors: np.ndarray) -> FrozenHnswIndex:
        if self._fitted:
            raise RuntimeError("frozen HNSW index can only be fitted once")
        items = np.asarray(item_vectors, dtype=np.float32)
        if items.shape != (self.item_count, self.dimension) or not np.isfinite(items).all():
            raise ValueError("item vectors do not match the frozen HNSW contract")
        self._index.add_items(items, np.arange(self.item_count), num_threads=1)
        self._index.set_ef(self.ef_search)
        self._fitted = True
        return self

    @classmethod
    def load(
        cls,
        source: str | Path,
        *,
        dimension: int,
        item_count: int,
        ef_search: int,
    ) -> FrozenHnswIndex:
        path = Path(source)
        if not path.is_file() or min(dimension, item_count, ef_search) < 1:
            raise ValueError("a valid frozen HNSW artifact and positive dimensions are required")
        instance = cls.__new__(cls)
        instance.dimension = int(dimension)
        instance.item_count = int(item_count)
        instance.ef_search = int(ef_search)
        instance._index = hnswlib.Index(space="ip", dim=instance.dimension)
        instance._index.load_index(str(path), max_elements=instance.item_count)
        if instance._index.get_current_count() != instance.item_count:
            raise ValueError("HNSW artifact item count does not match the frozen catalog")
        instance._index.set_ef(instance.ef_search)
        instance._fitted = True
        return instance

    def save(self, destination: str | Path) -> None:
        if not self._fitted:
            raise RuntimeError("fit must complete before an HNSW index can be saved")
        Path(destination).parent.mkdir(parents=True, exist_ok=True)
        self._index.save_index(str(destination))

    def query(
        self,
        user_vectors: np.ndarray,
        item_vectors: np.ndarray,
        exclusions: Sequence[np.ndarray],
        *,
        k: int,
    ) -> CandidateBatch:
        if not self._fitted:
            raise RuntimeError("fit must complete before HNSW queries")
        users, items = _validated_vectors(user_vectors, item_vectors)
        if items.shape != (self.item_count, self.dimension):
            raise ValueError("query item vectors differ from the indexed frozen catalog")
        excluded = _validated_exclusions(exclusions, query_count=len(users), item_count=len(items))
        if k < 1 or any(len(row) + k > self.item_count for row in excluded):
            raise ValueError("frozen catalog does not contain K eligible HNSW candidates")
        indices = np.empty((len(users), k), dtype=np.int32)
        scores = np.empty((len(users), k), dtype=np.float32)
        for row, (query, row_exclusions) in enumerate(zip(users, excluded, strict=True)):
            search_k = min(self.item_count, k + len(row_exclusions))
            labels, _ = self._index.knn_query(query[None, :], k=search_k, num_threads=1)
            exclusion_set = set(row_exclusions.tolist())
            eligible = np.asarray([int(item) for item in labels[0] if int(item) not in exclusion_set], dtype=np.int32)
            if len(eligible) < k:
                raise RuntimeError("HNSW did not return K eligible frozen candidates")
            eligible_scores = items[eligible] @ query
            order = np.lexsort((eligible, -eligible_scores))[:k]
            indices[row] = eligible[order]
            scores[row] = eligible_scores[order]
        return CandidateBatch(indices, scores)
