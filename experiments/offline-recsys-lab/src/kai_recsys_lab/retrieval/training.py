from __future__ import annotations

import random
from dataclasses import dataclass

import numpy as np
import torch
from torch import Tensor

from .models import TwoTower, in_batch_softmax_loss


@dataclass(frozen=True, slots=True)
class TrainingResult:
    epoch_losses: tuple[float, ...]


def _seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def train_two_tower(
    model: TwoTower,
    user_indices: Tensor,
    positive_item_indices: Tensor,
    *,
    history_item_indices: Tensor | None = None,
    epochs: int = 5,
    batch_size: int = 256,
    learning_rate: float = 1e-3,
    seed: int = 20260826,
) -> TrainingResult:
    """Deterministic CPU trainer using in-batch negatives."""

    if user_indices.ndim != 1 or positive_item_indices.ndim != 1:
        raise ValueError("training IDs must be one-dimensional")
    if user_indices.shape != positive_item_indices.shape or user_indices.numel() == 0:
        raise ValueError("training user/item IDs must be non-empty and aligned")
    if history_item_indices is not None and history_item_indices.shape[0] != user_indices.shape[0]:
        raise ValueError("history rows must align with training pairs")
    if epochs < 1 or batch_size < 2 or learning_rate <= 0:
        raise ValueError("epochs, batch_size and learning_rate must be valid")

    _seed_everything(seed)
    model.to("cpu")
    model.train()
    optimizer = torch.optim.Adam(model.parameters(), lr=learning_rate)
    generator = torch.Generator(device="cpu").manual_seed(seed)
    losses: list[float] = []

    for _ in range(epochs):
        permutation = torch.randperm(user_indices.shape[0], generator=generator)
        total_loss = 0.0
        total_rows = 0
        for offset in range(0, permutation.shape[0], batch_size):
            row_ids = permutation[offset : offset + batch_size]
            if row_ids.shape[0] < 2:
                continue
            users = user_indices[row_ids].to("cpu")
            items = positive_item_indices[row_ids].to("cpu")
            histories = history_item_indices[row_ids].to("cpu") if history_item_indices is not None else None
            user_vectors, item_vectors = model(users, items, histories)
            loss = in_batch_softmax_loss(
                user_vectors,
                item_vectors,
                temperature=model.config.temperature,
                positive_item_indices=items,
            )
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            total_loss += float(loss.detach()) * row_ids.shape[0]
            total_rows += row_ids.shape[0]
        if total_rows == 0:
            raise ValueError("at least one training batch must contain two rows")
        losses.append(total_loss / total_rows)
    return TrainingResult(tuple(losses))
