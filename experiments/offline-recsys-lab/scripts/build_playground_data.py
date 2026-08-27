from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "playground" / "data" / "demo-fixtures.json"


def main() -> None:
    """Build redistributable UI fixtures without copying third-party records."""

    histories = [
        {
            "id": "synthetic-history-a",
            "userAlias": "SYNTHETIC-USER-A",
            "history": ["ITEM-SYN-001", "ITEM-SYN-004", "ITEM-SYN-007", "ITEM-SYN-011", "ITEM-SYN-013"],
            "actualNextItem": "ITEM-SYN-021",
            "recommendations": {
                "popularity": [f"ITEM-SYN-{value:03d}" for value in (31, 25, 18, 7, 2, 9, 15, 22, 28, 6)],
                "itemKnn": [f"ITEM-SYN-{value:03d}" for value in (21, 14, 19, 5, 27, 8, 17, 3, 23, 12)],
                "bprMf": None,
                "twoTower": None,
            },
        },
        {
            "id": "synthetic-history-b",
            "userAlias": "SYNTHETIC-USER-B",
            "history": [
                "ITEM-SYN-002", "ITEM-SYN-005", "ITEM-SYN-008", "ITEM-SYN-012",
                "ITEM-SYN-016", "ITEM-SYN-020", "ITEM-SYN-024", "ITEM-SYN-029",
            ],
            "actualNextItem": "ITEM-SYN-017",
            "recommendations": {
                "popularity": [f"ITEM-SYN-{value:03d}" for value in (31, 25, 18, 7, 2, 9, 15, 22, 28, 6)],
                "itemKnn": [f"ITEM-SYN-{value:03d}" for value in (17, 26, 10, 30, 3, 13, 21, 6, 19, 27)],
                "bprMf": None,
                "twoTower": None,
            },
        },
        {
            "id": "synthetic-history-c",
            "userAlias": "SYNTHETIC-USER-C",
            "history": [
                "ITEM-SYN-003", "ITEM-SYN-006", "ITEM-SYN-009", "ITEM-SYN-010",
                "ITEM-SYN-014", "ITEM-SYN-018", "ITEM-SYN-022", "ITEM-SYN-023",
                "ITEM-SYN-025", "ITEM-SYN-027", "ITEM-SYN-030", "ITEM-SYN-032",
            ],
            "actualNextItem": "ITEM-SYN-028",
            "recommendations": {
                "popularity": [f"ITEM-SYN-{value:03d}" for value in (31, 25, 18, 7, 2, 9, 15, 22, 28, 6)],
                "itemKnn": [f"ITEM-SYN-{value:03d}" for value in (28, 11, 16, 20, 4, 24, 29, 1, 17, 26)],
                "bprMf": None,
                "twoTower": None,
            },
        },
    ]
    payload = {
        "schemaVersion": 2,
        "dataBoundary": "synthetic-ui-fixture-with-public-aggregate-reports",
        "productionClaim": False,
        "generatedWithoutTraining": True,
        "redistributable": True,
        "amazon": {
            "origin": "synthetic",
            "dataset": "Deterministic synthetic UI fixture",
            "derivation": "Hand-authored aliases; no Amazon row, user, item ID, or text is included.",
            "limitations": "Lists demonstrate interaction only; all displayed aggregate metrics come from separately labeled public reports.",
            "histories": histories,
        },
        "criteo": {
            "origin": "synthetic",
            "dataset": "Deterministic synthetic UI fixture",
            "split": "not_applicable",
            "rowAlias": "SYNTHETIC-IMPRESSION-001",
            "features": [
                {"name": "I1", "value": "4"},
                {"name": "I2", "value": "missing"},
                {"name": "I3", "value": "12"},
                {"name": "C1", "value": "HASH-SYN-01"},
                {"name": "C2", "value": "HASH-SYN-02"},
                {"name": "C3", "value": "missing"},
            ],
            "individualPredictionPersisted": False,
            "limitation": "This row is synthetic and has no individual prediction; the UI displays only tracked aggregate public metrics.",
        },
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
