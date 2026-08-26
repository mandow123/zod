from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Hashable, Mapping, Sequence


@dataclass(frozen=True, slots=True)
class RankingMetrics:
    k: int
    recall: float
    hit_rate: float
    mrr: float
    ndcg: float
    query_count: int


def evaluate_rankings(
    recommendations: Mapping[Hashable, Sequence[Hashable]],
    relevant_items: Mapping[Hashable, set[Hashable] | frozenset[Hashable]],
    ks: Sequence[int],
) -> tuple[RankingMetrics, ...]:
    """Macro metrics for binary relevance without sampled-negative shortcuts."""

    if not relevant_items:
        raise ValueError("at least one evaluation query is required")
    if any(k < 1 for k in ks):
        raise ValueError("all k values must be positive")
    if any(not truth for truth in relevant_items.values()):
        raise ValueError("every query must have at least one relevant item")

    results: list[RankingMetrics] = []
    for k in ks:
        recall = hit_rate = mrr = ndcg = 0.0
        for query_id, truth in relevant_items.items():
            ranked = list(recommendations.get(query_id, ()))[:k]
            relevant_ranks = [rank for rank, item_id in enumerate(ranked, start=1) if item_id in truth]
            hits = len(relevant_ranks)
            recall += hits / len(truth)
            hit_rate += float(hits > 0)
            mrr += 1.0 / relevant_ranks[0] if relevant_ranks else 0.0
            dcg = sum(1.0 / math.log2(rank + 1.0) for rank in relevant_ranks)
            ideal_hits = min(len(truth), k)
            ideal_dcg = sum(1.0 / math.log2(rank + 1.0) for rank in range(1, ideal_hits + 1))
            ndcg += dcg / ideal_dcg
        count = len(relevant_items)
        results.append(RankingMetrics(k, recall / count, hit_rate / count, mrr / count, ndcg / count, count))
    return tuple(results)
