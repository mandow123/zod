from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Mapping

import numpy as np


@dataclass(frozen=True, slots=True)
class PairedBootstrapInterval:
    """A percentile confidence interval for a candidate-minus-baseline mean.

    The resampling unit is always a user.  Keeping the two systems paired
    preserves their within-user covariance, which a comparison of independent
    seed standard deviations would discard.
    """

    baseline_mean: float
    candidate_mean: float
    mean_difference: float
    lower_bound: float
    upper_bound: float
    confidence_level: float
    user_count: int
    bootstrap_samples: int
    seed: int
    interval_method: str = "paired-percentile-bootstrap"
    resampling_unit: str = "user"

    @property
    def excludes_zero(self) -> bool:
        return self.lower_bound > 0.0 or self.upper_bound < 0.0


def _validated_scores(
    baseline_by_user: Mapping[str, float],
    candidate_by_user: Mapping[str, float],
) -> tuple[np.ndarray, np.ndarray]:
    baseline_ids = set(baseline_by_user)
    candidate_ids = set(candidate_by_user)
    if not baseline_ids:
        raise ValueError("paired bootstrap requires at least one user")
    if baseline_ids != candidate_ids:
        missing_candidate = sorted(baseline_ids - candidate_ids)
        missing_baseline = sorted(candidate_ids - baseline_ids)
        raise ValueError(
            "baseline and candidate user ids must match exactly; "
            f"missing_candidate={missing_candidate}, missing_baseline={missing_baseline}"
        )
    if any(not isinstance(user_id, str) or not user_id for user_id in baseline_ids):
        raise ValueError("user ids must be non-empty strings")

    ordered_ids = sorted(baseline_ids)
    baseline = np.asarray([baseline_by_user[user_id] for user_id in ordered_ids], dtype=np.float64)
    candidate = np.asarray([candidate_by_user[user_id] for user_id in ordered_ids], dtype=np.float64)
    if not np.isfinite(baseline).all() or not np.isfinite(candidate).all():
        raise ValueError("paired bootstrap scores must be finite")
    return baseline, candidate


def paired_user_bootstrap_ci(
    baseline_by_user: Mapping[str, float],
    candidate_by_user: Mapping[str, float],
    *,
    confidence_level: float = 0.95,
    bootstrap_samples: int = 10_000,
    seed: int = 20260827,
) -> PairedBootstrapInterval:
    """Estimate a reproducible user-level CI for ``candidate - baseline``.

    Inputs must contain exactly the same users.  Users are sorted before a
    fixed-seed generator samples paired differences, so mapping insertion order
    cannot change the result.  Sampling is batched to avoid allocating an
    ``bootstrap_samples x user_count`` matrix for large evaluations.
    """

    if not math.isfinite(confidence_level) or not 0.0 < confidence_level < 1.0:
        raise ValueError("confidence_level must be finite and in (0, 1)")
    if isinstance(bootstrap_samples, bool) or not isinstance(bootstrap_samples, int) or bootstrap_samples < 1:
        raise ValueError("bootstrap_samples must be a positive integer")
    if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
        raise ValueError("seed must be a non-negative integer")

    baseline, candidate = _validated_scores(baseline_by_user, candidate_by_user)
    differences = candidate - baseline
    rng = np.random.default_rng(seed)
    sampled_means = np.empty(bootstrap_samples, dtype=np.float64)
    batch_size = 512
    for start in range(0, bootstrap_samples, batch_size):
        stop = min(start + batch_size, bootstrap_samples)
        indices = rng.integers(0, differences.size, size=(stop - start, differences.size))
        sampled_means[start:stop] = differences[indices].mean(axis=1)

    alpha = 1.0 - confidence_level
    lower, upper = np.quantile(sampled_means, [alpha / 2.0, 1.0 - alpha / 2.0])
    return PairedBootstrapInterval(
        baseline_mean=float(baseline.mean()),
        candidate_mean=float(candidate.mean()),
        mean_difference=float(differences.mean()),
        lower_bound=float(lower),
        upper_bound=float(upper),
        confidence_level=confidence_level,
        user_count=differences.size,
        bootstrap_samples=bootstrap_samples,
        seed=seed,
    )
