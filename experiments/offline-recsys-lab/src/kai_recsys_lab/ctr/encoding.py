from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

import torch
from torch import Tensor, nn


FeatureValue = float | int | str


@dataclass(frozen=True, slots=True)
class TabularSchema:
    """Index-level contract shared by the offline Torch CTR/CVR models.

    Categorical cardinalities include index 0, which is reserved for unknown
    values.  This keeps public-data adapters separate from model code and makes
    unseen categories fail safe instead of indexing outside an embedding.
    """

    numeric_names: tuple[str, ...]
    categorical_names: tuple[str, ...]
    categorical_cardinalities: tuple[int, ...]

    def __post_init__(self) -> None:
        if len(set(self.numeric_names + self.categorical_names)) != len(
            self.numeric_names + self.categorical_names
        ):
            raise ValueError("feature names must be unique")
        if len(self.categorical_names) != len(self.categorical_cardinalities):
            raise ValueError("each categorical feature needs a cardinality")
        if any(cardinality < 2 for cardinality in self.categorical_cardinalities):
            raise ValueError("categorical cardinality must include unknown plus one known value")
        if not self.numeric_names and not self.categorical_names:
            raise ValueError("at least one feature is required")


@dataclass(frozen=True, slots=True)
class TabularBatch:
    numeric: Tensor
    categorical: Tensor

    @property
    def batch_size(self) -> int:
        return int(self.numeric.shape[0])

    def validate(self, schema: TabularSchema) -> None:
        if self.numeric.ndim != 2 or self.categorical.ndim != 2:
            raise ValueError("numeric and categorical tensors must be rank two")
        if self.numeric.shape[0] != self.categorical.shape[0]:
            raise ValueError("numeric and categorical batch sizes differ")
        if self.numeric.shape[1] != len(schema.numeric_names):
            raise ValueError("numeric tensor does not match schema")
        if self.categorical.shape[1] != len(schema.categorical_names):
            raise ValueError("categorical tensor does not match schema")
        if not torch.is_floating_point(self.numeric):
            raise ValueError("numeric tensor must be floating point")
        if self.categorical.dtype != torch.long:
            raise ValueError("categorical tensor must use torch.long indices")
        if not torch.isfinite(self.numeric).all():
            raise ValueError("numeric features must be finite")
        for column, cardinality in enumerate(schema.categorical_cardinalities):
            values = self.categorical[:, column]
            if values.numel() and (int(values.min()) < 0 or int(values.max()) >= cardinality):
                raise ValueError(f"categorical feature {schema.categorical_names[column]} is out of range")


class VocabularyFeatureEncoder:
    """Deterministic records-to-index adapter for small offline experiments."""

    def __init__(
        self,
        *,
        numeric_names: Sequence[str],
        categorical_names: Sequence[str],
        vocabularies: Mapping[str, Mapping[str, int]],
    ) -> None:
        self.numeric_names = tuple(numeric_names)
        self.categorical_names = tuple(categorical_names)
        self.vocabularies = {
            name: dict(vocabularies[name]) for name in self.categorical_names
        }
        self.schema = TabularSchema(
            numeric_names=self.numeric_names,
            categorical_names=self.categorical_names,
            categorical_cardinalities=tuple(len(self.vocabularies[name]) + 1 for name in self.categorical_names),
        )

    @staticmethod
    def _category_key(value: FeatureValue) -> str:
        return f"{type(value).__name__}:{value!r}"

    @classmethod
    def fit(
        cls,
        records: Sequence[Mapping[str, FeatureValue]],
        *,
        numeric_names: Sequence[str],
        categorical_names: Sequence[str],
    ) -> "VocabularyFeatureEncoder":
        if not records:
            raise ValueError("cannot fit an encoder without records")
        vocabularies: dict[str, dict[str, int]] = {}
        for name in categorical_names:
            keys = sorted({cls._category_key(record[name]) for record in records})
            vocabularies[name] = {key: index + 1 for index, key in enumerate(keys)}
        encoder = cls(
            numeric_names=numeric_names,
            categorical_names=categorical_names,
            vocabularies=vocabularies,
        )
        # Validate declared numeric fields during fit rather than failing later.
        encoder.transform(records)
        return encoder

    def transform(self, records: Sequence[Mapping[str, FeatureValue]]) -> TabularBatch:
        numeric_rows: list[list[float]] = []
        categorical_rows: list[list[int]] = []
        for record in records:
            numeric_row = [float(record[name]) for name in self.numeric_names]
            categorical_row = [
                self.vocabularies[name].get(self._category_key(record[name]), 0)
                for name in self.categorical_names
            ]
            numeric_rows.append(numeric_row)
            categorical_rows.append(categorical_row)
        numeric = torch.tensor(numeric_rows, dtype=torch.float32).reshape(
            len(records), len(self.numeric_names)
        )
        categorical = torch.tensor(categorical_rows, dtype=torch.long).reshape(
            len(records), len(self.categorical_names)
        )
        batch = TabularBatch(numeric=numeric, categorical=categorical)
        batch.validate(self.schema)
        return batch


class MixedFeatureEncoder(nn.Module):
    """Concatenate numeric values with categorical embeddings."""

    def __init__(self, schema: TabularSchema, embedding_dim: int = 8) -> None:
        super().__init__()
        if embedding_dim < 1:
            raise ValueError("embedding_dim must be positive")
        self.schema = schema
        self.embedding_dim = embedding_dim
        self.embeddings = nn.ModuleList(
            nn.Embedding(cardinality, embedding_dim, padding_idx=0)
            for cardinality in schema.categorical_cardinalities
        )
        self.output_dim = len(schema.numeric_names) + len(schema.categorical_names) * embedding_dim

    def forward(self, batch: TabularBatch) -> Tensor:
        batch.validate(self.schema)
        parts = [batch.numeric]
        parts.extend(
            embedding(batch.categorical[:, index])
            for index, embedding in enumerate(self.embeddings)
        )
        return torch.cat(parts, dim=1)
