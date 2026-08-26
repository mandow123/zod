#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from kai_recsys_lab.pipelines.amazon_retrieval import (
    load_config,
    run_retrieval_benchmark,
    run_sequence_benchmark,
    write_result,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the isolated Amazon Reviews'23 retrieval benchmark")
    parser.add_argument("--config", default="configs/amazon-retrieval-v1.json")
    parser.add_argument("--phase", choices=("audit", "classical", "all", "sequence"), default="all")
    arguments = parser.parse_args()
    config_path = Path(arguments.config)
    config = load_config(config_path)
    try:
        result = (
            run_sequence_benchmark(config_path)
            if arguments.phase == "sequence"
            else run_retrieval_benchmark(config_path, phase=arguments.phase)
        )
    except Exception as error:
        result = {
            "schemaVersion": 1,
            "experimentId": config["experimentId"],
            "status": "FAILED",
            "dataOrigin": "public",
            "claimableOnlinePerformance": False,
            "source": {
                "id": "mcauley-lab-amazon-reviews-2023",
                "officialUrl": config["dataset"]["officialDocumentationUrl"],
                "terms": "license not assigned by provider; isolated non-commercial research only; no raw-data redistribution",
                "termsEvidenceUrl": config["dataset"]["officialTermsEvidenceUrl"],
            },
            "errorType": type(error).__name__,
            "error": str(error),
            "results": {},
        }
        write_result(result, config["output"])
        print(json.dumps(result, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    write_result(result, config["output"])
    print(json.dumps({"status": result["status"], "output": config["output"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
