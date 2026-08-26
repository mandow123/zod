from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Iterable

from kai_recsys_lab.contracts import RetrievalExample, Split


@dataclass(frozen=True, slots=True)
class ScoredRecommendation:
    item_id: str
    score: float


class PopularityRecommender:
    """Non-personalized retrieval baseline fitted on train interactions only."""

    def __init__(self) -> None:
        self._ranking: tuple[ScoredRecommendation, ...] = ()
        self._seen: dict[str, frozenset[str]] = {}

    def fit(self, examples: Iterable[RetrievalExample]) -> PopularityRecommender:
        counts: Counter[str] = Counter()
        seen: defaultdict[str, set[str]] = defaultdict(set)
        for example in examples:
            if example.split is not Split.TRAIN:
                continue
            counts[example.item_id] += 1
            seen[example.user_id].add(example.item_id)
        if not counts:
            raise ValueError("popularity baseline requires at least one train interaction")
        self._ranking = tuple(
            ScoredRecommendation(item_id, float(count))
            for item_id, count in sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))
        )
        self._seen = {user_id: frozenset(items) for user_id, items in seen.items()}
        return self

    @property
    def catalog(self) -> tuple[str, ...]:
        return tuple(candidate.item_id for candidate in self._ranking)

    def recommend(
        self,
        user_id: str,
        k: int,
        *,
        exclude_seen: bool = True,
    ) -> tuple[ScoredRecommendation, ...]:
        if k < 1:
            raise ValueError("k must be positive")
        if not self._ranking:
            raise RuntimeError("fit must be called before recommend")
        seen = self._seen.get(user_id, frozenset()) if exclude_seen else frozenset()
        return tuple(candidate for candidate in self._ranking if candidate.item_id not in seen)[:k]
