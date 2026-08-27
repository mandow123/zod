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


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify tracked Criteo ESMM V1 evidence")
    parser.add_argument("--require-artifact", action="store_true")
    args = parser.parse_args()
    config_path = ROOT / "configs" / "criteo-esmm-v1.json"
    report_path = ROOT / "reports" / "criteo-esmm-v1-results.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    report = json.loads(report_path.read_text(encoding="utf-8"))

    if report.get("status") != "COMPLETE" or report.get("dataOrigin") != "official_public":
        raise SystemExit("ESMM report is not a complete official-public run")
    if report.get("claimableOnlinePerformance") is not False:
        raise SystemExit("ESMM report crosses the offline evidence boundary")
    if report.get("artifact", {}).get("configSha256") != _sha256(config_path):
        raise SystemExit("ESMM config hash differs from the tracked report")
    expected_result = dict(report)
    recorded_result_sha = expected_result.pop("resultSha256", None)
    if recorded_result_sha != _canonical_sha256(expected_result):
        raise SystemExit("ESMM embedded result hash is invalid")
    if report.get("testOnceGate") != {
        "accessCount": 1,
        "policy": "one bundled evaluation after all checkpoints are frozen",
        "usedForSelection": False,
    }:
        raise SystemExit("ESMM test-once gate is invalid")
    split = report["split"]
    if sum(split[name]["rows"] for name in ("train", "dev", "test")) != config["dataset"]["rowLimit"]:
        raise SystemExit("ESMM split rows do not match the frozen row limit")
    if report.get("dataBoundary", {}).get("featureAllowlist") != config["features"]["allowlist"]:
        raise SystemExit("ESMM feature allowlist changed")
    for task in report.get("results", {}).get("summary", {}).values():
        for metric in task.values():
            if not all(math.isfinite(float(metric[key])) for key in ("mean", "populationStd")):
                raise SystemExit("ESMM summary contains a non-finite metric")

    artifact_path = ROOT / config["dataset"]["artifactPath"]
    if args.require_artifact:
        if not artifact_path.is_file():
            raise SystemExit("pinned ESMM artifact is required but absent")
        if artifact_path.stat().st_size != config["dataset"]["expectedBytes"]:
            raise SystemExit("pinned ESMM artifact byte length changed")
        if _sha256(artifact_path) != config["dataset"]["expectedSha256"]:
            raise SystemExit("pinned ESMM artifact SHA-256 changed")
    print("Criteo ESMM V1 verified: official-public evidence, frozen test gate, finite metrics")


if __name__ == "__main__":
    main()
