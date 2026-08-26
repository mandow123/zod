from __future__ import annotations

import unittest

from kai_recsys_lab.ads import (
    AdsCandidate,
    RankingObjective,
    evaluate_ads_ranking,
    rank_candidates,
    score_candidate,
)


def synthetic_candidates() -> list[AdsCandidate]:
    return [
        AdsCandidate("a", pctr=0.9, post_click_cvr=0.1, conversion_value=10, bid=2, quality=1),
        AdsCandidate("b", pctr=0.5, post_click_cvr=0.8, conversion_value=1, bid=1, quality=1),
        AdsCandidate("c", pctr=0.2, post_click_cvr=0.9, conversion_value=10, bid=10, quality=0.4),
    ]


class AdsRankingTest(unittest.TestCase):
    def test_each_objective_has_a_deterministic_formula(self) -> None:
        candidates = synthetic_candidates()
        self.assertEqual(rank_candidates(candidates, RankingObjective.CTR_ONLY), ("a", "b", "c"))
        self.assertEqual(rank_candidates(candidates, RankingObjective.POST_CLICK_CVR_ONLY), ("c", "b", "a"))
        self.assertIs(RankingObjective.CVR_ONLY, RankingObjective.POST_CLICK_CVR_ONLY)
        self.assertEqual(rank_candidates(candidates, RankingObjective.CTR_X_CVR), ("b", "c", "a"))
        self.assertEqual(rank_candidates(candidates, RankingObjective.VALUE_AWARE), ("a", "c", "b"))
        self.assertEqual(rank_candidates(candidates, RankingObjective.ECPM), ("a", "c", "b"))
        self.assertAlmostEqual(score_candidate(candidates[0], RankingObjective.ECPM), 1_800.0)

    def test_expected_conversion_value_and_ndcg(self) -> None:
        candidates = synthetic_candidates()
        ranking = rank_candidates(candidates, RankingObjective.CTR_ONLY)
        metrics = evaluate_ads_ranking(candidates, ranking, {"a": 3, "b": 2, "c": 1}, k=2)
        self.assertAlmostEqual(metrics.expected_conversions, 0.49)
        self.assertAlmostEqual(metrics.expected_value, 1.3)
        self.assertAlmostEqual(metrics.ndcg, 1.0)

    def test_invalid_predictions_and_evaluation_identity_fail_closed(self) -> None:
        with self.assertRaises(ValueError):
            AdsCandidate("bad", pctr=1.1, post_click_cvr=0.2)
        candidates = synthetic_candidates()
        with self.assertRaises(ValueError):
            evaluate_ads_ranking(candidates, ["a", "a"], {"a": 3, "b": 2, "c": 1}, k=2)
        with self.assertRaises(ValueError):
            evaluate_ads_ranking(candidates, ["a"], {"a": 3}, k=1)


if __name__ == "__main__":
    unittest.main()
