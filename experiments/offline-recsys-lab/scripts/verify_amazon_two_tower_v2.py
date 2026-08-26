from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from kai_recsys_lab.public_report import canonical_sha256, load_and_validate_public_report, sha256_file


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "configs" / "amazon-two-tower-v2.json"
REPORT = ROOT / "reports" / "amazon-two-tower-v2-results.json"


def _same(left: float, right: float) -> bool:
    return math.isclose(float(left), float(right), rel_tol=0.0, abs_tol=1e-12)


def main() -> None:
    report = load_and_validate_public_report(REPORT)
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    if report.get("outcome") not in {"POSITIVE_TEST_IMPROVEMENT", "NEGATIVE_NO_TEST_IMPROVEMENT"}:
        raise ValueError("V2 outcome is not explicit")
    if report["evidence"]["configSha256"] != sha256_file(CONFIG):
        raise ValueError("V2 config file digest drifted")
    if report["evidence"]["configCanonicalSha256"] != canonical_sha256(config):
        raise ValueError("V2 canonical config digest drifted")
    if report["protocol"]["testExecutionCount"] != 1 or not report["protocol"]["testOpenedAfterSelectionFrozen"]:
        raise ValueError("V2 test gate is not frozen to one execution")
    if report["devSelection"]["testMetrics"] is not None:
        raise ValueError("dev selection manifest contains test metrics")
    candidates = report["devSelection"]["candidates"]
    winner = sorted(candidates, key=lambda row: (-float(row["selectionValue"]), str(row["id"])))[0]
    if winner["id"] != report["devSelection"]["selectedCandidateId"]:
        raise ValueError("selected candidate is not the dev NDCG@100 winner")
    if winner["config"] != report["selectedCandidate"]:
        raise ValueError("final candidate drifted after dev selection")

    seeds = [str(seed) for seed in report["protocol"]["seeds"]]
    per_seed = report["test"]["perSeed"]
    if sorted(per_seed) != sorted(seeds):
        raise ValueError("final test does not contain the frozen seed set")
    for seed in seeds:
        row = per_seed[seed]
        if row["checkpoint"]["roundTripLoaded"] is not True:
            raise ValueError(f"seed {seed} checkpoint was not round-trip loaded")
        if row["userRecallTrace"]["rows"] != report["protocol"]["testEvaluationUsers"]:
            raise ValueError(f"seed {seed} user trace row count drifted")
        if row["userRecallTrace"]["rawIdentifiersIncluded"] is not False:
            raise ValueError(f"seed {seed} trace exposes raw identifiers")

    for k in report["protocol"]["ks"]:
        key = str(k)
        for metric in ("recall", "hitRate", "mrr", "ndcg"):
            values = np.asarray([per_seed[seed]["testMetrics"][key][metric] for seed in seeds], dtype=np.float64)
            summary = report["test"]["summary"][key][metric]
            if not _same(values.mean(), summary["mean"]) or not _same(values.std(ddof=0), summary["std"]):
                raise ValueError(f"V2 summary drifted for {metric}@{k}")
            v1 = report["frozenV1"]["exactSummary"][key][metric]["mean"]
            if not _same(summary["mean"] - v1, report["comparison"]["delta"][key][metric]):
                raise ValueError(f"V2-vs-V1 delta drifted for {metric}@{k}")

    improved = (
        report["test"]["summary"]["100"]["ndcg"]["mean"]
        > report["frozenV1"]["exactSummary"]["100"]["ndcg"]["mean"]
    )
    expected_outcome = "POSITIVE_TEST_IMPROVEMENT" if improved else "NEGATIVE_NO_TEST_IMPROVEMENT"
    if report["outcome"] != expected_outcome or report["comparison"]["primaryMetricImproved"] is not improved:
        raise ValueError("V2 outcome does not match the frozen primary metric")

    artifact_root = ROOT / config["artifactsDir"]
    selection = artifact_root / "dev-selection.json"
    receipt = artifact_root / "test-final-receipt.json"
    if selection.is_file():
        if sha256_file(selection) != report["evidence"]["selectionManifestSha256"]:
            raise ValueError("local dev selection artifact digest drifted")
    if receipt.is_file():
        payload = json.loads(receipt.read_text(encoding="utf-8"))
        if payload.get("status") != "TEST_FINAL_EXECUTED_ONCE" or payload.get("resultSha256") != sha256_file(REPORT):
            raise ValueError("local final-test receipt drifted")
    for seed in seeds:
        row = per_seed[seed]
        checkpoint = artifact_root / "checkpoints" / row["checkpoint"]["name"]
        trace = artifact_root / "traces" / row["userRecallTrace"]["name"]
        if checkpoint.is_file() and sha256_file(checkpoint) != row["checkpoint"]["sha256"]:
            raise ValueError(f"seed {seed} local checkpoint digest drifted")
        if trace.is_file() and sha256_file(trace) != row["userRecallTrace"]["sha256"]:
            raise ValueError(f"seed {seed} local trace digest drifted")
    print(f"valid Amazon Two-Tower V2: {report['outcome']}")


if __name__ == "__main__":
    main()
