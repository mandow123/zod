from __future__ import annotations

import argparse
from pathlib import Path

from kai_recsys_lab.public_report import load_and_validate_public_report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate offline public benchmark evidence")
    parser.add_argument("reports", nargs="+", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    for path in args.reports:
        load_and_validate_public_report(path)
        print(f"valid public report: {path}")


if __name__ == "__main__":
    main()
