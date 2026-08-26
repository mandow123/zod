from __future__ import annotations

import csv
from pathlib import Path

from kai_recsys_lab.contracts import BinaryExample, DataOrigin, Split
from kai_recsys_lab.pipelines.criteo_ctr import (
    CATEGORICAL_NAMES,
    NUMERIC_NAMES,
    TrainFittedCriteoPreprocessor,
    fixed_source_order_split,
    run_criteo_ctr_experiment,
)


def _example(index: int, *, category: str | None = None) -> BinaryExample:
    features: dict[str, float | str] = {
        name: float((index + offset) % 11)
        for offset, name in enumerate(NUMERIC_NAMES)
    }
    features.update(
        {
            name: category if category is not None else f"value-{(index + offset) % 7}"
            for offset, name in enumerate(CATEGORICAL_NAMES)
        }
    )
    label = 1 if index % 5 == 0 else 0
    return BinaryExample(
        example_id=f"row-{index}",
        timestamp_ms=index + 1,
        split=Split.TRAIN,
        origin=DataOrigin.PUBLIC,
        label=label,
        clicked=label,
        features=features,
    )


def _write_display_tsv(path: Path, rows: int = 120) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, delimiter="\t", lineterminator="\n")
        for index in range(rows):
            writer.writerow(
                [1 if index % 5 == 0 else 0]
                + [(index + offset) % 11 for offset in range(len(NUMERIC_NAMES))]
                + [
                    f"value-{(index + offset) % 7}"
                    for offset in range(len(CATEGORICAL_NAMES))
                ]
            )


def test_fixed_source_order_split_is_stable_and_disjoint() -> None:
    rows = [_example(index) for index in range(100)]
    first = fixed_source_order_split(rows, train_fraction=0.7, dev_fraction=0.15)
    second = fixed_source_order_split(rows, train_fraction=0.7, dev_fraction=0.15)
    assert (len(first.train), len(first.dev), len(first.test)) == (70, 15, 15)
    assert first.digest == second.digest
    identities = [
        {row.example_id for row in partition}
        for partition in (first.train, first.dev, first.test)
    ]
    assert identities[0].isdisjoint(identities[1])
    assert identities[0].isdisjoint(identities[2])
    assert identities[1].isdisjoint(identities[2])


def test_preprocessor_fits_categories_on_train_only() -> None:
    train = [_example(index, category="seen") for index in range(12)]
    preprocessor = TrainFittedCriteoPreprocessor(
        min_category_count=1,
        max_categories_per_feature=10,
    ).fit(train)
    transformed = preprocessor.transform([_example(99, category="dev-only")])
    assert all(transformed[0][name] == "__OOV__" for name in CATEGORICAL_NAMES)
    assert preprocessor.fitted_example_ids == tuple(row.example_id for row in train)


def test_public_pipeline_reports_fixed_protocol_and_all_models(tmp_path: Path) -> None:
    data_path = tmp_path / "display.tsv"
    _write_display_tsv(data_path)
    config = {
        "experimentId": "test-criteo-ctr",
        "seeds": [3407, 6502, 9109],
        "source": {
            "id": "criteo-1tb-click-logs",
            "officialUrl": "https://ailab.criteo.com/download-criteo-1tb-click-logs-dataset/",
            "termsUrl": "https://ailab.criteo.com/ressources/criteo-1tb-click-logs-dataset-for-mlperf/",
            "terms": "CC BY-NC-SA 4.0 noncommercial research use.",
            "license": "CC-BY-NC-SA-4.0",
        },
        "dataset": {
            "rawFile": str(data_path),
            "inputTsv": str(data_path),
            "rowLimit": 120,
            "samplingRule": "complete synthetic test fixture",
        },
        "split": {"trainFraction": 0.7, "devFraction": 0.15},
        "preprocessing": {
            "minCategoryCount": 1,
            "maxCategoriesPerFeature": 20,
        },
        "training": {
            "device": "cpu",
            "epochs": 1,
            "batchSize": 64,
            "learningRate": 0.001,
            "weightDecay": 0.0,
        },
        "models": {
            "lr": {"maxIter": 50},
            "deepfm": {"embeddingDim": 2, "hiddenDims": [8]},
            "dcnv2": {"embeddingDim": 2, "crossDepth": 1, "hiddenDims": [8]},
        },
        "limitations": ["test fixture only"],
    }
    report = run_criteo_ctr_experiment(config)
    assert report["status"] == "COMPLETE"
    assert report["dataOrigin"] == "public"
    assert report["claimableOnlinePerformance"] is False
    assert report["protocol"]["rows"] == {"train": 84, "dev": 18, "test": 18}
    assert report["protocol"]["features"] == {
        "numeric": 13,
        "categorical": 26,
        "sameFeatureSetForAllModels": True,
    }
    assert report["protocol"]["testDataUsedForSelection"] is False
    assert set(report["results"]["summary"]) == {
        "logistic_regression",
        "deepfm",
        "dcnv2",
    }
    assert len(report["results"]["runs"]) == 9
    for run in report["results"]["runs"]:
        assert set(run["testMetrics"]) >= {
            "rocAuc",
            "prAuc",
            "logLoss",
            "brierScore",
            "ece",
        }
