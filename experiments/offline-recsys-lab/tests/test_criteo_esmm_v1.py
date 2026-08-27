from __future__ import annotations

import csv
import gzip
import hashlib
from pathlib import Path

import pytest

from kai_recsys_lab.pipelines.criteo_esmm_v1 import (
    CATEGORICAL_FEATURES,
    FEATURE_ALLOWLIST,
    OFFICIAL_COLUMNS,
    ArtifactGateError,
    FrozenTestOnceGate,
    TrainOnlyAttributionPreprocessor,
    assess_artifact_readiness,
    frozen_temporal_split,
    load_attribution_impressions,
    load_config,
    render_markdown_report,
    run_criteo_esmm_experiment,
    write_report,
)


def _write_fixture(path: Path, *, row_count: int = 120) -> tuple[int, str]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=OFFICIAL_COLUMNS, delimiter="\t")
        writer.writeheader()
        for index in range(row_count):
            click = int(index % 3 != 0)
            post_click_conversion = int(click == 1 and index % 10 in {1, 2})
            view_through_conversion = int(click == 0 and index % 37 == 0)
            conversion = int(post_click_conversion or view_through_conversion)
            timestamp = index * 100
            row = {
                "timestamp": timestamp,
                "uid": f"uid-{index % 17}",
                "campaign": "test-only-campaign" if index >= 102 else f"campaign-{index % 4}",
                "conversion": conversion,
                "conversion_timestamp": timestamp + 60 if conversion else -1,
                "conversion_id": 10_000 + index if conversion else -1,
                "attribution": int(conversion == 1 and index % 2 == 0),
                "click": click,
                "click_pos": 0 if post_click_conversion else -1,
                "click_nb": 1 if post_click_conversion else -1,
                "cost": 0.001 + (index % 13) * 0.0001,
                "cpo": 0.2 if conversion else 0.0,
                "time_since_last_click": index if click else -1,
            }
            row.update({name: f"{name}-value-{index % 5}" for name in CATEGORICAL_FEATURES if name != "campaign"})
            writer.writerow(row)
    payload = path.read_bytes()
    return len(payload), hashlib.sha256(payload).hexdigest()


def _synthetic_config(path: Path, *, size: int, sha256: str) -> dict:
    return {
        "experimentId": "synthetic-test-only-criteo-esmm-v1",
        "protocolVersion": "criteo-esmm-v1",
        "seeds": [3407],
        "source": {
            "license": "SYNTHETIC_TEST_ONLY",
            "usage": "unit_test_only",
            "officialRepositoryRevision": "not_applicable",
        },
        "dataset": {
            "dataOrigin": "synthetic_test_only",
            "artifactPath": str(path),
            "expectedBytes": size,
            "expectedSha256": sha256,
            "rowLimit": 120,
            "samplingRule": "deterministic synthetic fixture; never a public result",
        },
        "labels": {
            "click": "synthetic click",
            "rawConversion30d": "synthetic raw conversion including view-through rows",
            "ctcvrDefinition": "click_x_raw_conversion_30d",
            "postClickCvrEvaluation": "clicked rows only",
            "attribution": "audit only",
        },
        "features": {"allowlist": list(FEATURE_ALLOWLIST)},
        "split": {"trainFraction": 0.7, "devFraction": 0.15, "testFraction": 0.15},
        "preprocessing": {"minCategoryCount": 1, "maxCategoriesPerFeature": 100},
        "training": {
            "device": "cpu",
            "epochs": 1,
            "batchSize": 32,
            "learningRate": 0.005,
            "weightDecay": 0.0,
        },
        "models": {"embeddingDim": 4, "hiddenDims": [8, 4]},
        "metrics": {"eceBins": 4},
        "limitations": ["synthetic unit fixture is not experiment evidence"],
    }


def test_loader_keeps_raw_conversion_and_ctcvr_boundaries_distinct(tmp_path: Path) -> None:
    artifact = tmp_path / "fixture.tsv.gz"
    _write_fixture(artifact)
    rows = load_attribution_impressions(artifact, row_limit=120)

    view_through = [row for row in rows if row.raw_conversion_30d == 1 and row.click == 0]
    assert view_through
    assert all(row.ctcvr == 0 for row in view_through)
    assert all("uid" not in row.features for row in rows)
    assert all("attribution" not in row.features for row in rows)
    assert tuple(rows[index].timestamp for index in range(len(rows))) == tuple(
        sorted(row.timestamp for row in rows)
    )


def test_temporal_split_and_preprocessing_are_train_only(tmp_path: Path) -> None:
    artifact = tmp_path / "fixture.tsv.gz"
    _write_fixture(artifact)
    rows = load_attribution_impressions(artifact, row_limit=120)
    split = frozen_temporal_split(rows, train_fraction=0.7, dev_fraction=0.15)
    preprocessor = TrainOnlyAttributionPreprocessor(
        min_category_count=1, max_categories_per_feature=100
    ).fit(split.train)
    transformed_test = preprocessor.transform(split.test)

    assert len(split.train) == 84
    assert len(split.dev) == 18
    assert len(split.test) == 18
    assert preprocessor.fitted_row_ids == tuple(row.row_id for row in split.train)
    assert all(record["campaign"] == "__OOV__" for record in transformed_test)
    assert split.train[-1].timestamp <= split.dev[0].timestamp <= split.test[0].timestamp


def test_artifact_gate_fails_closed_on_identity_mismatch(tmp_path: Path) -> None:
    artifact = tmp_path / "fixture.tsv.gz"
    size, sha256 = _write_fixture(artifact)
    config = _synthetic_config(artifact, size=size, sha256="0" * 64)

    readiness = assess_artifact_readiness(config)
    assert readiness["status"] == "BLOCKED_NOT_RUN"
    assert readiness["expectedSha256"] == "0" * 64
    assert readiness["observedSha256"] == sha256
    with pytest.raises(ArtifactGateError):
        run_criteo_esmm_experiment(config)


def test_test_once_gate_rejects_second_access() -> None:
    gate = FrozenTestOnceGate(lambda: {"frozen": "test"})
    assert gate.consume() == {"frozen": "test"}
    assert gate.access_count == 1
    with pytest.raises(RuntimeError, match="already been consumed"):
        gate.consume()
    assert gate.access_count == 1


def test_synthetic_full_path_is_test_only_and_cannot_write_reports(tmp_path: Path) -> None:
    artifact = tmp_path / "fixture.tsv.gz"
    size, sha256 = _write_fixture(artifact)
    config = _synthetic_config(artifact, size=size, sha256=sha256)

    report = run_criteo_esmm_experiment(config)

    assert report["status"] == "SYNTHETIC_TEST_ONLY"
    assert report["dataOrigin"] == "synthetic_test_only"
    assert report["testOnceGate"] == {
        "accessCount": 1,
        "usedForSelection": False,
        "policy": "one bundled evaluation after all checkpoints are frozen",
    }
    run = report["results"]["runs"][0]
    assert run["selection"]["testDataUsedForSelection"] is False
    assert set(run["testMetrics"]["esmm"]) == {"ctr", "ctcvr", "postClickCvr"}
    for model_metrics in (
        run["testMetrics"]["naiveClickedOnlyCvr"]["postClickCvr"],
        run["testMetrics"]["esmm"]["ctr"],
        run["testMetrics"]["esmm"]["ctcvr"],
        run["testMetrics"]["esmm"]["postClickCvr"],
    ):
        assert set(("auc", "logLoss", "brier", "ece")).issubset(model_metrics)
    with pytest.raises(ValueError, match="complete official-public"):
        write_report(report, tmp_path / "forbidden.json")
    with pytest.raises(ValueError, match="complete official-public"):
        render_markdown_report(report)
    assert not (tmp_path / "forbidden.json").exists()


def test_public_config_pins_official_criteo_revision_and_artifact() -> None:
    project_root = Path(__file__).resolve().parents[1]
    config = load_config(project_root / "configs" / "criteo-esmm-v1.json")

    assert config["source"]["publisher"] == "Criteo AI Lab"
    assert config["source"]["officialRepository"].startswith(
        "https://huggingface.co/datasets/criteo/"
    )
    assert config["source"]["officialRepositoryRevision"] == (
        "904188a63cbad78bee43cd26ff5ee4ac77903986"
    )
    assert config["source"]["license"] == "CC-BY-NC-SA-4.0"
    assert config["dataset"]["expectedBytes"] == 653_015_824
    assert config["dataset"]["expectedSha256"] == (
        "94ac7a465564349bc7ba008602211d5990a3c53cc133abc0aadef61ea2391a98"
    )
    assert config["labels"]["ctcvrDefinition"] == "click_x_raw_conversion_30d"
    assert tuple(config["features"]["allowlist"]) == FEATURE_ALLOWLIST
