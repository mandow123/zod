from __future__ import annotations

import argparse
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from kai_recsys_lab.pipelines.amazon_end_to_end_v3 import run_dev_selection, run_final_test


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the gated Amazon frozen-retrieval plus reranking V3 experiment")
    parser.add_argument("--config", type=Path, default=PROJECT_ROOT / "configs" / "amazon-end-to-end-v3.json")
    parser.add_argument("--phase", choices=("dev-select", "test-final"), required=True)
    args = parser.parse_args()
    if args.phase == "dev-select":
        result = run_dev_selection(args.config)
        print(
            f"status={result['status']} selected={result['selectedCandidateId']} "
            f"testMetrics={result['testMetrics']}"
        )
        return
    result = run_final_test(args.config)
    print(
        f"status={result['status']} outcome={result['outcome']} "
        f"primaryMetricMean={result['results']['primaryMetricMean']}"
    )


if __name__ == "__main__":
    main()
