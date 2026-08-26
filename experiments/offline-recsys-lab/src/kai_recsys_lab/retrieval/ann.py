from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np

try:
    import hnswlib
except ImportError:  # pragma: no cover - exercised only in dependency-broken environments
    hnswlib = None  # type: ignore[assignment]


@dataclass(frozen=True, slots=True)
class AnnBenchmark:
    k: int
    recall_at_k: float
    mean_latency_ms: float
    p50_latency_ms: float
    p95_latency_ms: float
    query_count: int


class HnswAnnIndex:
    """Thin, deterministic hnswlib inner-product index wrapper."""

    def __init__(
        self,
        dimension: int,
        *,
        max_elements: int,
        ef_construction: int = 100,
        m: int = 16,
        ef_search: int = 50,
        seed: int = 20260826,
    ) -> None:
        if hnswlib is None:
            raise RuntimeError("hnswlib is required for ANN evaluation")
        if min(dimension, max_elements, ef_construction, m, ef_search) < 1:
            raise ValueError("HNSW parameters must be positive")
        self._index = hnswlib.Index(space="ip", dim=dimension)
        self._index.init_index(
            max_elements=max_elements,
            ef_construction=ef_construction,
            M=m,
            random_seed=seed,
        )
        self._index.set_ef(ef_search)
        self._max_elements = max_elements
        self._count = 0

    def fit(self, item_indices: np.ndarray, item_vectors: np.ndarray) -> HnswAnnIndex:
        if self._count:
            raise RuntimeError("an HNSW wrapper instance can only be fitted once")
        item_indices = np.asarray(item_indices, dtype=np.int64)
        item_vectors = np.asarray(item_vectors, dtype=np.float32)
        if item_indices.ndim != 1 or item_vectors.ndim != 2 or item_indices.shape[0] != item_vectors.shape[0]:
            raise ValueError("item indices and vectors must align")
        if item_indices.shape[0] == 0 or item_indices.shape[0] > self._max_elements:
            raise ValueError("item count must be within configured max_elements")
        if len(np.unique(item_indices)) != item_indices.shape[0]:
            raise ValueError("item indices must be unique")
        self._index.add_items(item_vectors, item_indices, num_threads=1)
        self._count = item_indices.shape[0]
        return self

    def query(self, query_vectors: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
        vectors = np.asarray(query_vectors, dtype=np.float32)
        if vectors.ndim != 2:
            raise ValueError("query vectors must be rank two")
        if self._count == 0:
            raise RuntimeError("fit must be called before query")
        if k < 1 or k > self._count:
            raise ValueError("k must be between one and the indexed item count")
        labels, distances = self._index.knn_query(vectors, k=k, num_threads=1)
        return labels.astype(np.int64, copy=False), (1.0 - distances).astype(np.float32, copy=False)


def benchmark_ann(
    index: HnswAnnIndex,
    query_vectors: np.ndarray,
    exact_topk_item_indices: np.ndarray,
    *,
    k: int,
    warmup_queries: int = 1,
) -> AnnBenchmark:
    queries = np.asarray(query_vectors, dtype=np.float32)
    exact = np.asarray(exact_topk_item_indices, dtype=np.int64)
    if queries.ndim != 2 or exact.ndim != 2 or queries.shape[0] != exact.shape[0]:
        raise ValueError("queries and exact results must align")
    if queries.shape[0] == 0 or exact.shape[1] < k or k < 1 or warmup_queries < 0:
        raise ValueError("benchmark requires non-empty queries and k exact neighbors")

    for row in range(min(warmup_queries, queries.shape[0])):
        index.query(queries[row : row + 1], k)

    latencies: list[float] = []
    ann_rows: list[np.ndarray] = []
    for row in range(queries.shape[0]):
        started = time.perf_counter_ns()
        labels, _ = index.query(queries[row : row + 1], k)
        latencies.append((time.perf_counter_ns() - started) / 1_000_000.0)
        ann_rows.append(labels[0])

    recalls = [
        len(set(ann.tolist()) & set(exact_row[:k].tolist())) / k
        for ann, exact_row in zip(ann_rows, exact, strict=True)
    ]
    values = np.asarray(latencies, dtype=np.float64)
    return AnnBenchmark(
        k=k,
        recall_at_k=float(np.mean(recalls)),
        mean_latency_ms=float(np.mean(values)),
        p50_latency_ms=float(np.percentile(values, 50)),
        p95_latency_ms=float(np.percentile(values, 95)),
        query_count=queries.shape[0],
    )
