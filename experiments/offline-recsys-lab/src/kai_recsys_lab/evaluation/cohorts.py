from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from enum import StrEnum
from types import MappingProxyType
from typing import Mapping, Sequence

from kai_recsys_lab.contracts import Split


class ColdStartCohort(StrEnum):
    NEW_USER = "new_user"
    KNOWN_USER_NO_HISTORY = "known_user_no_history"
    WARM_USER = "warm_user"


class HistoryLengthCohort(StrEnum):
    ZERO = "zero"
    SHORT = "short"
    MEDIUM = "medium"
    LONG = "long"


class ItemPopularityCohort(StrEnum):
    UNSEEN = "unseen"
    TAIL = "tail"
    MID = "mid"
    HEAD = "head"


class CohortDimension(StrEnum):
    COLD_START = "cold_start"
    HISTORY_LENGTH = "history_length"
    ITEM_POPULARITY = "item_popularity"


@dataclass(frozen=True, slots=True)
class CohortDefinition:
    history_short_max: int = 4
    history_medium_max: int = 19
    popularity_tail_max: int = 4
    popularity_mid_max: int = 49

    def __post_init__(self) -> None:
        values = (
            self.history_short_max,
            self.history_medium_max,
            self.popularity_tail_max,
            self.popularity_mid_max,
        )
        if any(isinstance(value, bool) or not isinstance(value, int) for value in values):
            raise ValueError("cohort boundaries must be integers")
        if self.history_short_max < 1 or self.history_medium_max <= self.history_short_max:
            raise ValueError("history boundaries must be positive and strictly increasing")
        if self.popularity_tail_max < 1 or self.popularity_mid_max <= self.popularity_tail_max:
            raise ValueError("popularity boundaries must be positive and strictly increasing")


_SPLIT_ORDER = {Split.TRAIN: 0, Split.DEV: 1, Split.TEST: 2}


@dataclass(frozen=True, slots=True)
class CohortFeatureSnapshot:
    """Label-free, pre-evaluation features used to assign one query to cohorts.

    The API deliberately accepts no relevance label or test outcome.  Its
    provenance contract additionally requires that features come from a split
    strictly earlier than the evaluated split and from a temporal cutoff before
    the evaluation event.
    """

    query_id: str
    user_seen_before_cutoff: bool
    history_length_before_cutoff: int
    item_interactions_before_cutoff: int
    source_split: Split
    evaluation_split: Split
    feature_cutoff_timestamp_ms: int
    evaluation_timestamp_ms: int

    def __post_init__(self) -> None:
        if not isinstance(self.query_id, str) or not self.query_id:
            raise ValueError("query_id is required")
        for name, value in (
            ("history_length_before_cutoff", self.history_length_before_cutoff),
            ("item_interactions_before_cutoff", self.item_interactions_before_cutoff),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{name} must be a non-negative integer")
        if not isinstance(self.user_seen_before_cutoff, bool):
            raise ValueError("user_seen_before_cutoff must be boolean")
        if not self.user_seen_before_cutoff and self.history_length_before_cutoff != 0:
            raise ValueError("an unseen user cannot have pre-cutoff history")
        if not isinstance(self.source_split, Split) or not isinstance(self.evaluation_split, Split):
            raise ValueError("cohort provenance requires Split values")
        timestamps = (self.feature_cutoff_timestamp_ms, self.evaluation_timestamp_ms)
        if any(isinstance(value, bool) or not isinstance(value, int) or value <= 0 for value in timestamps):
            raise ValueError("cohort timestamps must be positive")
        if self.feature_cutoff_timestamp_ms >= self.evaluation_timestamp_ms:
            raise ValueError("cohort features must be frozen before the evaluation event")
        if _SPLIT_ORDER[self.source_split] >= _SPLIT_ORDER[self.evaluation_split]:
            raise ValueError("cohort features must come from a split earlier than the evaluation split")


@dataclass(frozen=True, slots=True)
class CohortAssignment:
    query_id: str
    cold_start: ColdStartCohort
    history_length: HistoryLengthCohort
    item_popularity: ItemPopularityCohort

    def __post_init__(self) -> None:
        if not isinstance(self.query_id, str) or not self.query_id:
            raise ValueError("query_id is required")
        if not isinstance(self.cold_start, ColdStartCohort):
            raise ValueError("cold_start must be a ColdStartCohort")
        if not isinstance(self.history_length, HistoryLengthCohort):
            raise ValueError("history_length must be a HistoryLengthCohort")
        if not isinstance(self.item_popularity, ItemPopularityCohort):
            raise ValueError("item_popularity must be an ItemPopularityCohort")


def assign_cohorts(
    snapshot: CohortFeatureSnapshot,
    definition: CohortDefinition = CohortDefinition(),
) -> CohortAssignment:
    if not snapshot.user_seen_before_cutoff:
        cold_start = ColdStartCohort.NEW_USER
    elif snapshot.history_length_before_cutoff == 0:
        cold_start = ColdStartCohort.KNOWN_USER_NO_HISTORY
    else:
        cold_start = ColdStartCohort.WARM_USER

    if snapshot.history_length_before_cutoff == 0:
        history = HistoryLengthCohort.ZERO
    elif snapshot.history_length_before_cutoff <= definition.history_short_max:
        history = HistoryLengthCohort.SHORT
    elif snapshot.history_length_before_cutoff <= definition.history_medium_max:
        history = HistoryLengthCohort.MEDIUM
    else:
        history = HistoryLengthCohort.LONG

    if snapshot.item_interactions_before_cutoff == 0:
        popularity = ItemPopularityCohort.UNSEEN
    elif snapshot.item_interactions_before_cutoff <= definition.popularity_tail_max:
        popularity = ItemPopularityCohort.TAIL
    elif snapshot.item_interactions_before_cutoff <= definition.popularity_mid_max:
        popularity = ItemPopularityCohort.MID
    else:
        popularity = ItemPopularityCohort.HEAD

    return CohortAssignment(snapshot.query_id, cold_start, history, popularity)


def group_queries_by_cohort(
    assignments: Sequence[CohortAssignment],
    dimension: CohortDimension,
) -> Mapping[str, tuple[str, ...]]:
    if not assignments:
        raise ValueError("at least one cohort assignment is required")
    if not isinstance(dimension, CohortDimension):
        raise ValueError("dimension must be a CohortDimension")
    if any(not isinstance(assignment, CohortAssignment) for assignment in assignments):
        raise ValueError("assignments must contain CohortAssignment values")
    query_ids = [assignment.query_id for assignment in assignments]
    if len(set(query_ids)) != len(query_ids):
        raise ValueError("cohort assignments must have unique query ids")
    groups: dict[str, list[str]] = {}
    for assignment in assignments:
        cohort = getattr(assignment, dimension.value)
        groups.setdefault(str(cohort), []).append(assignment.query_id)
    return MappingProxyType({name: tuple(sorted(ids)) for name, ids in sorted(groups.items())})


class AblationVariant(StrEnum):
    FULL = "full"
    WITHOUT_METADATA = "without_metadata"
    WITHOUT_ID = "without_id"
    WITHOUT_TITLE = "without_title"
    WITHOUT_CATEGORY = "without_category"

    @property
    def enabled_features(self) -> tuple[str, ...]:
        return {
            AblationVariant.FULL: ("id", "title", "category"),
            AblationVariant.WITHOUT_METADATA: ("id",),
            AblationVariant.WITHOUT_ID: ("title", "category"),
            AblationVariant.WITHOUT_TITLE: ("id", "category"),
            AblationVariant.WITHOUT_CATEGORY: ("id", "title"),
        }[self]


_SHA256 = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True, slots=True)
class AblationResult:
    variant: AblationVariant
    metrics: Mapping[str, float]
    query_count: int
    query_set_sha256: str
    evaluation_split: Split
    seed: int
    enabled_features: tuple[str, ...] = field(init=False)

    def __post_init__(self) -> None:
        if not isinstance(self.variant, AblationVariant):
            raise ValueError("variant must be an AblationVariant")
        if not self.metrics:
            raise ValueError("ablation metrics are required")
        frozen_metrics: dict[str, float] = {}
        for name, raw_value in self.metrics.items():
            value = float(raw_value)
            if not name or not math.isfinite(value):
                raise ValueError("ablation metric names must be non-empty and values finite")
            frozen_metrics[name] = value
        if isinstance(self.query_count, bool) or not isinstance(self.query_count, int) or self.query_count < 1:
            raise ValueError("query_count must be a positive integer")
        if not _SHA256.fullmatch(self.query_set_sha256):
            raise ValueError("query_set_sha256 must be a lowercase SHA-256 digest")
        if not isinstance(self.evaluation_split, Split) or self.evaluation_split is Split.TRAIN:
            raise ValueError("ablation results must be evaluated on dev or test")
        if isinstance(self.seed, bool) or not isinstance(self.seed, int) or self.seed < 0:
            raise ValueError("seed must be a non-negative integer")
        object.__setattr__(self, "metrics", MappingProxyType(frozen_metrics))
        object.__setattr__(self, "enabled_features", self.variant.enabled_features)


@dataclass(frozen=True, slots=True)
class AblationSuiteResult:
    """Validated, paired result contract for the canonical metadata ablations."""

    protocol_id: str
    results: tuple[AblationResult, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.protocol_id, str) or not self.protocol_id:
            raise ValueError("protocol_id is required")
        if any(not isinstance(result, AblationResult) for result in self.results):
            raise ValueError("results must contain AblationResult values")
        by_variant = {result.variant: result for result in self.results}
        expected = set(AblationVariant)
        if len(by_variant) != len(self.results) or set(by_variant) != expected:
            raise ValueError("ablation suite requires each canonical variant exactly once")
        reference = by_variant[AblationVariant.FULL]
        reference_metric_names = set(reference.metrics)
        for result in self.results:
            if (
                result.query_count != reference.query_count
                or result.query_set_sha256 != reference.query_set_sha256
                or result.evaluation_split is not reference.evaluation_split
                or result.seed != reference.seed
                or set(result.metrics) != reference_metric_names
            ):
                raise ValueError("ablation variants must share seed, query population, split, and metrics")
        object.__setattr__(self, "results", tuple(sorted(self.results, key=lambda item: item.variant.value)))

    def differences_from_full(self, metric_name: str) -> Mapping[str, float]:
        by_variant = {result.variant: result for result in self.results}
        baseline = by_variant[AblationVariant.FULL]
        if metric_name not in baseline.metrics:
            raise ValueError(f"unknown ablation metric: {metric_name}")
        return MappingProxyType(
            {
                variant.value: result.metrics[metric_name] - baseline.metrics[metric_name]
                for variant, result in sorted(by_variant.items(), key=lambda pair: pair[0].value)
            }
        )
