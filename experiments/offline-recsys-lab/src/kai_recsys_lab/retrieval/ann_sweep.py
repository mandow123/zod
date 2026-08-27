from __future__ import annotations

import math
import tempfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Sequence

import numpy as np

from kai_recsys_lab.retrieval.ann import HnswAnnIndex, benchmark_ann


@dataclass(frozen=True, slots=True)
class HnswSweepConfig:
    ef_construction: int
    m: int
    ef_search: int

    def __post_init__(self) -> None:
        for name, value in (
            ("ef_construction", self.ef_construction),
            ("m", self.m),
            ("ef_search", self.ef_search),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be a positive integer")


@dataclass(frozen=True, slots=True)
class HnswSweepPoint:
    ef_construction: int
    m: int
    ef_search: int
    k: int
    recall_at_k: float
    mean_latency_ms: float
    p50_latency_ms: float
    p95_latency_ms: float
    index_size_bytes: int
    query_count: int
    pareto_optimal: bool = False

    def __post_init__(self) -> None:
        integers = (
            self.ef_construction,
            self.m,
            self.ef_search,
            self.k,
            self.index_size_bytes,
            self.query_count,
        )
        if any(isinstance(value, bool) or not isinstance(value, int) or value < 1 for value in integers):
            raise ValueError("HNSW sweep dimensions and counts must be positive")
        if not math.isfinite(self.recall_at_k) or not 0.0 <= self.recall_at_k <= 1.0:
            raise ValueError("recall_at_k must be finite and in [0, 1]")
        latencies = (self.mean_latency_ms, self.p50_latency_ms, self.p95_latency_ms)
        if any(not math.isfinite(value) or value < 0.0 for value in latencies):
            raise ValueError("HNSW latencies must be finite and non-negative")
        if self.p95_latency_ms < self.p50_latency_ms:
            raise ValueError("p95_latency_ms must not be below p50_latency_ms")
        if not isinstance(self.pareto_optimal, bool):
            raise ValueError("pareto_optimal must be boolean")


@dataclass(frozen=True, slots=True)
class HnswSweepResult:
    dimension: int
    item_count: int
    query_count: int
    k: int
    seed: int
    points: tuple[HnswSweepPoint, ...]
    pareto_latency_metric: str = "p95_latency_ms"

    def __post_init__(self) -> None:
        shape = (self.dimension, self.item_count, self.query_count, self.k)
        if any(isinstance(value, bool) or not isinstance(value, int) or value < 1 for value in shape):
            raise ValueError("HNSW sweep shape values must be positive")
        if isinstance(self.seed, bool) or not isinstance(self.seed, int) or self.seed < 0:
            raise ValueError("seed must be a non-negative integer")
        if not self.points:
            raise ValueError("HNSW sweep requires at least one point")
        if any(not isinstance(point, HnswSweepPoint) for point in self.points):
            raise ValueError("points must contain HnswSweepPoint values")
        if self.pareto_latency_metric != "p95_latency_ms":
            raise ValueError("the V1 Pareto latency metric is p95_latency_ms")
        keys = [(point.ef_construction, point.m, point.ef_search) for point in self.points]
        if len(set(keys)) != len(keys):
            raise ValueError("HNSW sweep configurations must be unique")
        for point in self.points:
            if point.k != self.k or point.query_count != self.query_count:
                raise ValueError("all HNSW points must share k and query_count")
        expected_markers = tuple(point.pareto_optimal for point in mark_pareto_optimal(self.points))
        actual_markers = tuple(point.pareto_optimal for point in self.points)
        if actual_markers != expected_markers:
            raise ValueError("HNSW sweep points must contain correct Pareto markers")


def mark_pareto_optimal(points: Sequence[HnswSweepPoint]) -> tuple[HnswSweepPoint, ...]:
    """Mark non-dominated recall/p95-latency/index-size configurations.

    Recall is maximized; p95 query latency and serialized index bytes are
    minimized.  Exact ties remain on the frontier.
    """

    if not points:
        raise ValueError("at least one HNSW sweep point is required")
    marked: list[HnswSweepPoint] = []
    for point in points:
        dominated = any(
            other is not point
            and other.recall_at_k >= point.recall_at_k
            and other.p95_latency_ms <= point.p95_latency_ms
            and other.index_size_bytes <= point.index_size_bytes
            and (
                other.recall_at_k > point.recall_at_k
                or other.p95_latency_ms < point.p95_latency_ms
                or other.index_size_bytes < point.index_size_bytes
            )
            for other in points
        )
        marked.append(replace(point, pareto_optimal=not dominated))
    return tuple(marked)


def _serialized_index_size(index: HnswAnnIndex, path: Path) -> int:
    # HnswAnnIndex intentionally exposes only fit/query today.  The underlying
    # hnswlib save method is used solely to measure the actual persisted index,
    # not an in-memory estimate.  Keep this compatibility check fail-closed.
    native_index = getattr(index, "_index", None)
    save_index = getattr(native_index, "save_index", None)
    if not callable(save_index):
        raise RuntimeError("the configured HNSW backend cannot serialize its index")
    save_index(str(path))
    size = path.stat().st_size
    if size < 1:
        raise RuntimeError("serialized HNSW index is empty")
    return size


def run_hnsw_sweep(
    item_indices: np.ndarray,
    item_vectors: np.ndarray,
    query_vectors: np.ndarray,
    exact_topk_item_indices: np.ndarray,
    *,
    configs: Sequence[HnswSweepConfig],
    k: int,
    warmup_queries: int = 1,
    seed: int = 20260827,
    work_directory: Path | None = None,
) -> HnswSweepResult:
    """Run an explicit HNSW parameter sweep without asserting a winner."""

    items = np.asarray(item_vectors, dtype=np.float32)
    item_ids = np.asarray(item_indices, dtype=np.int64)
    queries = np.asarray(query_vectors, dtype=np.float32)
    exact = np.asarray(exact_topk_item_indices, dtype=np.int64)
    configs = tuple(configs)
    if items.ndim != 2 or items.shape[0] == 0:
        raise ValueError("item_vectors must be a non-empty rank-two matrix")
    if item_ids.ndim != 1 or item_ids.shape[0] != items.shape[0]:
        raise ValueError("item_indices must align with item_vectors")
    if queries.ndim != 2 or queries.shape[0] == 0 or queries.shape[1] != items.shape[1]:
        raise ValueError("query_vectors must be non-empty and match item dimension")
    if isinstance(k, bool) or not isinstance(k, int) or k < 1 or k > items.shape[0]:
        raise ValueError("k must be between one and the item count")
    if exact.ndim != 2 or exact.shape[0] != queries.shape[0] or exact.shape[1] < k:
        raise ValueError("exact_topk_item_indices must align with queries and contain k neighbors")
    if isinstance(warmup_queries, bool) or not isinstance(warmup_queries, int) or warmup_queries < 0:
        raise ValueError("warmup_queries must be a non-negative integer")
    if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
        raise ValueError("seed must be a non-negative integer")
    if not configs:
        raise ValueError("at least one HNSW configuration is required")
    if any(not isinstance(config, HnswSweepConfig) for config in configs):
        raise ValueError("configs must contain HnswSweepConfig values")
    config_keys = [(config.ef_construction, config.m, config.ef_search) for config in configs]
    if len(set(config_keys)) != len(config_keys):
        raise ValueError("HNSW sweep configurations must be unique")
    if work_directory is not None and not work_directory.is_dir():
        raise ValueError("work_directory must be an existing directory")

    points: list[HnswSweepPoint] = []
    with tempfile.TemporaryDirectory(dir=work_directory) as temporary:
        root = Path(temporary)
        for ordinal, config in enumerate(configs):
            index = HnswAnnIndex(
                items.shape[1],
                max_elements=items.shape[0],
                ef_construction=config.ef_construction,
                m=config.m,
                ef_search=config.ef_search,
                seed=seed,
            ).fit(item_ids, items)
            benchmark = benchmark_ann(
                index,
                queries,
                exact,
                k=k,
                warmup_queries=warmup_queries,
            )
            index_size = _serialized_index_size(index, root / f"hnsw-{ordinal}.bin")
            points.append(
                HnswSweepPoint(
                    ef_construction=config.ef_construction,
                    m=config.m,
                    ef_search=config.ef_search,
                    k=benchmark.k,
                    recall_at_k=benchmark.recall_at_k,
                    mean_latency_ms=benchmark.mean_latency_ms,
                    p50_latency_ms=benchmark.p50_latency_ms,
                    p95_latency_ms=benchmark.p95_latency_ms,
                    index_size_bytes=index_size,
                    query_count=benchmark.query_count,
                )
            )

    return HnswSweepResult(
        dimension=items.shape[1],
        item_count=items.shape[0],
        query_count=queries.shape[0],
        k=k,
        seed=seed,
        points=mark_pareto_optimal(points),
    )
