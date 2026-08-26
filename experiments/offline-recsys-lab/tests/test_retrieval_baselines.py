from __future__ import annotations

import unittest

from kai_recsys_lab.contracts import DataOrigin, RetrievalExample, Split
from kai_recsys_lab.retrieval import IdVocabulary, PopularityRecommender, evaluate_rankings


def _example(user: str, item: str, timestamp: int, split: Split = Split.TRAIN) -> RetrievalExample:
    return RetrievalExample(user, item, timestamp, split, DataOrigin.SYNTHETIC)


class PopularityBaselineTest(unittest.TestCase):
    def test_vocabulary_is_sorted_and_reserves_padding(self) -> None:
        vocabulary = IdVocabulary.build(["z", "a", "z", "<PAD>"])
        self.assertEqual(vocabulary.ids, ("<PAD>", "<UNK>", "a", "z"))
        self.assertEqual(vocabulary.encode(["a", "missing"]), (2, 1))

    def test_train_only_popularity_is_deterministic_and_excludes_seen(self) -> None:
        examples = [
            _example("u1", "popular", 1),
            _example("u2", "popular", 2),
            _example("u1", "alpha", 3),
            _example("u3", "beta", 4),
            _example("u1", "leaked-test-item", 5, Split.TEST),
        ]
        model = PopularityRecommender().fit(examples)

        self.assertEqual(model.catalog, ("popular", "alpha", "beta"))
        self.assertEqual([row.item_id for row in model.recommend("new-user", 3)], ["popular", "alpha", "beta"])
        self.assertEqual([row.item_id for row in model.recommend("u1", 3)], ["beta"])

    def test_binary_relevance_metrics(self) -> None:
        metrics = evaluate_rankings(
            {"u1": ["a", "b", "c"], "u2": ["x", "d", "e"]},
            {"u1": {"b", "c"}, "u2": {"x"}},
            [1, 3],
        )
        self.assertEqual(metrics[0].query_count, 2)
        self.assertAlmostEqual(metrics[0].recall, 0.5)
        self.assertAlmostEqual(metrics[0].hit_rate, 0.5)
        self.assertAlmostEqual(metrics[0].mrr, 0.5)
        self.assertAlmostEqual(metrics[1].recall, 1.0)
        self.assertAlmostEqual(metrics[1].hit_rate, 1.0)


if __name__ == "__main__":
    unittest.main()
