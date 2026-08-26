from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True, slots=True)
class IdVocabulary:
    """A deterministic closed-world identifier vocabulary.

    Index zero is padding and index one is unknown. Sorting identifiers keeps
    synthetic tests and public-data preprocessing reproducible.
    """

    ids: tuple[str, ...]

    PAD = "<PAD>"
    UNK = "<UNK>"

    def __post_init__(self) -> None:
        if len(self.ids) < 2 or self.ids[:2] != (self.PAD, self.UNK):
            raise ValueError("vocabulary must reserve PAD and UNK at indexes 0 and 1")
        if len(set(self.ids)) != len(self.ids):
            raise ValueError("vocabulary identifiers must be unique")

    @classmethod
    def build(cls, identifiers: Iterable[str]) -> IdVocabulary:
        reserved = {cls.PAD, cls.UNK}
        values = tuple(sorted({identifier for identifier in identifiers if identifier and identifier not in reserved}))
        return cls((cls.PAD, cls.UNK, *values))

    @property
    def size(self) -> int:
        return len(self.ids)

    def index(self, identifier: str) -> int:
        try:
            return self.ids.index(identifier)
        except ValueError:
            return 1

    def identifier(self, index: int) -> str:
        if index < 0 or index >= len(self.ids):
            raise IndexError(index)
        return self.ids[index]

    def encode(self, identifiers: Iterable[str]) -> tuple[int, ...]:
        lookup = {identifier: index for index, identifier in enumerate(self.ids)}
        return tuple(lookup.get(identifier, 1) for identifier in identifiers)
