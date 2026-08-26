from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from kai_recsys_lab.pipelines.amazon_retrieval import _batched_dot_topk, prepare_amazon_data, ranking_metrics
from kai_recsys_lab.pipelines.amazon_two_tower_v2 import (
    build_metadata_catalog,
    load_checkpoint,
    metadata_two_tower_vectors,
    save_checkpoint,
    train_metadata_two_tower,
    write_user_recall_trace,
)
from kai_recsys_lab.retrieval.metadata_two_tower import MetadataTwoTower, MetadataTwoTowerConfig


def _fixture(root: Path) -> tuple[dict, Path]:
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
        files[split] = {"name": name}
    metadata_path = root / "metadata.jsonl.gz"
    with gzip.open(metadata_path, "wt", encoding="utf-8") as handle:
        for item in "abcdef":
            handle.write(
                json.dumps(
                    {
                        "parent_asin": item,
                        "title": f"Industrial tool {item}",
                        "main_category": "Tools",
                        "categories": ["Industrial", "Testing"],
                    }
                )
                + "\n"
            )
    return {
        "dataset": {"rawDir": str(root), "files": files},
        "protocol": {"seeds": [3407, 6502, 9109], "ks": [20, 50, 100]},
    }, metadata_path


def _candidate(sampling: str = "in_batch") -> dict:
    return {
        "id": f"fixture-{sampling}",
        "embeddingDim": 4,
        "hiddenDim": 8,
        "outputDim": 4,
        "negativeSampling": sampling,
        "temperature": 0.2,
        "epochs": 2,
        "batchSize": 4,
        "learningRate": 0.01,
        "maxHistory": 4,
    }


def test_metadata_catalog_is_aligned_and_deterministic(tmp_path: Path) -> None:
    config, metadata_path = _fixture(tmp_path)
    data = prepare_amazon_data(tmp_path, config)
    left = build_metadata_catalog(
        metadata_path,
        data.catalog,
        max_vocabulary=32,
        max_title_tokens=4,
        max_category_tokens=4,
    )
    right = build_metadata_catalog(
        metadata_path,
        data.catalog,
        max_vocabulary=32,
        max_title_tokens=4,
        max_category_tokens=4,
    )

    assert left.title_token_ids.shape == (len(data.catalog) + 2, 4)
    assert left.evidence["matchedCoverage"] == 1.0
    assert left.evidence["featureSha256"] == right.evidence["featureSha256"]
    assert np.array_equal(left.title_token_ids, right.title_token_ids)


def test_metadata_changes_item_representation_and_padding_is_safe() -> None:
    config = MetadataTwoTowerConfig(
        num_users=5,
        num_items=5,
        metadata_vocabulary_size=8,
        embedding_dim=4,
        hidden_dim=8,
        output_dim=4,
    )
    titles = torch.tensor([[0, 0], [0, 0], [2, 3], [4, 5], [6, 7]], dtype=torch.long)
    categories = torch.tensor([[0], [0], [2], [3], [4]], dtype=torch.long)
    model = MetadataTwoTower(config, title_token_ids=titles, category_token_ids=categories)
    vectors = model.encode_items(torch.tensor([0, 2, 3]))

    assert torch.isfinite(vectors).all()
    assert not torch.allclose(vectors[1], vectors[2])


def test_training_checkpoint_round_trip_and_hashed_user_trace(tmp_path: Path) -> None:
    config, metadata_path = _fixture(tmp_path)
    data = prepare_amazon_data(tmp_path, config)
    metadata = build_metadata_catalog(
        metadata_path,
        data.catalog,
        max_vocabulary=32,
        max_title_tokens=4,
        max_category_tokens=4,
    )
    candidate = _candidate("uniform_unseen")
    model, losses = train_metadata_two_tower(data, metadata, candidate, seed=3407)
    checkpoint = tmp_path / "model.pt"
    evidence = save_checkpoint(
        model,
        checkpoint,
        candidate=candidate,
        seed=3407,
        data=data,
        metadata=metadata,
    )
    loaded, payload = load_checkpoint(checkpoint, data, metadata)

    with torch.no_grad():
        original = model.encode_items(torch.arange(2, len(data.catalog) + 2))
        restored = loaded.encode_items(torch.arange(2, len(data.catalog) + 2))
    assert losses[-1] <= losses[0]
    assert evidence["bytes"] > 0
    assert payload["seed"] == 3407
    assert torch.equal(original, restored)

    users, items, exclusions = metadata_two_tower_vectors(loaded, data, candidate, split="test")
    topk = _batched_dot_topk(users, items, exclusions, k=2)
    assert ranking_metrics(topk, data.test_targets, [1, 2])["2"]["queryCount"] == 3
    trace = tmp_path / "trace.jsonl.gz"
    trace_evidence = write_user_recall_trace(trace, data=data, topk=topk, split="test")
    with gzip.open(trace, "rt", encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle]
    assert trace_evidence["rows"] == 3
    assert all(row["userAlias"] not in {"u1", "u2", "u3"} for row in rows)
    assert all(row["targetItemAlias"] not in set(data.catalog) for row in rows)
    assert all(len(row["top100ItemAliases"]) == 2 for row in rows)
