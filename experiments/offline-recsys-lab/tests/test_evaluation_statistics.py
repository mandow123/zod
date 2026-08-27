from __future__ import annotations

import pytest

from kai_recsys_lab.evaluation.statistics import paired_user_bootstrap_ci


def test_paired_bootstrap_is_reproducible_and_reports_difference_interval() -> None:
    baseline = {"u3": 0.2, "u1": 0.1, "u4": 0.6, "u2": 0.4}
    candidate = {"u1": 0.3, "u2": 0.5, "u3": 0.25, "u4": 0.9}

    first = paired_user_bootstrap_ci(baseline, candidate, bootstrap_samples=2_000, seed=3407)
    second = paired_user_bootstrap_ci(dict(reversed(list(baseline.items()))), candidate, bootstrap_samples=2_000, seed=3407)

    assert first == second
    assert first.mean_difference == pytest.approx(first.candidate_mean - first.baseline_mean)
    assert first.lower_bound <= first.mean_difference <= first.upper_bound
    assert first.user_count == 4
    assert first.bootstrap_samples == 2_000
    assert first.resampling_unit == "user"
    assert first.interval_method == "paired-percentile-bootstrap"


def test_paired_bootstrap_preserves_a_constant_paired_effect() -> None:
    baseline = {f"u{index}": float(index) for index in range(8)}
    candidate = {user_id: value + 0.25 for user_id, value in baseline.items()}

    result = paired_user_bootstrap_ci(baseline, candidate, bootstrap_samples=500, seed=7)

    assert result.mean_difference == pytest.approx(0.25)
    assert result.lower_bound == pytest.approx(0.25)
    assert result.upper_bound == pytest.approx(0.25)
    assert result.excludes_zero


def test_paired_bootstrap_rejects_population_mismatch_and_non_finite_values() -> None:
    with pytest.raises(ValueError, match="must match exactly"):
        paired_user_bootstrap_ci({"u1": 0.1}, {"u2": 0.2})
    with pytest.raises(ValueError, match="finite"):
        paired_user_bootstrap_ci({"u1": 0.1}, {"u1": float("nan")})
