from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "playground"
OUTPUT = ROOT / "dist" / "recommendation-systems-playground-portable"
ARCHIVE = ROOT / "dist" / "recommendation-systems-playground-portable.zip"

REPORTS = (
    "amazon-retrieval-v1-results.json",
    "amazon-end-to-end-v3-results.json",
    "criteo-ctr-v1-results.json",
    "criteo-esmm-v1-results.json",
    "position-bias-open-bandit-full-ope-v1.json",
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def export() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    data_output = OUTPUT / "data"
    data_output.mkdir(exist_ok=True)

    index = (SOURCE / "index.html").read_text(encoding="utf-8")
    portable_index = index.replace(
        'data-report-base="../reports"',
        'data-report-base="./data"',
    )
    if portable_index == index:
        raise SystemExit("portable report-base marker was not found")
    (OUTPUT / "index.html").write_text(portable_index, encoding="utf-8")

    for filename in ("styles.css", "app.js", "THIRD_PARTY_DATA.md"):
        shutil.copy2(SOURCE / filename, OUTPUT / filename)
    shutil.copy2(SOURCE / "PORTABLE-INTEGRATION.md", OUTPUT / "README.md")
    shutil.copy2(SOURCE / "data" / "demo-fixtures.json", data_output / "demo-fixtures.json")
    for filename in REPORTS:
        shutil.copy2(ROOT / "reports" / filename, data_output / filename)

    included = sorted(
        path for path in OUTPUT.rglob("*") if path.is_file() and path.name != "MANIFEST.json"
    )
    manifest = {
        "name": "推荐算法互动实验室 · 可迁移版",
        "dataOrigin": "public",
        "generatedWithoutTraining": True,
        "productionClaim": False,
        "externalNetworkRequired": False,
        "files": {
            str(path.relative_to(OUTPUT)): {
                "sha256": sha256(path),
                "bytes": path.stat().st_size,
            }
            for path in included
        },
    }
    (OUTPUT / "MANIFEST.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    if ARCHIVE.exists():
        ARCHIVE.unlink()
    shutil.make_archive(
        str(ARCHIVE.with_suffix("")),
        "zip",
        root_dir=OUTPUT.parent,
        base_dir=OUTPUT.name,
    )
    print(f"portable directory: {OUTPUT}")
    print(f"portable archive:   {ARCHIVE}")


if __name__ == "__main__":
    export()
