from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "artifacts" / "small-reproduction.json"
sys.path.insert(0, str(ROOT / "src"))

from kai_recsys_lab.smoke import run_synthetic_smoke  # noqa: E402


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _run(*args: str) -> None:
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(ROOT / "src")
    subprocess.run(args, cwd=ROOT, env=environment, check=True)


def main() -> None:
    """Reproduce the complete code path without claiming benchmark evidence."""

    _run(sys.executable, "scripts/verify_boundaries.py")
    _run(
        sys.executable,
        "-m",
        "pytest",
        "tests/test_amazon_end_to_end_v3.py",
        "tests/test_criteo_esmm_v1.py",
        "tests/test_evaluation_statistics.py",
        "tests/test_evaluation_cohorts.py",
        "tests/test_retrieval_ann_sweep.py",
    )
    smoke = run_synthetic_smoke(seed=3407)
    test_files = [
        ROOT / "tests" / "test_amazon_end_to_end_v3.py",
        ROOT / "tests" / "test_criteo_esmm_v1.py",
        ROOT / "tests" / "test_evaluation_statistics.py",
        ROOT / "tests" / "test_evaluation_cohorts.py",
        ROOT / "tests" / "test_retrieval_ann_sweep.py",
    ]
    payload = {
        "schemaVersion": 1,
        "artifactKind": "deterministic_small_code_path_reproduction",
        "dataOrigin": "synthetic",
        "businessData": False,
        "claimablePerformance": False,
        "publicBenchmarkRerun": False,
        "seed": 3407,
        "scope": [
            "two_tower_candidate_contract",
            "hnsw_top_k_contract",
            "negative_sampling_contract",
            "reranking_and_calibration_contract",
            "paired_bootstrap_contract",
            "cold_start_cohort_contract",
            "ann_sweep_contract",
            "impression_level_esmm_contract",
        ],
        "tests": {
            str(path.relative_to(ROOT)): {"sha256": _sha256(path)} for path in test_files
        },
        "syntheticSmoke": smoke,
        "limitations": [
            "This command validates deterministic integration paths on synthetic fixtures.",
            "It does not download third-party data or reproduce tracked public metrics.",
            "Public benchmark commands require the licensed source files and pinned configs.",
        ],
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
