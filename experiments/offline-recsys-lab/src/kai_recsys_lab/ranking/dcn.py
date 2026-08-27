from __future__ import annotations

import math
from dataclasses import dataclass

import torch
from torch import Tensor, nn


@dataclass(frozen=True, slots=True)
class DcnRerankerConfig:
    vector_dim: int
    dense_feature_dim: int
    hidden_dims: tuple[int, ...]
    cross_layers: int = 2
    dropout: float = 0.0

    def __post_init__(self) -> None:
        if min(self.vector_dim, self.dense_feature_dim, self.cross_layers) < 1 or not self.hidden_dims:
            raise ValueError("DCN dimensions and cross layer count must be positive")
        if any(width < 1 for width in self.hidden_dims) or not 0.0 <= self.dropout < 1.0:
            raise ValueError("DCN hidden dimensions and dropout are invalid")


class _CrossLayer(nn.Module):
    def __init__(self, width: int) -> None:
        super().__init__()
        self.weight = nn.Parameter(torch.empty(width))
        self.bias = nn.Parameter(torch.zeros(width))
        nn.init.normal_(self.weight, std=0.01)

    def forward(self, original: Tensor, current: Tensor) -> Tensor:
        projection = (current * self.weight).sum(dim=1, keepdim=True)
        return original * projection + self.bias + current


class DcnStyleReranker(nn.Module):
    """DCN-style scorer over the same frozen user/item/history feature contract as DIN."""

    def __init__(self, config: DcnRerankerConfig) -> None:
        super().__init__()
        self.config = config
        input_dim = config.vector_dim * 5 + config.dense_feature_dim
        self.cross = nn.ModuleList(_CrossLayer(input_dim) for _ in range(config.cross_layers))
        deep_layers: list[nn.Module] = []
        previous = input_dim
        for width in config.hidden_dims:
            deep_layers.extend((nn.Linear(previous, width), nn.ReLU()))
            if config.dropout:
                deep_layers.append(nn.Dropout(config.dropout))
            previous = width
        self.deep = nn.Sequential(*deep_layers)
        self.output = nn.Linear(input_dim + previous, 1)

    def forward(
        self,
        user_vectors: Tensor,
        item_vectors: Tensor,
        history_vectors: Tensor,
        history_mask: Tensor,
        dense_features: Tensor,
    ) -> Tensor:
        batch = user_vectors.shape[0]
        expected_vector = (batch, self.config.vector_dim)
        if user_vectors.shape != expected_vector or item_vectors.shape != expected_vector:
            raise ValueError("DCN user and item vectors do not match the frozen dimension")
        if history_vectors.ndim != 3 or history_vectors.shape[:2] != history_mask.shape:
            raise ValueError("DCN history vectors and mask must align")
        if history_vectors.shape[0] != batch or history_vectors.shape[2] != self.config.vector_dim:
            raise ValueError("DCN history vectors do not match the frozen dimension")
        if dense_features.shape != (batch, self.config.dense_feature_dim):
            raise ValueError("DCN dense features do not match the frozen contract")
        mask = history_mask.to(dtype=torch.bool)
        attention_logits = (history_vectors * item_vectors[:, None, :]).sum(dim=2) / math.sqrt(self.config.vector_dim)
        attention_logits = attention_logits.masked_fill(~mask, -1.0e9)
        attention = torch.softmax(attention_logits, dim=1) * mask.to(dtype=history_vectors.dtype)
        attention = attention / attention.sum(dim=1, keepdim=True).clamp_min(1.0e-12)
        attended = (attention[:, :, None] * history_vectors).sum(dim=1)
        original = torch.cat(
            (user_vectors, item_vectors, user_vectors * item_vectors, attended, attended * item_vectors, dense_features),
            dim=1,
        )
        crossed = original
        for layer in self.cross:
            crossed = layer(original, crossed)
        return self.output(torch.cat((crossed, self.deep(original)), dim=1)).squeeze(1)
