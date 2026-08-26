from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence


@dataclass(frozen=True, slots=True)
class InversePropensityEstimate:
    """IPS/SNIPS diagnostics for a known or externally estimated propensity."""

    ips: float
    snips: float
    effective_sample_size: float
    sample_count: int
    weight_sum: float
    max_weight: float
    clipping_floor: float | None
    clipped_count: int


def validate_propensities(propensities: Sequence[float]) -> tuple[float, ...]:
    checked = tuple(float(propensity) for propensity in propensities)
    if not checked:
        raise ValueError("at least one propensity is required")
    if any(not math.isfinite(propensity) or not 0 < propensity <= 1 for propensity in checked):
        raise ValueError("propensities must be finite and in (0, 1]")
    return checked


def inverse_propensity_estimate(
    outcomes: Sequence[float],
    propensities: Sequence[float],
    *,
    min_propensity: float | None = None,
) -> InversePropensityEstimate:
    """Compute IPS, self-normalized IPS (SNIPS), clipping and ESS.

    ``min_propensity`` clips the denominator from below. The function assumes
    propensities came from a known logging policy or an independently validated
    estimator; it does not infer causal validity from observational position.
    """

    checked_outcomes = tuple(float(outcome) for outcome in outcomes)
    checked_propensities = validate_propensities(propensities)
    if len(checked_outcomes) != len(checked_propensities):
        raise ValueError("outcomes and propensities must have equal length")
    if any(not math.isfinite(outcome) for outcome in checked_outcomes):
        raise ValueError("outcomes must be finite")
    if min_propensity is not None:
        min_propensity = float(min_propensity)
        if not math.isfinite(min_propensity) or not 0 < min_propensity <= 1:
            raise ValueError("min_propensity must be finite and in (0, 1]")

    clipped_count = 0
    denominators: list[float] = []
    for propensity in checked_propensities:
        denominator = propensity
        if min_propensity is not None and propensity < min_propensity:
            denominator = min_propensity
            clipped_count += 1
        denominators.append(denominator)

    weights = [1.0 / denominator for denominator in denominators]
    weighted_outcome_sum = sum(weight * outcome for weight, outcome in zip(weights, checked_outcomes))
    weight_sum = sum(weights)
    squared_weight_sum = sum(weight * weight for weight in weights)
    sample_count = len(weights)
    return InversePropensityEstimate(
        ips=weighted_outcome_sum / sample_count,
        snips=weighted_outcome_sum / weight_sum,
        effective_sample_size=weight_sum * weight_sum / squared_weight_sum,
        sample_count=sample_count,
        weight_sum=weight_sum,
        max_weight=max(weights),
        clipping_floor=min_propensity,
        clipped_count=clipped_count,
    )
