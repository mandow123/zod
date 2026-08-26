from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_json(path: str) -> dict:
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def main() -> None:
    index = (ROOT / "playground" / "index.html").read_text(encoding="utf-8")
    app = (ROOT / "playground" / "app.js").read_text(encoding="utf-8")
    styles = (ROOT / "playground" / "styles.css").read_text(encoding="utf-8")
    combined = "\n".join((index, app, styles))
    if re.search(r"https?://", combined, flags=re.IGNORECASE):
        raise SystemExit("playground source must not request external HTTP resources")
    required_fetches = {
        "amazon-retrieval-v1-results.json",
        "criteo-ctr-v1-results.json",
        "position-bias-open-bandit-full-ope-v1.json",
        "./data/demo-fixtures.json",
    }
    absent = sorted(path for path in required_fetches if path not in app)
    if absent:
        raise SystemExit(f"playground is missing local artifact fetches: {absent}")
    required_interface_copy = {
        "推荐系统是怎样工作的",
        "公开离线数据 · 本地演示",
        "开始 60 秒演示",
        "几万个商品不可能全部精排",
        "排第一的商品天然更容易被点击",
        'id="pipeline-catalog"',
    }
    absent_copy = sorted(value for value in required_interface_copy if value not in index)
    if absent_copy:
        raise SystemExit(f"playground is missing plain-language interface copy: {absent_copy}")
    if "25,754" in index or "25,754" in app:
        raise SystemExit("catalog size must be read from the frozen artifact, not hard-coded")
    if 'data-report-base="../reports"' not in index:
        raise SystemExit("playground must declare its report base for portable export")
    forbidden_prominent_english = {
        "How Recommendation Systems Work",
        "Recommendation Algorithm Playground",
        "PUBLIC OFFLINE DATA · LOCAL DEMO",
        "Technical Details",
        "POSITION BIAS",
    }
    leaked_copy = sorted(value for value in forbidden_prominent_english if value in index)
    if leaked_copy:
        raise SystemExit(f"prominent interface copy must be Chinese-first: {leaked_copy}")
    if index.count("<details class=\"tech-details\"") != 3:
        raise SystemExit("all three demos must progressively disclose technical details")

    fixture = read_json("playground/data/demo-fixtures.json")
    if fixture.get("generatedWithoutTraining") is not True or fixture.get("productionClaim") is not False:
        raise SystemExit("demo fixture truth boundary is invalid")
    histories = fixture["amazon"]["histories"]
    if len(histories) < 3:
        raise SystemExit("at least three anonymized histories are required")
    for history in histories:
        if len(history["recommendations"]["popularity"]) != 10:
            raise SystemExit("Popularity replay must contain exactly ten items")
        if len(history["recommendations"]["itemKnn"]) != 10:
            raise SystemExit("ItemKNN replay must contain exactly ten items")
        if history["recommendations"]["bprMf"] is not None or history["recommendations"]["twoTower"] is not None:
            raise SystemExit("missing BPR/Two-Tower checkpoints must remain explicit nulls")
        if not all(item.startswith("ITEM-") for item in history["history"]):
            raise SystemExit("Amazon histories must use anonymized item aliases")
    if fixture["criteo"].get("individualPredictionPersisted") is not False:
        raise SystemExit("CTR row-level prediction boundary must remain false")

    retrieval = read_json("reports/amazon-retrieval-v1-results.json")
    ctr = read_json("reports/criteo-ctr-v1-results.json")
    position = read_json("reports/position-bias-open-bandit-full-ope-v1.json")
    if retrieval.get("dataOrigin") != "public" or ctr.get("dataOrigin") != "public" or position.get("dataOrigin") != "public":
        raise SystemExit("all displayed benchmark reports must be public")
    for threshold in position["protocol"]["clippingThresholds"]:
        encoded = str(threshold).replace(".", "p")
        if f"snips_clipped_{encoded}" not in position["results"]["policyValueEstimates"]:
            raise SystemExit(f"missing frozen SNIPS clipping result: {threshold}")
    print("playground verified: local-only, artifact-driven, no training or production claim")


if __name__ == "__main__":
    main()
