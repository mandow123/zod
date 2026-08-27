#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from kai_recsys_lab.pipelines.criteo_esmm_v1 import (  # noqa: E402
    ArtifactGateError,
    assess_artifact_readiness,
    load_config,
    render_markdown_report,
    run_criteo_esmm_experiment,
    write_report,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run the pinned Criteo impression-level CVR / ESMM V1 protocol"
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=PROJECT_ROOT / "configs" / "criteo-esmm-v1.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=PROJECT_ROOT / "reports" / "criteo-esmm-v1-results.json",
    )
    parser.add_argument(
        "--markdown-output",
        type=Path,
        default=PROJECT_ROOT / "reports" / "criteo-esmm-v1.md",
    )
    parser.add_argument(
        "--status-only",
        action="store_true",
        help="verify the pinned artifact without parsing, training, test access, or report writes",
    )
    args = parser.parse_args()
    config = load_config(args.config)
    if args.status_only:
        readiness = assess_artifact_readiness(config, config_path=args.config)
        print(json.dumps(readiness, ensure_ascii=False, sort_keys=True))
        return 0 if readiness["status"] == "VERIFIED" else 2
    try:
        report = run_criteo_esmm_experiment(config, config_path=args.config)
    except ArtifactGateError as error:
        print(json.dumps(error.readiness, ensure_ascii=False, sort_keys=True), file=sys.stderr)
        return 2
    if report["status"] != "COMPLETE" or report["dataOrigin"] != "official_public":
        print(
            json.dumps(
                {
                    "status": report["status"],
                    "reason": "non-official or incomplete runs are test-only and are never persisted",
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2
    markdown = render_markdown_report(report)
    write_report(report, args.output)
    args.markdown_output.parent.mkdir(parents=True, exist_ok=True)
    args.markdown_output.write_text(markdown, encoding="utf-8")
    print(args.output)
    print(args.markdown_output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
