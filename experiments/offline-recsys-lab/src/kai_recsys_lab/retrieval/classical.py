from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable

import numpy as np

from kai_recsys_lab.contracts import RetrievalExample, Split

from .baselines import ScoredRecommendation


def _train_implicit_feedback(
    examples: Iterable[RetrievalExample],
) -> tuple[tuple[str, ...], tuple[str, ...], dict[str, frozenset[str]]]:
    """Return deterministic train-only users, catalog, and binary feedback."""

    feedback: defaultdict[str, set[str]] = defaultdict(set)
    for example in examples:
        if example.split is Split.TRAIN:
            feedback[example.user_id].add(example.item_id)
    if not feedback:
        raise ValueError("implicit retrieval requires at least one train interaction")
    users = tuple(sorted(feedback))
    catalog = tuple(sorted({item_id for items in feedback.values() for item_id in items}))
    return users, catalog, {user_id: frozenset(items) for user_id, items in feedback.items()}


class ItemKnnRecommender:
    """Implicit ItemKNN using binary user co-occurrence cosine similarity."""

    def __init__(self) -> None:
        self._catalog: tuple[str, ...] = ()
        self._seen: dict[str, frozenset[str]] = {}
        self._similarities: dict[str, dict[str, float]] = {}

    @property
    def catalog(self) -> tuple[str, ...]:
        return self._catalog

    def fit(self, examples: Iterable[RetrievalExample]) -> ItemKnnRecommender:
        _, catalog, seen = _train_implicit_feedback(examples)
        users_by_item: dict[str, set[str]] = {item_id: set() for item_id in catalog}
        for user_id, items in seen.items():
            for item_id in items:
                users_by_item[item_id].add(user_id)

        similarities: dict[str, dict[str, float]] = {item_id: {} for item_id in catalog}
        for left_index, left_item in enumerate(catalog):
            left_users = users_by_item[left_item]
            for right_item in catalog[left_index + 1 :]:
                right_users = users_by_item[right_item]
                common = len(left_users & right_users)
                if common == 0:
                    continue
                similarity = common / math.sqrt(len(left_users) * len(right_users))
                similarities[left_item][right_item] = similarity
                similarities[right_item][left_item] = similarity

        self._catalog = catalog
        self._seen = seen
        self._similarities = similarities
        return self

    def similarity(self, left_item_id: str, right_item_id: str) -> float:
        if not self._catalog:
            raise RuntimeError("fit must be called before similarity")
        return self._similarities.get(left_item_id, {}).get(right_item_id, 0.0)

    def recommend(
        self,
        user_id: str,
        k: int,
        *,
        exclude_seen: bool = True,
    ) -> tuple[ScoredRecommendation, ...]:
        if k < 1:
            raise ValueError("k must be positive")
        if not self._catalog:
            raise RuntimeError("fit must be called before recommend")
        history = self._seen.get(user_id, frozenset())
        excluded = history if exclude_seen else frozenset()
        scored = [
            ScoredRecommendation(
                item_id,
                sum(self._similarities.get(history_item, {}).get(item_id, 0.0) for history_item in history),
            )
            for item_id in self._catalog
            if item_id not in excluded
        ]
        scored.sort(key=lambda candidate: (-candidate.score, candidate.item_id))
        return tuple(scored[:k])


@dataclass(frozen=True, slots=True)
class BprConfig:
    factors: int = 32
    epochs: int = 20
    learning_rate: float = 0.05
    regularization: float = 1e-4
    seed: int = 20260826

    def __post_init__(self) -> None:
        if self.factors < 1 or self.epochs < 1 or self.learning_rate <= 0 or self.regularization < 0:
            raise ValueError("BPR hyperparameters must be valid")


class BprMatrixFactorization:
    """Small deterministic CPU BPR baseline for implicit feedback.

    This intentionally provides a research baseline, not a distributed or
    production recommender implementation.
    """

    def __init__(self, config: BprConfig | None = None) -> None:
        self.config = config or BprConfig()
        self._users: tuple[str, ...] = ()
        self._catalog: tuple[str, ...] = ()
        self._seen: dict[str, frozenset[str]] = {}
        self._user_lookup: dict[str, int] = {}
        self._item_lookup: dict[str, int] = {}
        self._user_factors: np.ndarray | None = None
        self._item_factors: np.ndarray | None = None

    @property
    def catalog(self) -> tuple[str, ...]:
        return self._catalog

    def fit(self, examples: Iterable[RetrievalExample]) -> BprMatrixFactorization:
        users, catalog, seen = _train_implicit_feedback(examples)
        if len(catalog) < 2:
            raise ValueError("BPR requires at least two train catalog items")

        user_lookup = {user_id: index for index, user_id in enumerate(users)}
        item_lookup = {item_id: index for index, item_id in enumerate(catalog)}
        pairs = np.asarray(
            sorted((user_lookup[user_id], item_lookup[item_id]) for user_id, items in seen.items() for item_id in items),
            dtype=np.int64,
        )
        seen_indices = {
            user_lookup[user_id]: frozenset(item_lookup[item_id] for item_id in items)
            for user_id, items in seen.items()
        }
        eligible_pair_rows = np.asarray(
            [row for row, (user_index, _) in enumerate(pairs) if len(seen_indices[int(user_index)]) < len(catalog)],
            dtype=np.int64,
        )
        if eligible_pair_rows.size == 0:
            raise ValueError("BPR requires at least one user with an unobserved train-catalog item")

        rng = np.random.default_rng(self.config.seed)
        scale = 1.0 / math.sqrt(self.config.factors)
        user_factors = rng.normal(0.0, scale, size=(len(users), self.config.factors)).astype(np.float64)
        item_factors = rng.normal(0.0, scale, size=(len(catalog), self.config.factors)).astype(np.float64)

        for _ in range(self.config.epochs):
            for pair_row in rng.permutation(eligible_pair_rows):
                user_index, positive_index = (int(value) for value in pairs[int(pair_row)])
                user_seen = seen_indices[user_index]
                negative_index = int(rng.integers(len(catalog)))
                while negative_index in user_seen:
                    negative_index = int(rng.integers(len(catalog)))

                user_vector = user_factors[user_index].copy()
                positive_vector = item_factors[positive_index].copy()
                negative_vector = item_factors[negative_index].copy()
                margin = float(user_vector @ (positive_vector - negative_vector))
                gradient = 1.0 / (1.0 + math.exp(max(-35.0, min(35.0, margin))))
                learning_rate = self.config.learning_rate
                regularization = self.config.regularization
                user_factors[user_index] += learning_rate * (
                    gradient * (positive_vector - negative_vector) - regularization * user_vector
                )
                item_factors[positive_index] += learning_rate * (
                    gradient * user_vector - regularization * positive_vector
                )
                item_factors[negative_index] += learning_rate * (
                    -gradient * user_vector - regularization * negative_vector
                )

        self._users = users
        self._catalog = catalog
        self._seen = seen
        self._user_lookup = user_lookup
        self._item_lookup = item_lookup
        self._user_factors = user_factors
        self._item_factors = item_factors
        return self

    def score(self, user_id: str, item_id: str) -> float:
        if self._user_factors is None or self._item_factors is None:
            raise RuntimeError("fit must be called before score")
        user_index = self._user_lookup.get(user_id)
        item_index = self._item_lookup.get(item_id)
        if item_index is None:
            raise KeyError(item_id)
        if user_index is None:
            return 0.0
        return float(self._user_factors[user_index] @ self._item_factors[item_index])

    def recommend(
        self,
        user_id: str,
        k: int,
        *,
        exclude_seen: bool = True,
    ) -> tuple[ScoredRecommendation, ...]:
        if k < 1:
            raise ValueError("k must be positive")
        if self._user_factors is None:
            raise RuntimeError("fit must be called before recommend")
        excluded = self._seen.get(user_id, frozenset()) if exclude_seen else frozenset()
        scored = [
            ScoredRecommendation(item_id, self.score(user_id, item_id))
            for item_id in self._catalog
            if item_id not in excluded
        ]
        scored.sort(key=lambda candidate: (-candidate.score, candidate.item_id))
        return tuple(scored[:k])
