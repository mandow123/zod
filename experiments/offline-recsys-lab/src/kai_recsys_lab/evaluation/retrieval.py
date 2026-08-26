from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Collection, Mapping, Sequence


@dataclass(frozen=True, slots=True)
class RetrievalMetrics:
    """Per-query or macro-averaged full-catalog retrieval metrics."""

    recall: float
    hit_rate: float
    mrr: float
    ndcg: float


def _validate_k(k: int) -> None:
    if isinstance(k, bool) or not isinstance(k, int) or k < 1:
        raise ValueError("k must be a positive integer")


def _validate_ranking(ranked_item_ids: Sequence[str]) -> tuple[str, ...]:
    ranking = tuple(ranked_item_ids)
    if any(not item_id for item_id in ranking):
        raise ValueError("ranked item ids must be non-empty")
    if len(set(ranking)) != len(ranking):
        raise ValueError("a ranking must not contain duplicate item ids")
    return ranking


def _validate_relevant(relevant_item_ids: Collection[str]) -> frozenset[str]:
    relevant = frozenset(relevant_item_ids)
    if not relevant:
        raise ValueError("each evaluated query must have at least one relevant item")
    if any(not item_id for item_id in relevant):
        raise ValueError("relevant item ids must be non-empty")
    return relevant


def retrieval_metrics_at_k(
    ranked_item_ids: Sequence[str], relevant_item_ids: Collection[str], k: int
) -> RetrievalMetrics:
    """Compute binary-relevance Recall, HitRate, MRR and NDCG at ``k``.

    Duplicate ranked ids are rejected instead of being allowed to inflate a
    metric. Queries without a held-out positive are not scoreable and also fail
    closed.
    """

    _validate_k(k)
    ranking = _validate_ranking(ranked_item_ids)
    relevant = _validate_relevant(relevant_item_ids)
    top_k = ranking[:k]
    hit_ranks = [rank for rank, item_id in enumerate(top_k, start=1) if item_id in relevant]
    hit_count = len(hit_ranks)

    recall = hit_count / len(relevant)
    hit_rate = float(hit_count > 0)
    mrr = 0.0 if not hit_ranks else 1.0 / hit_ranks[0]
    dcg = sum(1.0 / math.log2(rank + 1) for rank in hit_ranks)
    ideal_hits = min(len(relevant), k)
    ideal_dcg = sum(1.0 / math.log2(rank + 1) for rank in range(1, ideal_hits + 1))
    ndcg = dcg / ideal_dcg
    return RetrievalMetrics(recall=recall, hit_rate=hit_rate, mrr=mrr, ndcg=ndcg)


def mean_retrieval_metrics_at_k(
    rankings_by_query: Mapping[str, Sequence[str]],
    relevant_by_query: Mapping[str, Collection[str]],
    k: int,
) -> RetrievalMetrics:
    """Macro-average retrieval metrics across an exactly matched query set."""

    _validate_k(k)
    ranking_queries = set(rankings_by_query)
    relevant_queries = set(relevant_by_query)
    if not ranking_queries:
        raise ValueError("at least one query is required")
    if ranking_queries != relevant_queries:
        missing_rankings = sorted(relevant_queries - ranking_queries)
        missing_labels = sorted(ranking_queries - relevant_queries)
        raise ValueError(
            "ranking and relevance query ids must match exactly; "
            f"missing_rankings={missing_rankings}, missing_labels={missing_labels}"
        )

    per_query = [
        retrieval_metrics_at_k(rankings_by_query[query_id], relevant_by_query[query_id], k)
        for query_id in sorted(ranking_queries)
    ]
    count = len(per_query)
    return RetrievalMetrics(
        recall=sum(metric.recall for metric in per_query) / count,
        hit_rate=sum(metric.hit_rate for metric in per_query) / count,
        mrr=sum(metric.mrr for metric in per_query) / count,
        ndcg=sum(metric.ndcg for metric in per_query) / count,
    )


def graded_ndcg_at_k(
    ranked_item_ids: Sequence[str], relevance_by_item: Mapping[str, float], k: int
) -> float:
    """Compute graded NDCG using the standard ``2**relevance - 1`` gain."""

    _validate_k(k)
    ranking = _validate_ranking(ranked_item_ids)
    if not relevance_by_item:
        raise ValueError("relevance labels are required")

    relevance: dict[str, float] = {}
    for item_id, raw_value in relevance_by_item.items():
        value = float(raw_value)
        if not item_id or not math.isfinite(value) or value < 0:
            raise ValueError("relevance ids must be non-empty and labels finite and non-negative")
        relevance[item_id] = value

    def discounted_gain(values: Sequence[float]) -> float:
        return sum((math.pow(2.0, value) - 1.0) / math.log2(rank + 1) for rank, value in enumerate(values, 1))

    ranked_values = [relevance.get(item_id, 0.0) for item_id in ranking[:k]]
    ideal_values = sorted(relevance.values(), reverse=True)[:k]
    ideal_dcg = discounted_gain(ideal_values)
    if ideal_dcg == 0:
        return 0.0
    return discounted_gain(ranked_values) / ideal_dcg
