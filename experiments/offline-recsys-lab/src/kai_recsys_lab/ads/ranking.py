from __future__ import annotations

import math
from dataclasses import dataclass
from enum import StrEnum
from typing import Mapping, Sequence

from kai_recsys_lab.evaluation import graded_ndcg_at_k


class RankingObjective(StrEnum):
    CTR_ONLY = "ctr_only"
    POST_CLICK_CVR_ONLY = "post_click_cvr_only"
    # Short API alias; the serialized value remains explicit to avoid confusion
    # with Compute's ConstraintViolationRate.
    CVR_ONLY = "post_click_cvr_only"
    CTR_X_CVR = "ctr_x_cvr"
    VALUE_AWARE = "value_aware"
    ECPM = "ecpm"


@dataclass(frozen=True, slots=True)
class AdsCandidate:
    candidate_id: str
    pctr: float
    post_click_cvr: float
    conversion_value: float = 0.0
    bid: float = 0.0
    quality: float = 1.0

    def __post_init__(self) -> None:
        if not self.candidate_id:
            raise ValueError("candidate_id is required")
        for name, probability in (("pctr", self.pctr), ("post_click_cvr", self.post_click_cvr)):
            if not math.isfinite(probability) or not 0 <= probability <= 1:
                raise ValueError(f"{name} must be finite and in [0, 1]")
        for name, value in (
            ("conversion_value", self.conversion_value),
            ("bid", self.bid),
            ("quality", self.quality),
        ):
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"{name} must be finite and non-negative")


@dataclass(frozen=True, slots=True)
class AdsRankingMetrics:
    expected_conversions: float
    expected_value: float
    ndcg: float


def score_candidate(candidate: AdsCandidate, objective: RankingObjective) -> float:
    if objective is RankingObjective.CTR_ONLY:
        return candidate.pctr
    if objective is RankingObjective.POST_CLICK_CVR_ONLY:
        return candidate.post_click_cvr
    if objective is RankingObjective.CTR_X_CVR:
        return candidate.pctr * candidate.post_click_cvr
    if objective is RankingObjective.VALUE_AWARE:
        return candidate.pctr * candidate.post_click_cvr * candidate.conversion_value * candidate.quality
    if objective is RankingObjective.ECPM:
        return 1_000.0 * candidate.pctr * candidate.bid * candidate.quality
    raise ValueError(f"unsupported ranking objective: {objective!r}")


def _candidate_map(candidates: Sequence[AdsCandidate]) -> dict[str, AdsCandidate]:
    if not candidates:
        raise ValueError("at least one advertising candidate is required")
    by_id = {candidate.candidate_id: candidate for candidate in candidates}
    if len(by_id) != len(candidates):
        raise ValueError("candidate ids must be unique")
    return by_id


def rank_candidates(candidates: Sequence[AdsCandidate], objective: RankingObjective) -> tuple[str, ...]:
    """Rank candidates with deterministic candidate-id tie breaking."""

    _candidate_map(candidates)
    return tuple(
        candidate.candidate_id
        for candidate in sorted(
            candidates,
            key=lambda candidate: (-score_candidate(candidate, objective), candidate.candidate_id),
        )
    )


def evaluate_ads_ranking(
    candidates: Sequence[AdsCandidate],
    ranked_candidate_ids: Sequence[str],
    relevance_by_candidate: Mapping[str, float],
    *,
    k: int,
) -> AdsRankingMetrics:
    """Evaluate an offline ranking under supplied public/synthetic labels.

    Expected conversions use ``pCTR * PostClickCVR``. Expected value multiplies
    that probability by conversion value. Neither is evidence of realized
    production lift.
    """

    if isinstance(k, bool) or not isinstance(k, int) or k < 1:
        raise ValueError("k must be a positive integer")
    candidates_by_id = _candidate_map(candidates)
    ranking = tuple(ranked_candidate_ids)
    if len(set(ranking)) != len(ranking):
        raise ValueError("a ranking must not contain duplicate candidate ids")
    if any(candidate_id not in candidates_by_id for candidate_id in ranking):
        raise ValueError("ranking contains an unknown candidate id")
    if set(relevance_by_candidate) != set(candidates_by_id):
        raise ValueError("relevance labels must exactly match the candidate set")

    top_candidates = [candidates_by_id[candidate_id] for candidate_id in ranking[:k]]
    expected_conversions = sum(candidate.pctr * candidate.post_click_cvr for candidate in top_candidates)
    expected_value = sum(
        candidate.pctr * candidate.post_click_cvr * candidate.conversion_value for candidate in top_candidates
    )
    return AdsRankingMetrics(
        expected_conversions=expected_conversions,
        expected_value=expected_value,
        ndcg=graded_ndcg_at_k(ranking, relevance_by_candidate, k),
    )
