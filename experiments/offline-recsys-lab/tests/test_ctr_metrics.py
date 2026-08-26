from __future__ import annotations

import math

import pytest

from kai_recsys_lab.ctr import evaluate_binary_predictions


def test_binary_metrics_expose_auc_logloss_and_calibration_contract() -> None:
    metrics = evaluate_binary_predictions(
        [0, 0, 1, 1], [0.05, 0.20, 0.80, 0.95], n_calibration_bins=4
    )

    assert metrics.n_examples == 4
    assert metrics.auc == 1.0
    assert metrics.average_precision == 1.0
    assert metrics.pr_auc == 1.0
    assert metrics.log_loss > 0
    assert metrics.brier_score > 0
    assert 0 <= metrics.expected_calibration_error <= 1
    assert len(metrics.calibration) == 4
    assert sum(bin_.count for bin_ in metrics.calibration) == 4


def test_binary_metrics_make_single_class_auc_explicitly_unavailable() -> None:
    metrics = evaluate_binary_predictions([0, 0], [0.1, 0.2], n_calibration_bins=2)
    assert metrics.auc is None
    assert metrics.average_precision is None
    assert metrics.pr_auc is None
    assert math.isfinite(metrics.log_loss)


def test_binary_metrics_reject_non_probability_input() -> None:
    with pytest.raises(ValueError, match="probabilities"):
        evaluate_binary_predictions([0, 1], [0.1, 1.1])
