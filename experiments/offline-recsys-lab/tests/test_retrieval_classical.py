from __future__ import annotations

import unittest

from kai_recsys_lab.contracts import DataOrigin, RetrievalExample, Split
from kai_recsys_lab.retrieval import BprConfig, BprMatrixFactorization, ItemKnnRecommender


def _example(user: str, item: str, timestamp: int, split: Split = Split.TRAIN) -> RetrievalExample:
    return RetrievalExample(user, item, timestamp, split, DataOrigin.SYNTHETIC)


class ItemKnnTest(unittest.TestCase):
    def test_implicit_cosine_cooccurrence_and_seen_exclusion(self) -> None:
        examples = [
            _example("u1", "a", 1),
            _example("u1", "b", 2),
            _example("u2", "a", 3),
            _example("u2", "b", 4),
            _example("u2", "c", 5),
            _example("u3", "a", 6),
            _example("u3", "c", 7),
            _example("u1", "test-only", 8, Split.TEST),
        ]
        model = ItemKnnRecommender().fit(examples)

        self.assertEqual(model.catalog, ("a", "b", "c"))
        self.assertGreater(model.similarity("a", "c"), 0.0)
        self.assertEqual([row.item_id for row in model.recommend("u1", 3)], ["c"])

    def test_unknown_user_has_deterministic_zero_score_order(self) -> None:
        model = ItemKnnRecommender().fit([_example("u1", "b", 1), _example("u2", "a", 2)])
        recommendations = model.recommend("unknown", 2)
        self.assertEqual([(row.item_id, row.score) for row in recommendations], [("a", 0.0), ("b", 0.0)])


class BprMatrixFactorizationTest(unittest.TestCase):
    @staticmethod
    def _training_data() -> list[RetrievalExample]:
        return [
            _example("u1", "a", 1),
            _example("u1", "b", 2),
            _example("u2", "a", 3),
            _example("u2", "b", 4),
            _example("u3", "c", 5),
            _example("u3", "d", 6),
            _example("u4", "c", 7),
            _example("u4", "d", 8),
            _example("u1", "test-only", 9, Split.TEST),
        ]

    def test_bpr_is_fixed_seed_train_only_and_excludes_seen(self) -> None:
        config = BprConfig(factors=8, epochs=80, learning_rate=0.05, regularization=1e-4, seed=17)
        first = BprMatrixFactorization(config).fit(self._training_data())
        second = BprMatrixFactorization(config).fit(self._training_data())

        self.assertEqual(first.catalog, ("a", "b", "c", "d"))
        self.assertEqual(first.recommend("u1", 4), second.recommend("u1", 4))
        self.assertEqual({row.item_id for row in first.recommend("u1", 4)}, {"c", "d"})
        self.assertGreater(first.score("u1", "a"), first.score("u1", "c"))

    def test_unknown_user_falls_back_to_deterministic_catalog_order(self) -> None:
        model = BprMatrixFactorization(BprConfig(factors=4, epochs=2, seed=2)).fit(self._training_data())
        rows = model.recommend("unknown", 2)
        self.assertEqual([(row.item_id, row.score) for row in rows], [("a", 0.0), ("b", 0.0)])


if __name__ == "__main__":
    unittest.main()
