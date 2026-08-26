from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path

from kai_recsys_lab.public_report import (
    PublicReportError,
    canonical_sha256,
    sha256_file,
    validate_public_report,
)


def complete_report() -> dict[str, object]:
    digest = "a" * 64
    return {
        "schemaVersion": 1,
        "experimentId": "retrieval-v1",
        "status": "COMPLETE",
        "dataOrigin": "public",
        "claimableOnlinePerformance": False,
        "source": {
            "id": "amazon-reviews-2023",
            "officialUrl": "https://example.com/dataset",
            "terms": "Research use subject to source terms.",
        },
        "evidence": {
            "datasetFiles": [{"name": "train.csv.gz", "sha256": digest, "bytes": 42}],
            "configSha256": digest,
            "splitSha256": digest,
        },
        "protocol": {"seeds": [3407], "counts": {"trainRows": 10, "testRows": 2}},
        "results": {"popularity": {"Recall@20": 0.1}},
        "limitations": ["offline only"],
    }


class PublicReportTest(unittest.TestCase):
    def test_complete_report_requires_reproducibility_evidence(self) -> None:
        report = complete_report()
        validate_public_report(report)
        invalid = copy.deepcopy(report)
        del invalid["evidence"]["splitSha256"]  # type: ignore[index]
        with self.assertRaises(PublicReportError):
            validate_public_report(invalid)

    def test_online_performance_claim_fails_closed(self) -> None:
        report = complete_report()
        report["claimableOnlinePerformance"] = True
        with self.assertRaises(PublicReportError):
            validate_public_report(report)

    def test_not_run_cannot_smuggle_metrics(self) -> None:
        report = complete_report()
        report["status"] = "NOT_RUN"
        report.pop("evidence")
        report.pop("protocol")
        with self.assertRaises(PublicReportError):
            validate_public_report(report)

    def test_hash_helpers_are_deterministic(self) -> None:
        self.assertEqual(canonical_sha256({"b": 2, "a": 1}), canonical_sha256({"a": 1, "b": 2}))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample"
            path.write_bytes(b"public-data")
            self.assertEqual(sha256_file(path), sha256_file(path))


if __name__ == "__main__":
    unittest.main()
