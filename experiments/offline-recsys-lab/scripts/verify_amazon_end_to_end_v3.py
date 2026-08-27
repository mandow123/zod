from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_sha256(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _finite_metrics(value: Any) -> None:
    if isinstance(value, dict):
        for child in value.values():
            _finite_metrics(child)
    elif isinstance(value, list):
        for child in value:
            _finite_metrics(child)
    elif isinstance(value, float) and not math.isfinite(value):
        raise SystemExit("Amazon V3 report contains a non-finite metric")


def _verify_cohort(cohort: dict[str, Any], expected_users: int) -> None:
    query_count = int(cohort["queryCount"])
    exclusions = int(cohort["equalTimestampQueriesExcluded"])
    if query_count + exclusions != expected_users:
        raise SystemExit("Amazon V3 cohort population does not reconcile to the test population")
    if cohort.get("evaluationOutcomeUsedForAssignment") is not False:
        raise SystemExit("Amazon V3 cohort assignment used an evaluation outcome")
    for rows in cohort["dimensions"].values():
        if sum(int(row["queryCount"]) for row in rows.values()) != query_count:
            raise SystemExit("Amazon V3 cohort dimension does not partition its eligible population")


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify tracked Amazon end-to-end V3 evidence")
    parser.add_argument("--require-artifacts", action="store_true")
    args = parser.parse_args()

    config_path = ROOT / "configs" / "amazon-end-to-end-v3.json"
    report_path = ROOT / "reports" / "amazon-end-to-end-v3-results.json"
    selection_path = ROOT / "artifacts" / "amazon-end-to-end-v3" / "dev-selection.json"
    receipt_path = ROOT / "artifacts" / "amazon-end-to-end-v3" / "test-final-receipt.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    report = json.loads(report_path.read_text(encoding="utf-8"))

    if report.get("status") != "COMPLETE" or report.get("dataOrigin") != "public":
        raise SystemExit("Amazon V3 report is not a complete public-data run")
    if report.get("claimableOnlinePerformance") is not False:
        raise SystemExit("Amazon V3 report crosses the offline evidence boundary")
    if report.get("evidence", {}).get("configSha256") != _sha256(config_path):
        raise SystemExit("Amazon V3 config file hash differs from the tracked report")
    if report.get("evidence", {}).get("configCanonicalSha256") != _canonical_sha256(config):
        raise SystemExit("Amazon V3 canonical config hash differs from the tracked report")

    protocol = report["protocol"]
    if protocol.get("selectionSplit") != "dev" or protocol.get("testTuningForbidden") is not True:
        raise SystemExit("Amazon V3 dev-selection/test-isolation protocol is invalid")
    if protocol.get("testExecutionCount") != 1 or protocol.get("testOpenedAfterSelectionFrozen") is not True:
        raise SystemExit("Amazon V3 test-once gate is invalid")
    if report["devSelection"].get("testMetrics") is not None:
        raise SystemExit("Amazon V3 dev selection contains test metrics")

    candidates = report["devSelection"]["candidates"]
    if len(candidates) != 5:
        raise SystemExit("Amazon V3 must preserve all five frozen dev candidates")
    candidate_ids = {candidate["id"] for candidate in candidates}
    selected_id = report["selectedCandidate"]["id"]
    if selected_id != report["devSelection"]["selectedCandidateId"] or selected_id not in candidate_ids:
        raise SystemExit("Amazon V3 selected candidate is inconsistent with dev selection")
    winner = max(candidates, key=lambda candidate: float(candidate["selectionValue"]))
    if winner["id"] != selected_id:
        raise SystemExit("Amazon V3 selected candidate is not the frozen dev winner")
    strategies = {candidate["config"]["negativeSampling"] for candidate in candidates}
    models = {candidate["config"]["modelType"] for candidate in candidates}
    retrieval_modes = {candidate["config"]["retrievalMode"] for candidate in candidates}
    if strategies != {"hard", "uniform", "in_batch"}:
        raise SystemExit("Amazon V3 negative-sampling comparison is incomplete")
    if models != {"din_style", "dcn_style"} or retrieval_modes != {"exact", "hnsw"}:
        raise SystemExit("Amazon V3 model or retrieval comparison is incomplete")

    ablations = report["devSelection"]["metadataAblations"]
    variants = {row["variant"] for row in ablations["rows"]}
    if variants != {"full", "without_metadata", "without_id", "without_title", "without_category"}:
        raise SystemExit("Amazon V3 metadata ablation suite is incomplete")
    if ablations.get("retrainedPerVariant") is not False:
        raise SystemExit("Amazon V3 ablation truth boundary changed")
    if len({row["querySetSha256"] for row in ablations["rows"]}) != 1:
        raise SystemExit("Amazon V3 ablations do not share one frozen query population")

    sweep = report["devSelection"]["hnswSweep"]
    if len(sweep.get("points", [])) < 3 or sweep.get("winnerSelected") is not False:
        raise SystemExit("Amazon V3 HNSW trade-off sweep is incomplete or used for model selection")
    for point in sweep["points"]:
        for key in ("recall_at_k", "mean_latency_ms", "p50_latency_ms", "p95_latency_ms", "index_size_bytes"):
            if float(point[key]) <= 0:
                raise SystemExit(f"Amazon V3 HNSW point has an invalid {key}")

    expected_users = int(protocol["testEvaluationUsers"])
    for cohort in report["test"]["cohorts"].values():
        _verify_cohort(cohort, expected_users)
    ci = report["results"]["confidenceInterval"]
    if ci.get("resampling_unit") != "user" or ci.get("bootstrap_samples") != 2000:
        raise SystemExit("Amazon V3 confidence interval is not the frozen user-level bootstrap")
    if ci.get("user_count") != expected_users or not (ci["lower_bound"] < ci["mean_difference"] < ci["upper_bound"]):
        raise SystemExit("Amazon V3 confidence interval population or bounds are invalid")
    if report["results"].get("intervalExcludesZero") is not True:
        raise SystemExit("Amazon V3 tracked interval no longer excludes zero")
    if report["results"].get("significanceClaimed") is not False:
        raise SystemExit("Amazon V3 must not turn an offline interval into an online significance claim")
    if len(report["test"]["rerankedPerSeed"]) != len(protocol["seeds"]):
        raise SystemExit("Amazon V3 reranking seeds are incomplete")
    if any(token in report_path.read_text(encoding="utf-8") for token in ("/Users/", "file://", "\\Users\\")):
        raise SystemExit("Amazon V3 public report contains a local absolute path")
    _finite_metrics(report)

    if args.require_artifacts:
        if not selection_path.is_file() or not receipt_path.is_file():
            raise SystemExit("Amazon V3 frozen selection and test receipt artifacts are required")
        if _sha256(selection_path) != report["evidence"]["selectionManifestSha256"]:
            raise SystemExit("Amazon V3 selection artifact hash changed")
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if receipt.get("resultSha256") != _sha256(report_path):
            raise SystemExit("Amazon V3 test receipt does not bind the tracked result")
        if receipt.get("selectedCandidateId") != selected_id:
            raise SystemExit("Amazon V3 test receipt selected candidate changed")

    print("Amazon end-to-end V3 verified: frozen dev selection, test-once gate, complete analyses")


if __name__ == "__main__":
    main()
