from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from kai_recsys_lab.pipelines.amazon_retrieval import (
    _batched_dot_topk,
    _sequence_rerank_topk,
    _sequence_training_arrays,
    _train_sequence_model,
    bpr_topk,
    itemknn_topk,
    load_config,
    popularity_topk,
    prepare_amazon_data,
    ranking_metrics,
    train_bpr,
    train_two_tower_public,
    two_tower_vectors,
)
from kai_recsys_lab.sequence.models import DinSequenceScorer, MeanPoolingSequenceScorer


def _write_fixture(root: Path) -> dict:
    rows = {
        "train": [
            ("u1", "a", 100, ""),
            ("u1", "b", 110, "a"),
            ("u1", "c", 120, "a b"),
            ("u2", "a", 101, ""),
            ("u2", "d", 111, "a"),
            ("u2", "e", 121, "a d"),
            ("u3", "b", 102, ""),
            ("u3", "d", 112, "b"),
            ("u3", "f", 122, "b d"),
        ],
        "dev": [
            ("u1", "d", 130, "a b c"),
            ("u2", "b", 131, "a d e"),
            ("u3", "a", 132, "b d f"),
        ],
        "test": [
            ("u1", "e", 140, "a b c d"),
            ("u2", "c", 141, "a d e b"),
            ("u3", "e", 142, "b d f a"),
        ],
    }
    files = {}
    for split, values in rows.items():
        name = f"fixture.{split}.csv.gz"
        pd.DataFrame(values, columns=["user_id", "parent_asin", "timestamp", "history"]).to_csv(
            root / name, index=False, compression="gzip"
        )
        files[split] = {"name": name, "url": f"https://example.invalid/{name}"}
    config = {
        "experimentId": "fixture",
        "dataOrigin": "public",
        "dataset": {"rawDir": str(root), "files": files},
        "protocol": {"seeds": [3407, 6502, 9109], "ks": [20, 50, 100]},
        "bpr": {
            "factors": 4,
            "epochs": 2,
            "batchSize": 4,
            "learningRate": 0.02,
            "regularization": 0.0001,
        },
        "twoTower": {
            "embeddingDim": 4,
            "hiddenDim": 8,
            "outputDim": 4,
            "temperature": 0.2,
            "epochs": 2,
            "batchSize": 4,
            "learningRate": 0.01,
            "maxHistory": 4,
        },
    }
    return config


def _assert_history_excluded(rows: np.ndarray, histories: tuple[np.ndarray, ...]) -> None:
    for candidates, history in zip(rows, histories, strict=True):
        assert set(candidates.tolist()).isdisjoint(history.tolist())


def test_official_split_preparation_and_metrics(tmp_path: Path) -> None:
    config = _write_fixture(tmp_path)
    data = prepare_amazon_data(tmp_path, config)

    assert len(data.train) == 9
    assert len(data.test_query_users) == 3
    assert data.catalog == ("a", "b", "c", "d", "e", "f")
    assert data.exclusions["testExcludedTotal"] == 0
    assert len(data.split_hash) == 64

    rankings = np.asarray([[4, 5], [5, 2], [4, 2]], dtype=np.int32)
    metrics = ranking_metrics(rankings, data.test_targets, [1, 2])
    assert metrics["1"]["queryCount"] == 3
    assert metrics["2"]["recall"] == 1.0
    assert metrics["2"]["hitRate"] == 1.0


def test_four_models_share_catalog_and_exclude_full_query_history(tmp_path: Path) -> None:
    config = _write_fixture(tmp_path)
    data = prepare_amazon_data(tmp_path, config)

    popularity = popularity_topk(data, k=2)
    itemknn = itemknn_topk(data, k=2, batch_size=2)
    bpr = bpr_topk(train_bpr(data, config["bpr"], 3407), data, k=2)
    tower = train_two_tower_public(data, config["twoTower"], 3407)
    user_vectors, item_vectors, exclusions = two_tower_vectors(tower, data, config["twoTower"])
    two_tower = _batched_dot_topk(user_vectors, item_vectors, exclusions, k=2, batch_size=2)

    assert popularity.shape == itemknn.shape == bpr.shape == two_tower.shape == (3, 2)
    for rows in (popularity, itemknn, bpr, two_tower):
        assert np.all((0 <= rows) & (rows < len(data.catalog)))
        _assert_history_excluded(rows, data.test_histories)


def test_frozen_config_rejects_seed_or_k_drift(tmp_path: Path) -> None:
    source = Path(__file__).parents[1] / "configs" / "amazon-retrieval-v1.json"
    config = json.loads(source.read_text(encoding="utf-8"))
    config["protocol"]["seeds"] = [1]
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(config), encoding="utf-8")

    try:
        load_config(path)
    except ValueError as error:
        assert "seed protocol" in str(error)
    else:
        raise AssertionError("seed drift must fail closed")


def test_mean_pooling_and_din_share_training_negatives_and_candidates(tmp_path: Path) -> None:
    config = _write_fixture(tmp_path)
    data = prepare_amazon_data(tmp_path, config)
    _, positives, negatives, histories = _sequence_training_arrays(data, max_history=4, seed=3407)
    candidates = itemknn_topk(data, k=2, batch_size=2)
    sequence_config = {
        "maxHistory": 4,
        "epochs": 1,
        "batchSize": 4,
        "evaluationQueryBatchSize": 2,
        "learningRate": 0.01,
    }
    models = (
        MeanPoolingSequenceScorer(len(data.catalog) + 2, 4, 8),
        DinSequenceScorer(len(data.catalog) + 2, 4, 8, 4),
    )
    for model in models:
        trained = _train_sequence_model(
            model,
            histories,
            positives,
            negatives,
            sequence_config,
            seed=3407,
            device=torch.device("cpu"),
        )
        reranked = _sequence_rerank_topk(
            trained,
            data.test_histories,
            candidates,
            sequence_config,
            device=torch.device("cpu"),
        )
        assert reranked.shape == candidates.shape
        assert all(set(left) == set(right) for left, right in zip(reranked.tolist(), candidates.tolist(), strict=True))
