from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import torch

from kai_recsys_lab.pipelines.amazon_end_to_end_v3 import load_v3_config, run_dev_selection, run_final_test
from kai_recsys_lab.pipelines.amazon_retrieval import _file_evidence, prepare_amazon_data
from kai_recsys_lab.pipelines.amazon_two_tower_v2 import (
    build_metadata_catalog,
    save_checkpoint,
    train_metadata_two_tower,
)
from kai_recsys_lab.ranking.dcn import DcnRerankerConfig, DcnStyleReranker
from kai_recsys_lab.ranking.din import DinRerankerConfig, DinStyleReranker, fit_temperature
from kai_recsys_lab.retrieval.frozen_candidates import FrozenHnswIndex, exact_topk


def _write_gzip(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            compressed.write(payload)


def _json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def _candidate(candidate_id: str, model_type: str, negative_sampling: str) -> dict[str, object]:
    result: dict[str, object] = {
        "id": candidate_id,
        "modelType": model_type,
        "retrievalMode": "exact",
        "negativeSampling": negative_sampling,
        "hiddenDims": [8],
        "dropout": 0.0,
        "epochs": 1,
        "batchSize": 512,
        "learningRate": 0.001,
        "weightDecay": 0.0,
    }
    if model_type == "dcn_style":
        result["crossLayers"] = 1
    return result


@pytest.fixture(scope="module")
def v3_fixture(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("amazon-v3")
    raw = root / "data" / "raw"
    users = [f"user-{index:03d}" for index in range(120)]
    first_items = [f"item-a-{index:03d}" for index in range(120)]
    second_items = [f"item-b-{index:03d}" for index in range(120)]
    train_rows: list[dict[str, object]] = []
    dev_rows: list[dict[str, object]] = []
    test_rows: list[dict[str, object]] = []
    for index, user in enumerate(users):
        first = first_items[index]
        second = second_items[index]
        dev_target = second_items[(index + 1) % len(users)]
        test_target = first_items[(index + 2) % len(users)]
        train_rows.extend((
            {"user_id": user, "parent_asin": first, "timestamp": 1_000_000 + index, "history": ""},
            {"user_id": user, "parent_asin": second, "timestamp": 2_000_000 + index, "history": first},
        ))
        dev_rows.append({
            "user_id": user,
            "parent_asin": dev_target,
            "timestamp": 3_000_000 + index,
            "history": f"{first} {second}",
        })
        test_rows.append({
            "user_id": user,
            "parent_asin": test_target,
            "timestamp": 4_000_000 + index,
            "history": f"{first} {second} {dev_target}",
        })
    files = {
        "train": ("train.csv.gz", pd.DataFrame(train_rows)),
        "dev": ("dev.csv.gz", pd.DataFrame(dev_rows)),
        "test": ("test.csv.gz", pd.DataFrame(test_rows)),
    }
    for _, (name, frame) in files.items():
        _write_gzip(raw / name, frame.to_csv(index=False).encode("utf-8"))
    metadata_lines = [
        json.dumps({
            "parent_asin": item,
            "title": f"Industrial fixture {item}",
            "main_category": "Industrial",
            "categories": ["Fixtures", "Offline"],
        }, sort_keys=True)
        for item in first_items + second_items
    ]
    metadata_path = raw / "metadata.jsonl.gz"
    _write_gzip(metadata_path, ("\n".join(metadata_lines) + "\n").encode("utf-8"))

    data_contract = {
        "dataset": {
            "rawDir": str(raw),
            "files": {split: {"name": value[0]} for split, value in files.items()},
        }
    }
    data = prepare_amazon_data(raw, data_contract)
    metadata = build_metadata_catalog(
        metadata_path,
        data.catalog,
        max_vocabulary=128,
        max_title_tokens=8,
        max_category_tokens=4,
    )
    v2_candidate = {
        "id": "fixture-v2",
        "embeddingDim": 8,
        "hiddenDim": 12,
        "outputDim": 8,
        "negativeSampling": "in_batch",
        "temperature": 0.07,
        "epochs": 1,
        "batchSize": 128,
        "learningRate": 0.001,
        "maxHistory": 5,
    }
    v2_model, _ = train_metadata_two_tower(data, metadata, v2_candidate, seed=3407)
    checkpoint = root / "artifacts" / "v2" / "fixture.pt"
    checkpoint_evidence = save_checkpoint(
        v2_model,
        checkpoint,
        candidate=v2_candidate,
        seed=3407,
        data=data,
        metadata=metadata,
    )
    v2_config_path = root / "configs" / "v2.json"
    _json(v2_config_path, {"schemaVersion": 1, "candidate": v2_candidate})
    v2_result_path = root / "reports" / "v2.json"
    _json(v2_result_path, {
        "status": "COMPLETE",
        "evidence": {
            "splitSha256": data.split_hash,
            "metadata": {"featureSha256": metadata.evidence["featureSha256"]},
        },
        "selectedCandidate": {"id": "fixture-v2"},
        "test": {"perSeed": {"3407": {"checkpoint": {"sha256": checkpoint_evidence["sha256"]}}}},
    })
    dataset_files = {
        split: {
            "name": name,
            "expectedBytes": _file_evidence(raw / name)["bytes"],
            "expectedSha256": _file_evidence(raw / name)["sha256"],
        }
        for split, (name, _) in files.items()
    }
    config = {
        "schemaVersion": 1,
        "experimentId": "fixture-amazon-end-to-end-v3",
        "dataOrigin": "public",
        "claimableOnlinePerformance": False,
        "dataset": {"rawDir": "data/raw", "files": dataset_files},
        "metadata": {
            "file": metadata_path.name,
            "expectedBytes": _file_evidence(metadata_path)["bytes"],
            "expectedSha256": _file_evidence(metadata_path)["sha256"],
            "maxVocabulary": 128,
            "maxTitleTokens": 8,
            "maxCategoryTokens": 4,
        },
        "frozenV2": {
            "config": "configs/v2.json",
            "configSha256": _file_evidence(v2_config_path)["sha256"],
            "result": "reports/v2.json",
            "resultSha256": _file_evidence(v2_result_path)["sha256"],
            "checkpoint": "artifacts/v2/fixture.pt",
            "checkpointSha256": checkpoint_evidence["sha256"],
            "checkpointSeed": 3407,
            "selectedCandidateId": "fixture-v2",
            "splitSha256": data.split_hash,
            "metadataFeatureSha256": metadata.evidence["featureSha256"],
        },
        "protocol": {
            "selectionSplit": "dev",
            "selectionSeed": 3407,
            "selectionMetric": "ndcg@100",
            "seeds": [3407, 6502, 9109],
            "ks": [20, 50, 100],
            "testTuningForbidden": True,
            "testExecutionLimit": 1,
            "calibrationSplit": "train_only",
            "pairedEvaluation": True,
        },
        "retrieval": {
            "candidateK": 100,
            "exactBatchSize": 32,
            "hnsw": {"efConstruction": 40, "m": 8, "efSearch": 180, "seed": 3407},
        },
        "training": {
            "maxQueries": 120,
            "hardNegatives": 2,
            "maxHistory": 5,
            "calibrationFraction": 0.2,
            "temperatureGrid": [0.5, 1.0, 2.0],
            "scoreBatchSize": 1024,
            "scoreQueryBatch": 32,
            "ablationQueryLimit": 120,
        },
        "candidateConfigs": [
            _candidate("din-hard", "din_style", "hard"),
            _candidate("dcn-hard", "dcn_style", "hard"),
            _candidate("din-uniform", "din_style", "uniform"),
            _candidate("din-inbatch", "din_style", "in_batch"),
        ],
        "hnswSweep": {
            "queryLimit": 20,
            "k": 20,
            "warmupQueries": 1,
            "seed": 3407,
            "configs": [
                {"efConstruction": 30, "m": 4, "efSearch": 30},
                {"efConstruction": 40, "m": 8, "efSearch": 80},
            ],
        },
        "statistics": {"confidenceLevel": 0.95, "bootstrapSamples": 50, "bootstrapSeed": 20260827},
        "artifactsDir": "artifacts/v3",
        "output": "reports/v3.json",
    }
    config_path = root / "configs" / "v3.json"
    _json(config_path, config)
    return config_path


def test_frozen_retrieval_and_din_dcn_helpers_are_finite() -> None:
    rng = np.random.default_rng(7)
    items = rng.normal(size=(120, 8)).astype(np.float32)
    users = rng.normal(size=(3, 8)).astype(np.float32)
    exclusions = (np.asarray([0, 1]), np.asarray([2]), np.asarray([], dtype=np.int32))
    exact = exact_topk(users, items, exclusions, k=20, batch_size=2)
    index = FrozenHnswIndex(
        dimension=8, item_count=120, ef_construction=40, m=8, ef_search=100, seed=7
    ).fit(items)
    approximate = index.query(users, items, exclusions, k=20)
    assert exact.item_indices.shape == approximate.item_indices.shape == (3, 20)
    assert 0 not in exact.item_indices[0] and 2 not in approximate.item_indices[1]
    common = (torch.randn(4, 8), torch.randn(4, 8), torch.randn(4, 3, 8), torch.ones(4, 3, dtype=torch.bool), torch.randn(4, 8))
    din = DinStyleReranker(DinRerankerConfig(8, 8, (8,)))
    dcn = DcnStyleReranker(DcnRerankerConfig(8, 8, (8,), cross_layers=1))
    assert torch.isfinite(din(*common)).all() and torch.isfinite(dcn(*common)).all()
    calibration = fit_temperature(np.asarray([-1.0, 1.0]), np.asarray([0.0, 1.0]), [0.5, 1.0])
    assert calibration.example_count == 2


def test_v3_dev_selection_and_one_shot_paired_test(v3_fixture: Path) -> None:
    config = load_v3_config(v3_fixture)
    assert {row["negativeSampling"] for row in config["candidateConfigs"]} == {"hard", "uniform", "in_batch"}
    selection = run_dev_selection(v3_fixture)
    assert selection["status"] == "DEV_SELECTION_COMPLETE_TEST_UNSEEN"
    assert selection["testMetrics"] is None
    assert selection["negativeSamplingContract"]["executedStrategies"] == ["hard", "in_batch", "uniform"]
    assert all(selection["modelComparison"].values())
    assert len(selection["hnswSweep"]["points"]) == 2
    assert {row["variant"] for row in selection["metadataAblations"]["rows"]} == {
        "full", "without_metadata", "without_id", "without_title", "without_category",
    }
    result = run_final_test(v3_fixture)
    assert result["status"] == "COMPLETE"
    assert result["protocol"]["testExecutionCount"] == 1
    assert result["results"]["confidenceInterval"]["resampling_unit"] == "user"
    assert result["test"]["cohorts"]["selectedReranker"]["queryCount"] == 120
    with pytest.raises(FileExistsError, match="already started or completed"):
        run_final_test(v3_fixture)


def test_v3_hash_contract_fails_closed_before_execution(v3_fixture: Path) -> None:
    config = json.loads(v3_fixture.read_text(encoding="utf-8"))
    config["dataset"]["files"]["train"]["expectedSha256"] = "0" * 64
    tampered = v3_fixture.with_name("v3-tampered.json")
    _json(tampered, config)
    with pytest.raises(ValueError, match="SHA-256 differs"):
        run_dev_selection(tampered)
