from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import Tensor, nn
from torch.nn import functional as F


@dataclass(frozen=True, slots=True)
class TwoTowerConfig:
    num_users: int
    num_items: int
    embedding_dim: int = 32
    hidden_dim: int = 64
    output_dim: int = 32
    temperature: float = 0.07

    def __post_init__(self) -> None:
        if self.num_users < 2 or self.num_items < 2:
            raise ValueError("two-tower vocabularies must contain at least PAD and UNK")
        if min(self.embedding_dim, self.hidden_dim, self.output_dim) < 1:
            raise ValueError("tower dimensions must be positive")
        if self.temperature <= 0:
            raise ValueError("temperature must be positive")


class TwoTower(nn.Module):
    """ID/history user tower and item tower with normalized dot-product output."""

    def __init__(self, config: TwoTowerConfig) -> None:
        super().__init__()
        self.config = config
        self.user_embedding = nn.Embedding(config.num_users, config.embedding_dim)
        self.item_embedding = nn.Embedding(config.num_items, config.embedding_dim, padding_idx=0)
        self.user_mlp = nn.Sequential(
            nn.Linear(config.embedding_dim * 2, config.hidden_dim),
            nn.ReLU(),
            nn.Linear(config.hidden_dim, config.output_dim),
        )
        self.item_mlp = nn.Sequential(
            nn.Linear(config.embedding_dim, config.hidden_dim),
            nn.ReLU(),
            nn.Linear(config.hidden_dim, config.output_dim),
        )

    def encode_users(
        self,
        user_indices: Tensor,
        history_item_indices: Tensor | None = None,
        history_mask: Tensor | None = None,
    ) -> Tensor:
        user = self.user_embedding(user_indices)
        if history_item_indices is None:
            history = torch.zeros_like(user)
        else:
            embedded = self.item_embedding(history_item_indices)
            if history_mask is None:
                history_mask = history_item_indices.ne(0)
            if history_mask.shape != history_item_indices.shape:
                raise ValueError("history_mask must match history_item_indices")
            weights = history_mask.to(dtype=embedded.dtype).unsqueeze(-1)
            history = (embedded * weights).sum(dim=1) / weights.sum(dim=1).clamp_min(1.0)
        return F.normalize(self.user_mlp(torch.cat((user, history), dim=-1)), dim=-1)

    def encode_items(self, item_indices: Tensor) -> Tensor:
        return F.normalize(self.item_mlp(self.item_embedding(item_indices)), dim=-1)

    def forward(
        self,
        user_indices: Tensor,
        positive_item_indices: Tensor,
        history_item_indices: Tensor | None = None,
        history_mask: Tensor | None = None,
    ) -> tuple[Tensor, Tensor]:
        return (
            self.encode_users(user_indices, history_item_indices, history_mask),
            self.encode_items(positive_item_indices),
        )


def in_batch_softmax_loss(
    user_vectors: Tensor,
    positive_item_vectors: Tensor,
    *,
    temperature: float,
    positive_item_indices: Tensor | None = None,
) -> Tensor:
    """Multi-positive InfoNCE; other batch items are negatives.

    Repeated positive item IDs are treated as additional positives instead of
    accidental false negatives.
    """

    if user_vectors.ndim != 2 or positive_item_vectors.ndim != 2:
        raise ValueError("tower outputs must be rank-two tensors")
    if user_vectors.shape != positive_item_vectors.shape:
        raise ValueError("user and positive item vectors must have equal shape")
    if temperature <= 0:
        raise ValueError("temperature must be positive")
    logits = user_vectors @ positive_item_vectors.T / temperature
    if positive_item_indices is None:
        positive_mask = torch.eye(logits.shape[0], dtype=torch.bool, device=logits.device)
    else:
        if positive_item_indices.ndim != 1 or positive_item_indices.shape[0] != logits.shape[0]:
            raise ValueError("positive_item_indices must contain one ID per row")
        positive_mask = positive_item_indices[:, None].eq(positive_item_indices[None, :])
    positive_logits = logits.masked_fill(~positive_mask, float("-inf"))
    return (torch.logsumexp(logits, dim=1) - torch.logsumexp(positive_logits, dim=1)).mean()
