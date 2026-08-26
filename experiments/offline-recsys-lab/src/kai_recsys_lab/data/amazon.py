from __future__ import annotations

import csv
from pathlib import Path

from ..contracts import DataOrigin, RetrievalExample, Split


REQUIRED_COLUMNS = {"user_id", "parent_asin", "timestamp"}


def load_amazon_processed_csv(
    path: str | Path,
    *,
    split: Split,
    origin: DataOrigin = DataOrigin.PUBLIC,
    limit: int | None = None,
) -> list[RetrievalExample]:
    """Read an official Amazon Reviews'23 processed IDs CSV.

    The review is an implicit interaction proxy, not an impression or click.
    `history`, when present, is the timestamp-safe history supplied by the
    official processed split.
    """

    if limit is not None and limit < 1:
        raise ValueError("limit must be positive")
    result: list[RetrievalExample] = []
    with Path(path).open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        missing = REQUIRED_COLUMNS.difference(reader.fieldnames or ())
        if missing:
            raise ValueError(f"Amazon CSV is missing columns: {sorted(missing)}")
        for row in reader:
            history = tuple(part for part in (row.get("history") or "").split() if part)
            result.append(
                RetrievalExample(
                    user_id=row["user_id"],
                    item_id=row["parent_asin"],
                    timestamp_ms=int(row["timestamp"]),
                    split=split,
                    origin=origin,
                    history_item_ids=history,
                )
            )
            if limit is not None and len(result) >= limit:
                break
    return result
