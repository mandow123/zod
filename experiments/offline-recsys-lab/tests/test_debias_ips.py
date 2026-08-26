from __future__ import annotations

import unittest

from kai_recsys_lab.debias import PositionAsFeatureBaseline, inverse_propensity_estimate


class InversePropensityTest(unittest.TestCase):
    def test_ips_snips_and_effective_sample_size_match_hand_calculation(self) -> None:
        estimate = inverse_propensity_estimate([1, 0], [0.5, 0.25])
        self.assertAlmostEqual(estimate.ips, 1.0)
        self.assertAlmostEqual(estimate.snips, 1 / 3)
        self.assertAlmostEqual(estimate.effective_sample_size, 1.8)
        self.assertAlmostEqual(estimate.max_weight, 4.0)
        self.assertEqual(estimate.clipped_count, 0)

    def test_clipping_is_explicit_and_reported(self) -> None:
        estimate = inverse_propensity_estimate([1, 0], [0.5, 0.25], min_propensity=0.5)
        self.assertAlmostEqual(estimate.ips, 1.0)
        self.assertAlmostEqual(estimate.snips, 0.5)
        self.assertAlmostEqual(estimate.effective_sample_size, 2.0)
        self.assertEqual(estimate.clipped_count, 1)
        self.assertEqual(estimate.clipping_floor, 0.5)

    def test_invalid_propensity_fails_closed(self) -> None:
        for invalid in (0.0, -0.1, 1.1, float("nan"), float("inf")):
            with self.subTest(propensity=invalid), self.assertRaises(ValueError):
                inverse_propensity_estimate([1], [invalid])
        with self.assertRaises(ValueError):
            inverse_propensity_estimate([1], [0.5], min_propensity=0.0)

    def test_position_as_feature_is_declared_naive_not_debiasing(self) -> None:
        baseline = PositionAsFeatureBaseline()
        self.assertEqual(baseline.methodology, "naive_associational_baseline")
        self.assertFalse(baseline.is_debiasing)


if __name__ == "__main__":
    unittest.main()
