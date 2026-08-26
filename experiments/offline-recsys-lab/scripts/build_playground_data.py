from __future__ import annotations

import hashlib
import json
from pathlib import Path

from kai_recsys_lab.pipelines.amazon_retrieval import (
    itemknn_topk,
    load_config,
    popularity_topk,
    prepare_amazon_data,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "playground" / "data" / "demo-fixtures.json"


def alias(prefix: str, value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:8].upper()
    return f"{prefix}-{digest}"


def amazon_fixtures() -> dict[str, object]:
    config = load_config(ROOT / "configs" / "amazon-retrieval-v1.json")
    data = prepare_amazon_data(
        ROOT / "data" / "raw" / "amazon-reviews-2023" / "Industrial_and_Scientific",
        config,
    )
    popularity = popularity_topk(data, k=10, split="test")
    itemknn = itemknn_topk(data, k=10, split="test")
    desired_lengths = (5, 8, 12)
    selected: list[int] = []
    for desired in desired_lengths:
        candidates = [
            row
            for row, history in enumerate(data.test_histories)
            if row not in selected and len(history) >= desired
        ]
        selected.append(candidates[0])

    rows: list[dict[str, object]] = []
    for display_index, row in enumerate(selected, start=1):
        user_index = int(data.test_query_users[row])
        history = data.test_histories[row]
        rows.append(
            {
                "id": f"public-history-{display_index}",
                "userAlias": alias("USER", data.users[user_index]),
                "history": [alias("ITEM", data.catalog[int(item)]) for item in history[-8:]],
                "actualNextItem": alias("ITEM", data.catalog[int(data.test_targets[row])]),
                "recommendations": {
                    "popularity": [alias("ITEM", data.catalog[int(item)]) for item in popularity[row]],
                    "itemKnn": [alias("ITEM", data.catalog[int(item)]) for item in itemknn[row]],
                    "bprMf": None,
                    "twoTower": None,
                },
            }
        )
    return {
        "origin": "public",
        "dataset": "Amazon Reviews'23 Industrial_and_Scientific 5-core",
        "derivation": "Inference-only replay from the frozen public split; no model training.",
        "limitations": (
            "BPR and Two-Tower per-user traces are unavailable because the frozen run did not persist "
            "their checkpoints or user vectors."
        ),
        "histories": rows,
    }


def criteo_fixture() -> dict[str, object]:
    path = ROOT / "data" / "processed" / "criteo-ctr" / "day-2015-02-15-part-00079-first-60000.tsv"
    with path.open("r", encoding="utf-8") as handle:
        for row_number, line in enumerate(handle):
            if row_number == 51_000:
                values = line.rstrip("\n").split("\t")
                break
        else:
            raise ValueError("Criteo fixed subset does not contain the first test row")
    if len(values) != 40:
        raise ValueError(f"expected 40 Criteo columns, received {len(values)}")
    numeric = values[1:14]
    categorical = values[14:40]
    return {
        "origin": "public",
        "dataset": "Criteo 1TB Click Logs fixed-subset V1",
        "split": "test",
        "rowAlias": "TEST-ROW-00001",
        "features": [
            *[{"name": f"I{index + 1}", "value": value or "missing"} for index, value in enumerate(numeric[:6])],
            *[
                {"name": f"C{index + 1}", "value": alias("HASH", value) if value else "missing"}
                for index, value in enumerate(categorical[:6])
            ],
        ],
        "individualPredictionPersisted": False,
        "limitation": (
            "This frozen artifact did not persist row-level predictions or checkpoints. "
            "The UI therefore shows real aggregate metrics and calibration-bin means only."
        ),
    }


def main() -> None:
    payload = {
        "schemaVersion": 1,
        "dataBoundary": "public-offline-demo-fixture",
        "productionClaim": False,
        "generatedWithoutTraining": True,
        "amazon": amazon_fixtures(),
        "criteo": criteo_fixture(),
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
