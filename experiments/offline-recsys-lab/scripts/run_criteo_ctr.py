#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from kai_recsys_lab.pipelines.criteo_ctr import (  # noqa: E402
    load_config,
    render_markdown_report,
    run_criteo_ctr_experiment,
    write_report,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the fixed Criteo CTR public-subset protocol")
    parser.add_argument(
        "--config",
        type=Path,
        default=PROJECT_ROOT / "configs" / "criteo-ctr-v1.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=PROJECT_ROOT / "reports" / "criteo-ctr-v1-results.json",
    )
    parser.add_argument(
        "--markdown-output",
        type=Path,
        default=PROJECT_ROOT / "reports" / "criteo-ctr-v1.md",
    )
    args = parser.parse_args()
    config = load_config(args.config)
    report = run_criteo_ctr_experiment(config, config_path=args.config)
    write_report(report, args.output)
    args.markdown_output.write_text(render_markdown_report(report), encoding="utf-8")
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
