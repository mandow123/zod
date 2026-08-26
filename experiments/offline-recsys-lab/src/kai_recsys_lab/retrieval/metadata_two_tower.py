from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import Tensor, nn
from torch.nn import functional as F


@dataclass(frozen=True, slots=True)
class MetadataTwoTowerConfig:
    num_users: int
    num_items: int
    metadata_vocabulary_size: int
    embedding_dim: int = 32
    hidden_dim: int = 64
    output_dim: int = 32
    temperature: float = 0.07

    def __post_init__(self) -> None:
        if min(self.num_users, self.num_items, self.metadata_vocabulary_size) < 2:
            raise ValueError("two-tower vocabularies must contain at least PAD and UNK")
        if min(self.embedding_dim, self.hidden_dim, self.output_dim) < 1:
            raise ValueError("tower dimensions must be positive")
        if self.temperature <= 0:
            raise ValueError("temperature must be positive")


class MetadataTwoTower(nn.Module):
    """ID/history tower with title and category metadata in the item tower.

    Metadata token matrices are immutable buffers aligned with the item ID
    vocabulary. They therefore travel with checkpoints without becoming
    trainable identity features.
    """

    def __init__(
        self,
        config: MetadataTwoTowerConfig,
        *,
        title_token_ids: Tensor,
        category_token_ids: Tensor,
    ) -> None:
        super().__init__()
        if title_token_ids.ndim != 2 or category_token_ids.ndim != 2:
            raise ValueError("metadata token matrices must be rank two")
        if title_token_ids.shape[0] != config.num_items or category_token_ids.shape[0] != config.num_items:
            raise ValueError("metadata rows must align with the item vocabulary")
        if title_token_ids.dtype != torch.long or category_token_ids.dtype != torch.long:
            raise ValueError("metadata token IDs must use torch.long")
        if int(title_token_ids.max()) >= config.metadata_vocabulary_size:
            raise ValueError("title token ID is outside the metadata vocabulary")
        if int(category_token_ids.max()) >= config.metadata_vocabulary_size:
            raise ValueError("category token ID is outside the metadata vocabulary")

        self.config = config
        self.register_buffer("title_token_ids", title_token_ids.clone(), persistent=True)
        self.register_buffer("category_token_ids", category_token_ids.clone(), persistent=True)
        self.user_embedding = nn.Embedding(config.num_users, config.embedding_dim, padding_idx=0)
        self.item_id_embedding = nn.Embedding(config.num_items, config.embedding_dim, padding_idx=0)
        self.metadata_embedding = nn.Embedding(
            config.metadata_vocabulary_size,
            config.embedding_dim,
            padding_idx=0,
        )
        self.user_mlp = nn.Sequential(
            nn.Linear(config.embedding_dim * 4, config.hidden_dim),
            nn.ReLU(),
            nn.Linear(config.hidden_dim, config.output_dim),
        )
        self.item_mlp = nn.Sequential(
            nn.Linear(config.embedding_dim * 3, config.hidden_dim),
            nn.ReLU(),
            nn.Linear(config.hidden_dim, config.output_dim),
        )

    def _mean_metadata(self, token_ids: Tensor) -> Tensor:
        embedded = self.metadata_embedding(token_ids)
        mask = token_ids.ne(0).to(dtype=embedded.dtype).unsqueeze(-1)
        return (embedded * mask).sum(dim=-2) / mask.sum(dim=-2).clamp_min(1.0)

    def item_features(self, item_indices: Tensor) -> Tensor:
        ids = self.item_id_embedding(item_indices)
        title = self._mean_metadata(self.title_token_ids[item_indices])
        category = self._mean_metadata(self.category_token_ids[item_indices])
        return torch.cat((ids, title, category), dim=-1)

    def encode_items(self, item_indices: Tensor) -> Tensor:
        return F.normalize(self.item_mlp(self.item_features(item_indices)), dim=-1)

    def encode_users(
        self,
        user_indices: Tensor,
        history_item_indices: Tensor | None = None,
        history_mask: Tensor | None = None,
    ) -> Tensor:
        user = self.user_embedding(user_indices)
        if history_item_indices is None:
            history = torch.zeros(
                (*user.shape[:-1], self.config.embedding_dim * 3),
                dtype=user.dtype,
                device=user.device,
            )
        else:
            if history_mask is None:
                history_mask = history_item_indices.ne(0)
            if history_mask.shape != history_item_indices.shape:
                raise ValueError("history_mask must match history_item_indices")
            features = self.item_features(history_item_indices)
            weights = history_mask.to(dtype=features.dtype).unsqueeze(-1)
            history = (features * weights).sum(dim=1) / weights.sum(dim=1).clamp_min(1.0)
        return F.normalize(self.user_mlp(torch.cat((user, history), dim=-1)), dim=-1)

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
