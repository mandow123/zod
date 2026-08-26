from __future__ import annotations

import unittest
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

from kai_recsys_lab.pipelines.position_bias import (
    _model_protocols,
    calibration_by_position,
    importance_weights,
    policy_value_estimates,
    position_standardized_ctr,
    temporal_split,
    stream_full_policy_test_partition,
    validate_logged_frame,
    weighted_log_loss,
)


def fixture_frame(rows: int = 30) -> pd.DataFrame:
    positions = np.resize(np.asarray([1, 2, 3]), rows)
    return pd.DataFrame(
        {
            "source_row_id": np.arange(rows),
            "timestamp": pd.date_range("2026-01-01", periods=rows, freq="min", tz="UTC"),
            "item_id": np.arange(rows) % 4,
            "position": positions,
            "click": (np.arange(rows) % 7 == 0).astype(int),
            "propensity_score": np.resize(np.asarray([0.5, 0.25, 0.125]), rows),
            "user_feature_0": "a",
            "user_feature_1": "b",
            "user_feature_2": "c",
            "user_feature_3": "d",
        }
    )


class PositionBiasPipelineTest(unittest.TestCase):
    def test_propensity_validation_fails_closed(self) -> None:
        frame = fixture_frame()
        validate_logged_frame(frame, action_count=4)
        for invalid in (0.0, -0.1, 1.1, float("nan"), float("inf")):
            corrupted = frame.copy()
            corrupted.loc[0, "propensity_score"] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                validate_logged_frame(corrupted, action_count=4)

    def test_temporal_split_is_stable_disjoint_and_nonempty(self) -> None:
        frame = fixture_frame().sample(frac=1, random_state=7)
        split = temporal_split(frame, train_fraction=0.6, dev_fraction=0.2)
        self.assertEqual({name: len(value) for name, value in split.items()}, {"train": 18, "dev": 6, "test": 6})
        row_sets = [set(partition.source_row_id) for partition in split.values()]
        self.assertFalse(row_sets[0] & row_sets[1])
        self.assertFalse(row_sets[0] & row_sets[2])
        self.assertFalse(row_sets[1] & row_sets[2])
        self.assertLess(split["train"].timestamp.max(), split["dev"].timestamp.min())
        self.assertLess(split["dev"].timestamp.max(), split["test"].timestamp.min())

    def test_importance_weight_diagnostics_and_clipping_match_hand_calculation(self) -> None:
        weights, diagnostics = importance_weights([0.5, 0.25], target_probability=0.25)
        np.testing.assert_allclose(weights, [0.5, 1.0])
        self.assertAlmostEqual(diagnostics.mean, 0.75)
        self.assertAlmostEqual(diagnostics.variance, 0.0625)
        self.assertAlmostEqual(diagnostics.effective_sample_size, 1.8)
        clipped, clipped_diagnostics = importance_weights(
            [0.5, 0.1], target_probability=0.25, clipping_floor=0.25
        )
        np.testing.assert_allclose(clipped, [0.5, 1.0])
        self.assertEqual(clipped_diagnostics.clipped_count, 1)

    def test_snips_training_weights_have_unit_mean(self) -> None:
        weights, diagnostics = importance_weights(
            [0.5, 0.25, 0.125], target_probability=0.25, self_normalize=True
        )
        self.assertAlmostEqual(float(weights.mean()), 1.0)
        self.assertAlmostEqual(diagnostics.mean, 1.0)

    def test_weighted_models_keep_naive_feature_parity(self) -> None:
        protocols = _model_protocols(fixture_frame(), target_probability=0.25, clipping_thresholds=[0.1])
        include_position = {name: position for name, position, _, _ in protocols}
        self.assertFalse(include_position["naive"])
        self.assertTrue(include_position["position_as_feature"])
        self.assertFalse(include_position["ips"])
        self.assertFalse(include_position["snips"])
        self.assertFalse(include_position["ips_clipped_0p1"])

    def test_position_standardization_uses_target_position_mix(self) -> None:
        source = pd.DataFrame({"position": [1, 1, 2, 2, 3, 3], "click": [1, 1, 0, 0, 0, 0]})
        target = pd.DataFrame({"position": [1, 2, 2, 3, 3, 3], "click": [0] * 6})
        self.assertAlmostEqual(position_standardized_ctr(source, target), 1 / 6)

    def test_policy_values_include_all_preregistered_estimators(self) -> None:
        bts = fixture_frame(30)
        random = fixture_frame(30)
        random["propensity_score"] = 0.25
        values = policy_value_estimates(
            bts,
            random,
            target_probability=0.25,
            clipping_thresholds=[0.1, 0.2],
        )
        self.assertTrue(
            {
                "on_policy_random",
                "naive_bts",
                "position_as_feature_standardization",
                "ips",
                "snips",
                "ips_clipped_0p1",
                "snips_clipped_0p1",
                "ips_clipped_0p2",
                "snips_clipped_0p2",
            }.issubset(values)
        )

    def test_weighted_log_loss_and_position_calibration(self) -> None:
        labels = [1, 0, 1, 0, 0, 0]
        probabilities = [0.8, 0.2, 0.7, 0.1, 0.4, 0.2]
        positions = [1, 1, 2, 2, 3, 3]
        self.assertGreater(weighted_log_loss(labels, probabilities, [1] * 6), 0)
        calibration = calibration_by_position(positions, labels, probabilities)
        self.assertEqual(calibration["1"]["rows"], 2)
        self.assertAlmostEqual(calibration["1"]["observedCtr"], 0.5)
        self.assertAlmostEqual(calibration["1"]["meanPredictedCtr"], 0.5)

    def test_full_streaming_protocol_uses_only_held_out_tail(self) -> None:
        frame = fixture_frame(30)[["timestamp", "item_id", "position", "click", "propensity_score"]]
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "fixture.zip"
            csv_path = Path(directory) / "fixture.csv"
            frame.to_csv(csv_path, index=False)
            with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.write(csv_path, "fixture.csv")
            streamed = stream_full_policy_test_partition(
                archive_path,
                "fixture.csv",
                total_rows=30,
                test_start_timestamp=frame.iloc[24].timestamp.isoformat(),
                action_count=4,
                target_probability=0.25,
                clipping_thresholds=[0.2],
                chunk_rows=7,
                include_importance_weights=True,
            )
        self.assertEqual(streamed["rows"], 6)
        self.assertEqual(streamed["clicks"], int(frame.iloc[24:].click.sum()))
        self.assertEqual(streamed["positions"], {
            "1": {"rows": 2, "clicks": 0},
            "2": {"rows": 2, "clicks": 1},
            "3": {"rows": 2, "clicks": 0},
        })
        self.assertIn("unclipped", streamed["importanceWeights"])
        self.assertIn("0.2", streamed["importanceWeights"])


if __name__ == "__main__":
    unittest.main()
