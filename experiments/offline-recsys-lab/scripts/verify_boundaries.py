from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ALLOWED_ORIGINS = {"public", "synthetic"}


def main() -> None:
    ledger = json.loads((ROOT / "sources" / "source-ledger.json").read_text())
    if ledger.get("productionBusinessDataAllowed") is not False:
        raise SystemExit("offline lab must reject production business data")
    sources = ledger.get("sources")
    if not isinstance(sources, list) or not sources:
        raise SystemExit("source ledger is empty")
    ids: set[str] = set()
    for source in sources:
        if source.get("origin") not in ALLOWED_ORIGINS:
            raise SystemExit(f"disallowed data origin: {source.get('origin')}")
        source_id = source.get("id")
        if not isinstance(source_id, str) or not source_id or source_id in ids:
            raise SystemExit("source ids must be unique and non-empty")
        ids.add(source_id)
        if not str(source.get("officialUrl", "")).startswith("https://"):
            raise SystemExit(f"source {source_id} lacks an HTTPS official URL")
        if not source.get("usageStatus"):
            raise SystemExit(f"source {source_id} lacks a usage boundary")
    print(f"offline boundary verified: {len(sources)} registered sources")


if __name__ == "__main__":
    main()
