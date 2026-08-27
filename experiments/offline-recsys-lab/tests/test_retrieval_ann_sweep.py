from __future__ import annotations

import numpy as np
import pytest

from kai_recsys_lab.retrieval.ann import hnswlib
from kai_recsys_lab.retrieval.ann_sweep import (
    HnswSweepConfig,
    HnswSweepPoint,
    mark_pareto_optimal,
    run_hnsw_sweep,
)


def _point(recall: float, latency: float, size: int, ef_search: int) -> HnswSweepPoint:
    return HnswSweepPoint(
        ef_construction=100,
        m=16,
        ef_search=ef_search,
        k=10,
        recall_at_k=recall,
        mean_latency_ms=latency * 0.8,
        p50_latency_ms=latency * 0.7,
        p95_latency_ms=latency,
        index_size_bytes=size,
        query_count=50,
    )


def test_pareto_marks_recall_latency_and_index_size_tradeoffs() -> None:
    frontier = mark_pareto_optimal(
        (
            _point(0.90, 5.0, 100, 20),
            _point(0.80, 6.0, 110, 30),
            _point(0.95, 8.0, 90, 40),
            _point(0.90, 4.0, 120, 50),
        )
    )

    assert [point.pareto_optimal for point in frontier] == [True, False, True, True]


def test_sweep_config_rejects_invalid_or_duplicate_parameters() -> None:
    with pytest.raises(ValueError, match="positive integer"):
        HnswSweepConfig(ef_construction=0, m=16, ef_search=20)


@pytest.mark.skipif(hnswlib is None, reason="hnswlib dependency is not installed")
def test_hnsw_sweep_reports_measured_quality_latency_size_and_pareto() -> None:
    rng = np.random.default_rng(20260827)
    items = rng.normal(size=(64, 8)).astype(np.float32)
    items /= np.linalg.norm(items, axis=1, keepdims=True)
    item_ids = np.arange(100, 164, dtype=np.int64)
    queries = items[[3, 17, 42, 55]]
    exact_positions = np.argsort(-(queries @ items.T), axis=1)[:, :5]
    exact_ids = item_ids[exact_positions]

    result = run_hnsw_sweep(
        item_ids,
        items,
        queries,
        exact_ids,
        configs=(
            HnswSweepConfig(ef_construction=50, m=8, ef_search=10),
            HnswSweepConfig(ef_construction=100, m=16, ef_search=64),
        ),
        k=5,
        seed=3407,
    )

    assert result.dimension == 8
    assert result.item_count == 64
    assert result.query_count == 4
    assert result.pareto_latency_metric == "p95_latency_ms"
    assert len(result.points) == 2
    assert all(0.0 <= point.recall_at_k <= 1.0 for point in result.points)
    assert all(point.p95_latency_ms >= 0.0 for point in result.points)
    assert all(point.index_size_bytes > 0 for point in result.points)
    assert any(point.pareto_optimal for point in result.points)
