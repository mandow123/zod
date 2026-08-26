from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping


FINAL_STATUSES = {"COMPLETE", "PARTIAL", "NOT_RUN", "FAILED"}


class PublicReportError(ValueError):
    """Raised when an experiment report crosses the public-data truth boundary."""


def sha256_file(path: str | Path, *, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _require_non_empty_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PublicReportError(f"{field} must be a non-empty string")
    return value


def _require_sha256(value: Any, field: str) -> str:
    text = _require_non_empty_string(value, field)
    if len(text) != 64 or any(char not in "0123456789abcdef" for char in text.lower()):
        raise PublicReportError(f"{field} must be a SHA-256 hex digest")
    return text.lower()


def validate_public_report(report: Mapping[str, Any]) -> None:
    """Validate evidence needed before public benchmark numbers may be reported.

    The validator intentionally does not prescribe model-specific result fields. It
    enforces provenance, immutable protocol fingerprints and offline-only claims.
    """

    if report.get("schemaVersion") != 1:
        raise PublicReportError("schemaVersion must be 1")
    _require_non_empty_string(report.get("experimentId"), "experimentId")
    status = report.get("status")
    if status not in FINAL_STATUSES:
        raise PublicReportError(f"status must be one of {sorted(FINAL_STATUSES)}")
    if report.get("dataOrigin") != "public":
        raise PublicReportError("public benchmark reports require dataOrigin=public")
    if report.get("claimableOnlinePerformance") is not False:
        raise PublicReportError("public offline results cannot claim online performance")

    source = report.get("source")
    if not isinstance(source, Mapping):
        raise PublicReportError("source must be an object")
    _require_non_empty_string(source.get("id"), "source.id")
    official_url = _require_non_empty_string(source.get("officialUrl"), "source.officialUrl")
    if not official_url.startswith("https://"):
        raise PublicReportError("source.officialUrl must use HTTPS")
    _require_non_empty_string(source.get("terms"), "source.terms")

    limitations = report.get("limitations")
    if not isinstance(limitations, list):
        raise PublicReportError("limitations must be a list")

    # NOT_RUN may document a source gate without inventing dataset or split evidence.
    if status == "NOT_RUN":
        if report.get("results") not in (None, {}):
            raise PublicReportError("NOT_RUN reports cannot contain benchmark results")
        return

    evidence = report.get("evidence")
    if not isinstance(evidence, Mapping):
        raise PublicReportError("executed reports require an evidence object")
    files = evidence.get("datasetFiles")
    if not isinstance(files, list) or not files:
        raise PublicReportError("executed reports require dataset file evidence")
    for index, file_record in enumerate(files):
        if not isinstance(file_record, Mapping):
            raise PublicReportError(f"evidence.datasetFiles[{index}] must be an object")
        _require_non_empty_string(file_record.get("name"), f"datasetFiles[{index}].name")
        _require_sha256(file_record.get("sha256"), f"datasetFiles[{index}].sha256")
        size_bytes = file_record.get("bytes")
        if not isinstance(size_bytes, int) or size_bytes <= 0:
            raise PublicReportError(f"datasetFiles[{index}].bytes must be positive")
    _require_sha256(evidence.get("configSha256"), "evidence.configSha256")
    _require_sha256(evidence.get("splitSha256"), "evidence.splitSha256")

    protocol = report.get("protocol")
    if not isinstance(protocol, Mapping):
        raise PublicReportError("executed reports require a protocol object")
    seeds = protocol.get("seeds")
    if not isinstance(seeds, list) or not seeds or any(not isinstance(seed, int) for seed in seeds):
        raise PublicReportError("protocol.seeds must be a non-empty integer list")
    counts = protocol.get("counts")
    if not isinstance(counts, Mapping) or not counts:
        raise PublicReportError("protocol.counts must be a non-empty object")
    if any(not isinstance(value, int) or value < 0 for value in counts.values()):
        raise PublicReportError("all protocol counts must be non-negative integers")

    results = report.get("results")
    if status == "COMPLETE" and (not isinstance(results, Mapping) or not results):
        raise PublicReportError("COMPLETE reports require non-empty results")


def load_and_validate_public_report(path: str | Path) -> dict[str, Any]:
    report_path = Path(path)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if not isinstance(report, dict):
        raise PublicReportError(f"{report_path} must contain a JSON object")
    validate_public_report(report)
    return report
