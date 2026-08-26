from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from .contracts import DataOrigin, Split
from .data import load_amazon_processed_csv, load_criteo_display_tsv, load_criteo_sponsored_search_tsv
from .smoke import run_synthetic_smoke


ROOT = Path(__file__).resolve().parents[2]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="KAI offline recommendation research lab")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("verify-boundary")
    smoke = commands.add_parser("synthetic-smoke")
    smoke.add_argument("--seed", type=int, default=3407)
    smoke.add_argument("--output", type=Path)
    inspect = commands.add_parser("inspect-data")
    inspect.add_argument("kind", choices=("amazon", "criteo-display", "criteo-sponsored"))
    inspect.add_argument("path", type=Path)
    inspect.add_argument("--limit", type=int, default=1000)
    inspect.add_argument("--origin", choices=("public", "synthetic"), default="public")
    inspect.add_argument("--split", choices=("train", "dev", "test"), default="train")
    return parser


def main() -> None:
    args = _parser().parse_args()
    if args.command == "verify-boundary":
        subprocess.run([sys.executable, str(ROOT / "scripts" / "verify_boundaries.py")], check=True)
        return
    if args.command == "synthetic-smoke":
        payload = json.dumps(run_synthetic_smoke(args.seed), ensure_ascii=False, indent=2) + "\n"
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(payload, encoding="utf-8")
        else:
            print(payload, end="")
        return
    split = Split(args.split)
    origin = DataOrigin(args.origin)
    if args.kind == "amazon":
        rows = load_amazon_processed_csv(args.path, split=split, origin=origin, limit=args.limit)
    elif args.kind == "criteo-display":
        rows = load_criteo_display_tsv(args.path, split=split, origin=origin, limit=args.limit)
    else:
        rows = load_criteo_sponsored_search_tsv(args.path, split=split, origin=origin, limit=args.limit)
    print(f"validated {len(rows)} {origin.value} {args.kind} rows for split={split.value}")


if __name__ == "__main__":
    main()
