from __future__ import annotations

from typing import Mapping, Sequence

import numpy as np
import torch
from sklearn.feature_extraction import DictVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import FunctionTransformer
from torch import Tensor, nn
from torch.nn import functional as F

from .encoding import FeatureValue, MixedFeatureEncoder, TabularBatch, TabularSchema


DEFAULT_SEED = 20260826


def _ensure_int32_sparse_indices(matrix):
    """Normalize SciPy's platform-dependent sparse index width for sklearn."""

    if hasattr(matrix, "indices") and matrix.indices.dtype != np.int32:
        matrix = matrix.copy()
        matrix.indices = matrix.indices.astype(np.int32)
        matrix.indptr = matrix.indptr.astype(np.int32)
    return matrix


def binary_logit_loss(logits: Tensor, labels: Tensor) -> Tensor:
    if logits.ndim != 1 or labels.shape != logits.shape:
        raise ValueError("logits and labels must be equally sized vectors")
    return F.binary_cross_entropy_with_logits(logits, labels.to(dtype=logits.dtype))


class SklearnLogisticRegressionCTR:
    """Sparse one-hot LR baseline for mixed numeric/categorical records."""

    def __init__(
        self,
        *,
        numeric_names: Sequence[str],
        categorical_names: Sequence[str],
        seed: int = DEFAULT_SEED,
        max_iter: int = 200,
    ) -> None:
        names = tuple(numeric_names) + tuple(categorical_names)
        if not names or len(set(names)) != len(names):
            raise ValueError("declared feature names must be non-empty and unique")
        self.numeric_names = tuple(numeric_names)
        self.categorical_names = tuple(categorical_names)
        self.pipeline = Pipeline(
            [
                ("encode", DictVectorizer(sparse=True, sort=True)),
                ("sparse_index_width", FunctionTransformer(_ensure_int32_sparse_indices)),
                (
                    "model",
                    LogisticRegression(
                        max_iter=max_iter,
                        random_state=seed,
                        solver="liblinear",
                    ),
                ),
            ]
        )

    def _select(self, records: Sequence[Mapping[str, FeatureValue]]) -> list[dict[str, float | str]]:
        selected: list[dict[str, float | str]] = []
        for record in records:
            row: dict[str, float | str] = {}
            row.update({name: float(record[name]) for name in self.numeric_names})
            # Prefix with the value type to prevent accidental collisions such as 1 and "1".
            row.update(
                {
                    name: f"{type(record[name]).__name__}:{record[name]!r}"
                    for name in self.categorical_names
                }
            )
            selected.append(row)
        return selected

    def fit(
        self,
        records: Sequence[Mapping[str, FeatureValue]],
        labels: Sequence[int],
    ) -> "SklearnLogisticRegressionCTR":
        self.pipeline.fit(self._select(records), np.asarray(labels, dtype=np.int64))
        return self

    def predict_proba(self, records: Sequence[Mapping[str, FeatureValue]]) -> np.ndarray:
        return self.pipeline.predict_proba(self._select(records))[:, 1]


class FeedForwardTower(nn.Module):
    def __init__(self, input_dim: int, hidden_dims: Sequence[int]) -> None:
        super().__init__()
        layers: list[nn.Module] = []
        current = input_dim
        for hidden in hidden_dims:
            if hidden < 1:
                raise ValueError("hidden dimensions must be positive")
            layers.extend((nn.Linear(current, hidden), nn.ReLU()))
            current = hidden
        self.network = nn.Sequential(*layers) if layers else nn.Identity()
        self.output_dim = current

    def forward(self, inputs: Tensor) -> Tensor:
        return self.network(inputs)


class DeepFM(nn.Module):
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
        self.schema = schema
        self.embedding_dim = embedding_dim
        self.numeric_linear = nn.Parameter(torch.zeros(len(schema.numeric_names)))
        self.numeric_factors = nn.Parameter(torch.empty(len(schema.numeric_names), embedding_dim))
        nn.init.normal_(self.numeric_factors, mean=0.0, std=0.01)
        self.categorical_linear = nn.ModuleList(
            nn.Embedding(cardinality, 1, padding_idx=0)
            for cardinality in schema.categorical_cardinalities
        )
        self.categorical_factors = nn.ModuleList(
            nn.Embedding(cardinality, embedding_dim, padding_idx=0)
            for cardinality in schema.categorical_cardinalities
        )
        # PyTorch embeddings otherwise start at roughly unit scale. With dozens
        # of fields, the FM pairwise sum then produces very large initial logits
        # and an invalid comparison against LR/DCNv2. Standard DeepFM practice
        # uses a zero first-order term and small latent factors.
        for embedding in self.categorical_linear:
            nn.init.zeros_(embedding.weight)
        for embedding in self.categorical_factors:
            nn.init.normal_(embedding.weight, mean=0.0, std=0.01)
            with torch.no_grad():
                embedding.weight[0].zero_()
        field_count = len(schema.numeric_names) + len(schema.categorical_names)
        self.deep = FeedForwardTower(field_count * embedding_dim, hidden_dims)
        self.deep_output = nn.Linear(self.deep.output_dim, 1)
        self.bias = nn.Parameter(torch.zeros(()))

    def _field_embeddings(self, batch: TabularBatch) -> Tensor:
        numeric = batch.numeric.unsqueeze(-1) * self.numeric_factors.unsqueeze(0)
        categorical = [
            embedding(batch.categorical[:, index]).unsqueeze(1)
            for index, embedding in enumerate(self.categorical_factors)
        ]
        return torch.cat([numeric, *categorical], dim=1) if categorical else numeric

    def forward(self, batch: TabularBatch) -> Tensor:
        batch.validate(self.schema)
        fields = self._field_embeddings(batch)
        first_order = batch.numeric @ self.numeric_linear
        for index, embedding in enumerate(self.categorical_linear):
            first_order = first_order + embedding(batch.categorical[:, index]).squeeze(-1)
        summed = fields.sum(dim=1)
        fm = 0.5 * (summed.square() - fields.square().sum(dim=1)).sum(dim=1)
        deep = self.deep_output(self.deep(fields.flatten(start_dim=1))).squeeze(-1)
        return self.bias + first_order + fm + deep


class CrossNetV2(nn.Module):
    """Full-matrix DCNv2 cross layers."""

    def __init__(self, input_dim: int, depth: int) -> None:
        super().__init__()
        if depth < 1:
            raise ValueError("cross depth must be positive")
        self.weights = nn.ParameterList(
            nn.Parameter(torch.empty(input_dim, input_dim)) for _ in range(depth)
        )
        self.biases = nn.ParameterList(nn.Parameter(torch.zeros(input_dim)) for _ in range(depth))
        for weight in self.weights:
            nn.init.xavier_uniform_(weight)

    def forward(self, inputs: Tensor) -> Tensor:
        crossed = inputs
        for weight, bias in zip(self.weights, self.biases, strict=True):
            crossed = inputs * (F.linear(crossed, weight, bias)) + crossed
        return crossed


class DCNv2(nn.Module):
    def __init__(
        self,
        schema: TabularSchema,
        *,
        embedding_dim: int = 8,
        cross_depth: int = 2,
        hidden_dims: Sequence[int] = (32, 16),
        seed: int = DEFAULT_SEED,
    ) -> None:
        super().__init__()
        torch.manual_seed(seed)
        self.encoder = MixedFeatureEncoder(schema, embedding_dim=embedding_dim)
        self.cross = CrossNetV2(self.encoder.output_dim, cross_depth)
        self.deep = FeedForwardTower(self.encoder.output_dim, hidden_dims)
        self.output = nn.Linear(self.encoder.output_dim + self.deep.output_dim, 1)

    def forward(self, batch: TabularBatch) -> Tensor:
        encoded = self.encoder(batch)
        return self.output(torch.cat((self.cross(encoded), self.deep(encoded)), dim=1)).squeeze(-1)
