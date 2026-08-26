from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = PROJECT_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from kai_recsys_lab.pipelines.position_bias import (  # noqa: E402
    full_ope_markdown_report,
    markdown_report,
    run_full_position_bias_ope,
    run_position_bias_experiment,
    sha256_file,
)


def download_sources(config: dict[str, object]) -> None:
    dataset = config["dataset"]
    if not isinstance(dataset, dict):
        raise ValueError("dataset config must be an object")
    files = dataset["files"]
    if not isinstance(files, list):
        raise ValueError("dataset files must be a list")
    for source in files:
        if not isinstance(source, dict):
            raise ValueError("dataset source must be an object")
        destination = PROJECT_ROOT / str(source["relativePath"])
        if destination.is_file() and destination.stat().st_size == int(source["bytes"]):
            if sha256_file(destination) == source["sha256"]:
                continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + ".download")
        request = urllib.request.Request(str(source["url"]), headers={"User-Agent": "kai-offline-recsys-lab/0.1"})
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        if temporary.stat().st_size != int(source["bytes"]) or sha256_file(temporary) != source["sha256"]:
            temporary.unlink(missing_ok=True)
            raise ValueError(f"downloaded source integrity mismatch: {source['id']}")
        temporary.replace(destination)


def download_full_archive(config: dict[str, object]) -> None:
    dataset = config["dataset"]
    if not isinstance(dataset, dict) or not isinstance(dataset.get("fullArchive"), dict):
        raise ValueError("full archive config must be an object")
    source = dataset["fullArchive"]
    destination = PROJECT_ROOT / str(source["relativePath"])
    if destination.is_file() and destination.stat().st_size == int(source["bytes"]):
        if sha256_file(destination) == source["sha256"]:
            return
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".download")
    request = urllib.request.Request(str(source["url"]), headers={"User-Agent": "kai-offline-recsys-lab/0.1"})
    with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    if temporary.stat().st_size != int(source["bytes"]) or sha256_file(temporary) != source["sha256"]:
        temporary.unlink(missing_ok=True)
        raise ValueError("downloaded full archive integrity mismatch")
    temporary.replace(destination)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the frozen Open Bandit Dataset position-bias validity protocol")
    parser.add_argument(
        "--config",
        type=Path,
        default=PROJECT_ROOT / "configs" / "position-bias-v1.json",
    )
    parser.add_argument("--download", action="store_true", help="Download pinned official small files if absent")
    parser.add_argument("--full-ope", action="store_true", help="Run deterministic OPE on the full ALL campaign")
    parser.add_argument("--download-full", action="store_true", help="Download the pinned official full archive")
    parser.add_argument(
        "--json-output",
        type=Path,
        default=PROJECT_ROOT / "reports" / "position-bias-open-bandit-small-v1.json",
    )
    parser.add_argument(
        "--markdown-output",
        type=Path,
        default=PROJECT_ROOT / "reports" / "position-bias-open-bandit-small-v1.md",
    )
    args = parser.parse_args()

    config = json.loads(args.config.read_text(encoding="utf-8"))
    if args.download:
        download_sources(config)
    if args.download_full:
        download_full_archive(config)
    if args.full_ope:
        result = run_full_position_bias_ope(args.config, project_root=PROJECT_ROOT)
        json_output = PROJECT_ROOT / "reports" / "position-bias-open-bandit-full-ope-v1.json"
        markdown_output = PROJECT_ROOT / "reports" / "position-bias-open-bandit-full-ope-v1.md"
        json_output.parent.mkdir(parents=True, exist_ok=True)
        json_output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        markdown_output.write_text(full_ope_markdown_report(result), encoding="utf-8")
        print(json.dumps({
            "experimentId": result["experimentId"],
            "status": result["status"],
            "json": str(json_output),
            "markdown": str(markdown_output),
            "resultSha256": result["resultSha256"],
        }, ensure_ascii=False))
        return 0
    result = run_position_bias_experiment(args.config, project_root=PROJECT_ROOT)
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.markdown_output.write_text(markdown_report(result), encoding="utf-8")
    print(json.dumps({
        "experimentId": result["experimentId"],
        "status": result["status"],
        "json": str(args.json_output),
        "markdown": str(args.markdown_output),
        "resultSha256": result["resultSha256"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
