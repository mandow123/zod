from __future__ import annotations

import math
import unittest

from kai_recsys_lab.evaluation import (
    average_precision,
    binary_classification_metrics,
    constraint_violation_rate,
    graded_ndcg_at_k,
    mean_retrieval_metrics_at_k,
    post_click_cvr,
    pr_auc,
    retrieval_metrics_at_k,
    roc_auc,
)


class RetrievalMetricsTest(unittest.TestCase):
    def test_retrieval_metrics_match_hand_calculation(self) -> None:
        metrics = retrieval_metrics_at_k(["a", "b", "c", "d"], {"b", "d"}, 3)
        expected_ndcg = (1 / math.log2(3)) / (1 + 1 / math.log2(3))
        self.assertAlmostEqual(metrics.recall, 0.5)
        self.assertAlmostEqual(metrics.hit_rate, 1.0)
        self.assertAlmostEqual(metrics.mrr, 0.5)
        self.assertAlmostEqual(metrics.ndcg, expected_ndcg)

    def test_macro_average_and_query_parity(self) -> None:
        metrics = mean_retrieval_metrics_at_k(
            {"q1": ["a", "b"], "q2": ["z", "y"]},
            {"q1": {"a"}, "q2": {"x"}},
            1,
        )
        self.assertEqual(metrics.recall, 0.5)
        self.assertEqual(metrics.hit_rate, 0.5)
        self.assertEqual(metrics.mrr, 0.5)
        self.assertEqual(metrics.ndcg, 0.5)

    def test_duplicate_ids_and_missing_positives_fail_closed(self) -> None:
        with self.assertRaises(ValueError):
            retrieval_metrics_at_k(["a", "a"], {"a"}, 2)
        with self.assertRaises(ValueError):
            retrieval_metrics_at_k(["a"], set(), 1)

    def test_graded_ndcg_uses_full_label_set_for_ideal_order(self) -> None:
        self.assertAlmostEqual(graded_ndcg_at_k(["a", "b"], {"a": 3, "b": 1}, 2), 1.0)
        self.assertLess(graded_ndcg_at_k(["b", "a"], {"a": 3, "b": 1}, 2), 1.0)


class BinaryMetricsTest(unittest.TestCase):
    def test_auc_logloss_brier_and_ece(self) -> None:
        labels = [0, 0, 1, 1]
        probabilities = [0.1, 0.4, 0.35, 0.8]
        metrics = binary_classification_metrics(labels, probabilities, ece_bin_count=2)
        self.assertAlmostEqual(metrics.auc, 0.75)
        self.assertAlmostEqual(metrics.average_precision, 5 / 6)
        self.assertAlmostEqual(metrics.pr_auc, metrics.average_precision)
        self.assertAlmostEqual(
            metrics.log_loss,
            -sum(math.log(value) for value in [0.9, 0.6, 0.35, 0.8]) / 4,
        )
        self.assertAlmostEqual(metrics.brier, sum((p - y) ** 2 for p, y in zip(probabilities, labels)) / 4)
        self.assertAlmostEqual(metrics.ece, 0.0875)

    def test_auc_requires_both_classes_and_probabilities_fail_closed(self) -> None:
        with self.assertRaises(ValueError):
            roc_auc([1, 1], [0.1, 0.2])
        with self.assertRaises(ValueError):
            roc_auc([0, 1], [0.1, float("nan")])

    def test_average_precision_handles_ties_and_requires_a_positive(self) -> None:
        self.assertAlmostEqual(average_precision([1, 0], [0.5, 0.5]), 0.5)
        self.assertAlmostEqual(pr_auc([1, 0], [0.5, 0.5]), 0.5)
        with self.assertRaises(ValueError):
            average_precision([0, 0], [0.2, 0.1])

    def test_constraint_violation_rate_is_not_post_click_cvr(self) -> None:
        self.assertAlmostEqual(constraint_violation_rate([0, 1, 0, 1]), 0.5)
        self.assertAlmostEqual(post_click_cvr([1, 1, 0, 1], [0, 1, 0, 1]), 2 / 3)
        with self.assertRaises(ValueError):
            post_click_cvr([0, 1], [1, 0])


if __name__ == "__main__":
    unittest.main()
