from __future__ import annotations

import argparse
from pathlib import Path

from kai_recsys_lab.pipelines.amazon_two_tower_v2 import render_markdown, run_dev_selection, run_final_test


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the gated Amazon metadata Two-Tower V2 experiment")
    parser.add_argument("--config", type=Path, default=Path("configs/amazon-two-tower-v2.json"))
    parser.add_argument("--phase", choices=("dev-select", "test-final"), required=True)
    parser.add_argument("--markdown", type=Path, default=Path("reports/amazon-two-tower-v2.md"))
    args = parser.parse_args()
    if args.phase == "dev-select":
        result = run_dev_selection(args.config)
        print(f"selected={result['selectedCandidateId']} testMetrics={result['testMetrics']}")
        return
    result = run_final_test(args.config)
    args.markdown.parent.mkdir(parents=True, exist_ok=True)
    args.markdown.write_text(render_markdown(result), encoding="utf-8")
    print(f"status={result['status']} conclusion={result['comparison']['conclusion']}")


if __name__ == "__main__":
    main()
