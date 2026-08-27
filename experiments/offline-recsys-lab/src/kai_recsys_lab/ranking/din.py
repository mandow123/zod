from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

import numpy as np
import torch
from torch import Tensor, nn


@dataclass(frozen=True, slots=True)
class DinRerankerConfig:
    vector_dim: int
    dense_feature_dim: int
    hidden_dims: tuple[int, ...]
    dropout: float = 0.0

    def __post_init__(self) -> None:
        if self.vector_dim < 1 or self.dense_feature_dim < 1 or not self.hidden_dims:
            raise ValueError("DIN dimensions must be positive")
        if any(width < 1 for width in self.hidden_dims) or not 0.0 <= self.dropout < 1.0:
            raise ValueError("DIN hidden dimensions and dropout are invalid")


class DinStyleReranker(nn.Module):
    """DIN-style frozen-vector scorer; only the interaction MLP is trainable."""

    def __init__(self, config: DinRerankerConfig) -> None:
        super().__init__()
        self.config = config
        input_dim = config.vector_dim * 5 + config.dense_feature_dim
        layers: list[nn.Module] = []
        previous = input_dim
        for width in config.hidden_dims:
            layers.extend((nn.Linear(previous, width), nn.ReLU()))
            if config.dropout:
                layers.append(nn.Dropout(config.dropout))
            previous = width
        layers.append(nn.Linear(previous, 1))
        self.network = nn.Sequential(*layers)

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
            raise ValueError("DIN user and item vectors do not match the frozen dimension")
        if history_vectors.ndim != 3 or history_vectors.shape[:2] != history_mask.shape:
            raise ValueError("DIN history vectors and mask must align")
        if history_vectors.shape[0] != batch or history_vectors.shape[2] != self.config.vector_dim:
            raise ValueError("DIN history vectors do not match the frozen dimension")
        if dense_features.shape != (batch, self.config.dense_feature_dim):
            raise ValueError("DIN dense features do not match the frozen contract")
        mask = history_mask.to(dtype=torch.bool)
        attention_logits = (history_vectors * item_vectors[:, None, :]).sum(dim=2) / math.sqrt(self.config.vector_dim)
        attention_logits = attention_logits.masked_fill(~mask, -1.0e9)
        attention = torch.softmax(attention_logits, dim=1) * mask.to(dtype=history_vectors.dtype)
        attention = attention / attention.sum(dim=1, keepdim=True).clamp_min(1.0e-12)
        attended = (attention[:, :, None] * history_vectors).sum(dim=1)
        features = torch.cat(
            (user_vectors, item_vectors, user_vectors * item_vectors, attended, attended * item_vectors, dense_features),
            dim=1,
        )
        return self.network(features).squeeze(1)


@dataclass(frozen=True, slots=True)
class TemperatureCalibration:
    temperature: float
    log_loss: float
    brier: float
    example_count: int


def calibrated_probabilities(logits: np.ndarray, temperature: float) -> np.ndarray:
    values = np.asarray(logits, dtype=np.float64)
    if values.ndim != 1 or not np.isfinite(values).all() or not math.isfinite(temperature) or temperature <= 0:
        raise ValueError("calibration requires finite logits and a positive temperature")
    scaled = np.clip(values / temperature, -40.0, 40.0)
    return 1.0 / (1.0 + np.exp(-scaled))


def fit_temperature(
    logits: np.ndarray,
    labels: np.ndarray,
    grid: Sequence[float],
) -> TemperatureCalibration:
    values = np.asarray(logits, dtype=np.float64)
    truth = np.asarray(labels, dtype=np.float64)
    candidates = tuple(float(value) for value in grid)
    if values.ndim != 1 or truth.shape != values.shape or values.size == 0:
        raise ValueError("calibration logits and labels must be non-empty and aligned")
    if not np.isfinite(values).all() or not np.isin(truth, (0.0, 1.0)).all() or len(np.unique(truth)) != 2:
        raise ValueError("calibration requires finite binary examples from both classes")
    if not candidates or any(not math.isfinite(value) or value <= 0 for value in candidates):
        raise ValueError("temperature grid must contain positive finite values")
    rows: list[tuple[float, float, float]] = []
    for temperature in candidates:
        probabilities = calibrated_probabilities(values, temperature)
        clipped = np.clip(probabilities, 1.0e-12, 1.0 - 1.0e-12)
        log_loss = float(-np.mean(truth * np.log(clipped) + (1.0 - truth) * np.log(1.0 - clipped)))
        brier = float(np.mean((probabilities - truth) ** 2))
        rows.append((log_loss, temperature, brier))
    log_loss, temperature, brier = min(rows)
    return TemperatureCalibration(temperature, log_loss, brier, int(values.size))
