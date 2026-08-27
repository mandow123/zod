from __future__ import annotations

import pytest

from kai_recsys_lab.contracts import Split
from kai_recsys_lab.evaluation.cohorts import (
    AblationResult,
    AblationSuiteResult,
    AblationVariant,
    CohortDimension,
    CohortFeatureSnapshot,
    ColdStartCohort,
    HistoryLengthCohort,
    ItemPopularityCohort,
    assign_cohorts,
    group_queries_by_cohort,
)


def _snapshot(
    query_id: str,
    *,
    seen: bool,
    history: int,
    popularity: int,
) -> CohortFeatureSnapshot:
    return CohortFeatureSnapshot(
        query_id=query_id,
        user_seen_before_cutoff=seen,
        history_length_before_cutoff=history,
        item_interactions_before_cutoff=popularity,
        source_split=Split.TRAIN,
        evaluation_split=Split.TEST,
        feature_cutoff_timestamp_ms=100,
        evaluation_timestamp_ms=200,
    )


def test_assigns_cold_start_history_and_popularity_cohorts() -> None:
    cold = assign_cohorts(_snapshot("q-cold", seen=False, history=0, popularity=0))
    warm = assign_cohorts(_snapshot("q-warm", seen=True, history=20, popularity=50))

    assert cold.cold_start is ColdStartCohort.NEW_USER
    assert cold.history_length is HistoryLengthCohort.ZERO
    assert cold.item_popularity is ItemPopularityCohort.UNSEEN
    assert warm.cold_start is ColdStartCohort.WARM_USER
    assert warm.history_length is HistoryLengthCohort.LONG
    assert warm.item_popularity is ItemPopularityCohort.HEAD

    grouped = group_queries_by_cohort((warm, cold), CohortDimension.COLD_START)
    assert grouped == {"new_user": ("q-cold",), "warm_user": ("q-warm",)}


def test_cohort_features_fail_closed_on_test_or_post_event_provenance() -> None:
    with pytest.raises(ValueError, match="split earlier"):
        CohortFeatureSnapshot(
            query_id="q1",
            user_seen_before_cutoff=True,
            history_length_before_cutoff=1,
            item_interactions_before_cutoff=1,
            source_split=Split.TEST,
            evaluation_split=Split.TEST,
            feature_cutoff_timestamp_ms=100,
            evaluation_timestamp_ms=200,
        )
    with pytest.raises(ValueError, match="frozen before"):
        CohortFeatureSnapshot(
            query_id="q1",
            user_seen_before_cutoff=True,
            history_length_before_cutoff=1,
            item_interactions_before_cutoff=1,
            source_split=Split.TRAIN,
            evaluation_split=Split.TEST,
            feature_cutoff_timestamp_ms=200,
            evaluation_timestamp_ms=200,
        )


def test_ablation_suite_requires_all_feature_removals_on_one_population() -> None:
    digest = "a" * 64
    values = {
        AblationVariant.FULL: 0.50,
        AblationVariant.WITHOUT_METADATA: 0.40,
        AblationVariant.WITHOUT_ID: 0.42,
        AblationVariant.WITHOUT_TITLE: 0.47,
        AblationVariant.WITHOUT_CATEGORY: 0.49,
    }
    suite = AblationSuiteResult(
        protocol_id="metadata-ablation-v1",
        results=tuple(
            AblationResult(
                variant=variant,
                metrics={"recall@20": value},
                query_count=100,
                query_set_sha256=digest,
                evaluation_split=Split.DEV,
                seed=3407,
            )
            for variant, value in values.items()
        ),
    )

    assert AblationVariant.WITHOUT_METADATA.enabled_features == ("id",)
    assert AblationVariant.WITHOUT_ID.enabled_features == ("title", "category")
    assert suite.differences_from_full("recall@20")["without_title"] == pytest.approx(-0.03)

    with pytest.raises(ValueError, match="each canonical variant"):
        AblationSuiteResult(protocol_id="incomplete", results=suite.results[:-1])
