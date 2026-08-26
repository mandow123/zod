from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import Tensor, nn


@dataclass(frozen=True, slots=True)
class SequenceOutput:
    logits: Tensor
    interest_vector: Tensor
    attention_weights: Tensor


def _validate_inputs(history_item_indices: Tensor, candidate_item_indices: Tensor) -> None:
    if history_item_indices.ndim != 2:
        raise ValueError("history_item_indices must have shape [batch, sequence]")
    if candidate_item_indices.ndim != 1 or candidate_item_indices.shape[0] != history_item_indices.shape[0]:
        raise ValueError("candidate_item_indices must have one item per history row")


class _SequenceScorerBase(nn.Module):
    def __init__(self, num_items: int, embedding_dim: int, hidden_dim: int) -> None:
        super().__init__()
        if min(num_items, embedding_dim, hidden_dim) < 2:
            raise ValueError("sequence-model dimensions must be at least two")
        self.item_embedding = nn.Embedding(num_items, embedding_dim, padding_idx=0)
        self.scorer = nn.Sequential(
            nn.Linear(embedding_dim * 4, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, 1),
        )

    def _score(self, interest: Tensor, candidate: Tensor) -> Tensor:
        features = torch.cat((interest, candidate, interest - candidate, interest * candidate), dim=-1)
        return self.scorer(features).squeeze(-1)


class MeanPoolingSequenceScorer(_SequenceScorerBase):
    """Candidate-independent mean-history comparison baseline."""

    def forward(self, history_item_indices: Tensor, candidate_item_indices: Tensor) -> SequenceOutput:
        _validate_inputs(history_item_indices, candidate_item_indices)
        history = self.item_embedding(history_item_indices)
        candidate = self.item_embedding(candidate_item_indices)
        mask = history_item_indices.ne(0)
        weights = mask.to(dtype=history.dtype)
        normalized = weights / weights.sum(dim=1, keepdim=True).clamp_min(1.0)
        interest = (history * normalized.unsqueeze(-1)).sum(dim=1)
        return SequenceOutput(self._score(interest, candidate), interest, normalized)


class DinSequenceScorer(_SequenceScorerBase):
    """DIN-style target-aware attention over a user's item history."""

    def __init__(self, num_items: int, embedding_dim: int = 32, hidden_dim: int = 64, attention_dim: int = 32) -> None:
        super().__init__(num_items, embedding_dim, hidden_dim)
        if attention_dim < 1:
            raise ValueError("attention_dim must be positive")
        self.attention = nn.Sequential(
            nn.Linear(embedding_dim * 4, attention_dim),
            nn.ReLU(),
            nn.Linear(attention_dim, 1),
        )

    def forward(self, history_item_indices: Tensor, candidate_item_indices: Tensor) -> SequenceOutput:
        _validate_inputs(history_item_indices, candidate_item_indices)
        history = self.item_embedding(history_item_indices)
        candidate = self.item_embedding(candidate_item_indices)
        expanded_candidate = candidate.unsqueeze(1).expand_as(history)
        attention_features = torch.cat(
            (history, expanded_candidate, history - expanded_candidate, history * expanded_candidate),
            dim=-1,
        )
        raw_logits = self.attention(attention_features).squeeze(-1)
        mask = history_item_indices.ne(0)
        raw_weights = torch.softmax(raw_logits.masked_fill(~mask, -1e9), dim=1) * mask.to(raw_logits.dtype)
        weights = raw_weights / raw_weights.sum(dim=1, keepdim=True).clamp_min(1e-12)
        interest = (history * weights.unsqueeze(-1)).sum(dim=1)
        return SequenceOutput(self._score(interest, candidate), interest, weights)
