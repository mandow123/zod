from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import torch
from torch import Tensor, nn
from torch.nn import functional as F

from kai_recsys_lab.ctr.encoding import MixedFeatureEncoder, TabularBatch, TabularSchema
from kai_recsys_lab.ctr.models import DEFAULT_SEED, FeedForwardTower


def _probability_bce(probability: Tensor, labels: Tensor) -> Tensor:
    epsilon = torch.finfo(probability.dtype).eps
    bounded = probability.clamp(min=epsilon, max=1.0 - epsilon)
    return F.binary_cross_entropy(bounded, labels.to(dtype=probability.dtype))


class NaivePostClickCVR(nn.Module):
    """Naive CVR tower trained only on clicked impressions.

    This baseline deliberately does not correct sample-selection bias; the name
    and masked loss keep that limitation explicit in every call site.
    """

    def __init__(
        self,
        schema: TabularSchema,
        *,
        embedding_dim: int = 8,
        hidden_dims: Sequence[int] = (32, 16),
        seed: int = DEFAULT_SEED,
    ) -> None:
        super().__init__()
        torch.manual_seed(seed)
        self.encoder = MixedFeatureEncoder(schema, embedding_dim=embedding_dim)
        self.tower = FeedForwardTower(self.encoder.output_dim, hidden_dims)
        self.output = nn.Linear(self.tower.output_dim, 1)

    def forward(self, batch: TabularBatch) -> Tensor:
        encoded = self.encoder(batch)
        return self.output(self.tower(encoded)).squeeze(-1)


def post_click_cvr_loss(logits: Tensor, clicked: Tensor, converted: Tensor) -> Tensor:
    if logits.ndim != 1 or clicked.shape != logits.shape or converted.shape != logits.shape:
        raise ValueError("logits, clicked and converted must be equally sized vectors")
    if torch.any((clicked != 0) & (clicked != 1)) or torch.any((converted != 0) & (converted != 1)):
        raise ValueError("clicked and converted must be binary")
    if torch.any((converted == 1) & (clicked == 0)):
        raise ValueError("conversion cannot be positive when click is zero")
    mask = clicked == 1
    if not bool(mask.any()):
        raise ValueError("post-click CVR loss requires at least one clicked example")
    return F.binary_cross_entropy_with_logits(
        logits[mask], converted[mask].to(dtype=logits.dtype)
    )


@dataclass(frozen=True, slots=True)
class ESMMOutput:
    ctr_probability: Tensor
    ctcvr_probability: Tensor

    def inferred_cvr(self, *, epsilon: float | None = None) -> Tensor:
        """Infer P(conversion|click) using a stable, bounded ratio."""

        if epsilon is None:
            epsilon = torch.finfo(self.ctr_probability.dtype).eps
        denominator = self.ctr_probability.clamp_min(epsilon)
        return (self.ctcvr_probability / denominator).clamp(min=0.0, max=1.0)


class ESMM(nn.Module):
    """Entire-space multi-task model supervised by CTR and CTCVR labels.

    One shared feature representation feeds distinct CTR and conditional-CVR
    towers.  The observed conversion probability is constrained to
    P(CTCVR)=P(CTR)*P(CVR), while callers derive CVR through ``ESMMOutput``.
    """

    def __init__(
        self,
        schema: TabularSchema,
        *,
        embedding_dim: int = 8,
        hidden_dims: Sequence[int] = (32, 16),
        seed: int = DEFAULT_SEED,
    ) -> None:
        super().__init__()
        torch.manual_seed(seed)
        self.shared_encoder = MixedFeatureEncoder(schema, embedding_dim=embedding_dim)
        self.ctr_tower = FeedForwardTower(self.shared_encoder.output_dim, hidden_dims)
        self.cvr_tower = FeedForwardTower(self.shared_encoder.output_dim, hidden_dims)
        self.ctr_output = nn.Linear(self.ctr_tower.output_dim, 1)
        self.cvr_output = nn.Linear(self.cvr_tower.output_dim, 1)

    def forward(self, batch: TabularBatch) -> ESMMOutput:
        shared = self.shared_encoder(batch)
        ctr_probability = torch.sigmoid(self.ctr_output(self.ctr_tower(shared)).squeeze(-1))
        conditional_cvr = torch.sigmoid(self.cvr_output(self.cvr_tower(shared)).squeeze(-1))
        return ESMMOutput(
            ctr_probability=ctr_probability,
            ctcvr_probability=ctr_probability * conditional_cvr,
        )


def esmm_loss(
    output: ESMMOutput,
    clicked: Tensor,
    converted: Tensor,
    *,
    ctr_weight: float = 1.0,
    ctcvr_weight: float = 1.0,
) -> Tensor:
    if clicked.shape != output.ctr_probability.shape or converted.shape != clicked.shape:
        raise ValueError("ESMM predictions and labels must be equally sized vectors")
    if ctr_weight < 0 or ctcvr_weight < 0 or ctr_weight + ctcvr_weight <= 0:
        raise ValueError("ESMM loss weights must be non-negative with a positive sum")
    if torch.any((clicked != 0) & (clicked != 1)) or torch.any((converted != 0) & (converted != 1)):
        raise ValueError("clicked and converted must be binary")
    if torch.any((converted == 1) & (clicked == 0)):
        raise ValueError("conversion cannot be positive when click is zero")
    ctr = _probability_bce(output.ctr_probability, clicked)
    ctcvr = _probability_bce(output.ctcvr_probability, converted)
    return ctr_weight * ctr + ctcvr_weight * ctcvr
