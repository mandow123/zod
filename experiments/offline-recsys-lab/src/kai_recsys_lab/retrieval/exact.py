from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

import torch
from torch import Tensor


@dataclass(frozen=True, slots=True)
class ScoredItem:
    item_index: int
    score: float


def exact_full_catalog_topk(
    user_vectors: Tensor,
    catalog_item_vectors: Tensor,
    catalog_item_indices: Tensor,
    k: int,
    *,
    exclude_item_indices: Mapping[int, set[int] | frozenset[int]] | None = None,
) -> tuple[tuple[ScoredItem, ...], ...]:
    """Exact dot-product Top-K over every supplied catalog item.

    `exclude_item_indices` is keyed by query row, not a global user ID. It is
    intended for excluding train-history items during offline evaluation.
    """

    if user_vectors.ndim != 2 or catalog_item_vectors.ndim != 2:
        raise ValueError("user and catalog vectors must be rank two")
    if user_vectors.shape[1] != catalog_item_vectors.shape[1]:
        raise ValueError("user and item vector dimensions must match")
    if catalog_item_indices.ndim != 1 or catalog_item_indices.shape[0] != catalog_item_vectors.shape[0]:
        raise ValueError("catalog indices must align with item vectors")
    if k < 1:
        raise ValueError("k must be positive")

    scores = user_vectors @ catalog_item_vectors.T
    rows: list[tuple[ScoredItem, ...]] = []
    catalog_ids = catalog_item_indices.detach().cpu().tolist()
    for row_index in range(scores.shape[0]):
        excluded = (exclude_item_indices or {}).get(row_index, frozenset())
        candidates = [
            (int(item_id), float(score))
            for item_id, score in zip(catalog_ids, scores[row_index].detach().cpu().tolist(), strict=True)
            if int(item_id) not in excluded
        ]
        # Explicit tie-breaking avoids backend-dependent torch.topk ordering.
        candidates.sort(key=lambda candidate: (-candidate[1], candidate[0]))
        rows.append(tuple(ScoredItem(item_id, score) for item_id, score in candidates[:k]))
    return tuple(rows)
