from __future__ import annotations

import csv
from pathlib import Path

from ..contracts import BinaryExample, DataOrigin, Split


DISPLAY_INTEGER_FEATURES = 13
DISPLAY_CATEGORICAL_FEATURES = 26
SPONSORED_COLUMNS = (
    "sale",
    "sales_amount_euro",
    "conversion_delay",
    "click_timestamp",
    "clicks_1week",
    "product_price",
    "product_age_group",
    "device_type",
    "audience_id",
    "product_gender",
    "product_brand",
    *(f"product_category_{index}" for index in range(1, 8)),
    "product_country",
    "product_id",
    "product_title",
    "partner_id",
    "user_id",
)


def _number(value: str) -> float:
    if value in ("", "-1"):
        return 0.0
    return float(value)


def load_criteo_display_tsv(
    path: str | Path,
    *,
    split: Split,
    origin: DataOrigin = DataOrigin.PUBLIC,
    limit: int | None = None,
) -> list[BinaryExample]:
    """Read Criteo Display rows without inventing a wall-clock timestamp.

    The challenge file has no public event timestamp, so one-indexed source row
    order is stored in `timestamp_ms` only as deterministic ordering metadata.
    Callers must not describe this as a chronological split.
    """

    result: list[BinaryExample] = []
    expected = 1 + DISPLAY_INTEGER_FEATURES + DISPLAY_CATEGORICAL_FEATURES
    with Path(path).open(newline="", encoding="utf-8") as handle:
        for row_number, row in enumerate(csv.reader(handle, delimiter="\t"), start=1):
            if len(row) != expected:
                raise ValueError(f"Criteo Display row {row_number} has {len(row)} fields; expected {expected}")
            label = int(row[0])
            features: dict[str, float | str] = {
                f"int_{index + 1}": _number(value)
                for index, value in enumerate(row[1 : 1 + DISPLAY_INTEGER_FEATURES])
            }
            features.update(
                {
                    f"cat_{index + 1}": value or "__MISSING__"
                    for index, value in enumerate(row[1 + DISPLAY_INTEGER_FEATURES :])
                }
            )
            result.append(
                BinaryExample(
                    example_id=f"display-row-{row_number}",
                    timestamp_ms=row_number,
                    split=split,
                    origin=origin,
                    label=label,
                    clicked=label,
                    features=features,
                )
            )
            if limit is not None and len(result) >= limit:
                break
    return result


def load_criteo_sponsored_search_tsv(
    path: str | Path,
    *,
    split: Split,
    origin: DataOrigin = DataOrigin.PUBLIC,
    limit: int | None = None,
) -> list[BinaryExample]:
    """Read Criteo Sponsored Search click rows for post-click conversion.

    Every source row is already a click. This reader therefore cannot be used
    to train an impression-space CTR model.
    """

    result: list[BinaryExample] = []
    with Path(path).open(newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle, delimiter="\t")
        for row_number, row in enumerate(reader, start=1):
            if len(row) != len(SPONSORED_COLUMNS):
                raise ValueError(
                    f"Criteo Sponsored Search row {row_number} has {len(row)} fields; "
                    f"expected {len(SPONSORED_COLUMNS)}"
                )
            raw = dict(zip(SPONSORED_COLUMNS, row, strict=True))
            converted = int(raw.pop("sale"))
            value = _number(raw.pop("sales_amount_euro")) if converted else 0.0
            # This outcome is observed only after conversion and would leak the
            # label into a conversion model. Keep it out of training features.
            raw.pop("conversion_delay")
            timestamp = max(1, int(float(raw.pop("click_timestamp") or row_number)))
            features = {
                key: _number(item) if key in {"clicks_1week", "product_price"} else item
                for key, item in raw.items()
            }
            result.append(
                BinaryExample(
                    example_id=f"sponsored-row-{row_number}",
                    timestamp_ms=timestamp,
                    split=split,
                    origin=origin,
                    label=converted,
                    clicked=1,
                    converted=converted,
                    value=value,
                    features=features,
                )
            )
            if limit is not None and len(result) >= limit:
                break
    return result
