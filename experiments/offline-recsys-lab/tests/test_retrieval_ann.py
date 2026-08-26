from __future__ import annotations

import unittest

import numpy as np

from kai_recsys_lab.retrieval.ann import HnswAnnIndex, benchmark_ann, hnswlib


@unittest.skipIf(hnswlib is None, "hnswlib dependency is not installed")
class HnswAnnTest(unittest.TestCase):
    def test_ann_quality_and_latency_are_measured_against_exact_topk(self) -> None:
        rng = np.random.default_rng(20260826)
        items = rng.normal(size=(64, 8)).astype(np.float32)
        items /= np.linalg.norm(items, axis=1, keepdims=True)
        item_ids = np.arange(100, 164, dtype=np.int64)
        queries = items[[3, 17, 42]]
        exact_positions = np.argsort(-(queries @ items.T), axis=1)[:, :5]
        exact_ids = item_ids[exact_positions]

        index = HnswAnnIndex(8, max_elements=64, ef_construction=100, m=16, ef_search=64).fit(item_ids, items)
        result = benchmark_ann(index, queries, exact_ids, k=5)

        self.assertEqual(result.query_count, 3)
        self.assertGreaterEqual(result.recall_at_k, 0.99)
        self.assertGreaterEqual(result.mean_latency_ms, 0.0)
        self.assertGreaterEqual(result.p95_latency_ms, result.p50_latency_ms)


if __name__ == "__main__":
    unittest.main()
