from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
from typing import Mapping


class DataOrigin(StrEnum):
    PUBLIC = "public"
    SYNTHETIC = "synthetic"


class Split(StrEnum):
    TRAIN = "train"
    DEV = "dev"
    TEST = "test"


def _frozen_features(features: Mapping[str, float | int | str]) -> Mapping[str, float | int | str]:
    return MappingProxyType(dict(features))


@dataclass(frozen=True, slots=True)
class RetrievalExample:
    user_id: str
    item_id: str
    timestamp_ms: int
    split: Split
    origin: DataOrigin
    history_item_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.user_id or not self.item_id:
            raise ValueError("retrieval examples require non-empty user and item ids")
        if self.timestamp_ms <= 0:
            raise ValueError("timestamp_ms must be positive")


@dataclass(frozen=True, slots=True)
class BinaryExample:
    example_id: str
    timestamp_ms: int
    split: Split
    origin: DataOrigin
    label: int
    features: Mapping[str, float | int | str]
    clicked: int | None = None
    converted: int | None = None
    value: float | None = None
    position: int | None = None
    propensity: float | None = None

    def __post_init__(self) -> None:
        if not self.example_id:
            raise ValueError("example_id is required")
        if self.timestamp_ms <= 0:
            raise ValueError("timestamp_ms must be positive")
        for name, value in (("label", self.label), ("clicked", self.clicked), ("converted", self.converted)):
            if value is not None and value not in (0, 1):
                raise ValueError(f"{name} must be binary")
        if self.converted == 1 and self.clicked == 0:
            raise ValueError("a conversion cannot follow a known non-click")
        if self.value is not None and self.value < 0:
            raise ValueError("value must be non-negative")
        if self.position is not None and self.position < 1:
            raise ValueError("position is one-indexed")
        if self.propensity is not None and not 0 < self.propensity <= 1:
            raise ValueError("propensity must be in (0, 1]")
        object.__setattr__(self, "features", _frozen_features(self.features))
