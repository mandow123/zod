from __future__ import annotations

import gzip
import hashlib
import io
import json
import math
import os
import re
import time
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
import torch

from kai_recsys_lab.pipelines.amazon_retrieval import (
    PreparedAmazonData,
    _batched_dot_topk,
    _encode_history,
    _file_evidence,
    _history_matrix,
    _metric_summary,
    _sample_unseen_negatives,
    _seed_everything,
    _sha256_bytes,
    _train_pairs,
    prepare_amazon_data,
    ranking_metrics,
)
from kai_recsys_lab.retrieval.metadata_two_tower import MetadataTwoTower, MetadataTwoTowerConfig


TOKEN_PATTERN = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True, slots=True)
class MetadataCatalog:
    title_token_ids: np.ndarray
    category_token_ids: np.ndarray
    vocabulary: Mapping[str, int]
    evidence: Mapping[str, Any]


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _tokens(value: str) -> list[str]:
    return TOKEN_PATTERN.findall(value.lower())


def load_v2_config(path: str | Path) -> dict[str, Any]:
    config = json.loads(Path(path).read_text(encoding="utf-8"))
    if config.get("dataOrigin") != "public" or config.get("claimableOnlinePerformance") is not False:
        raise ValueError("V2 is public offline research and cannot claim online performance")
    protocol = config.get("protocol", {})
    if protocol.get("seeds") != [3407, 6502, 9109]:
        raise ValueError("V2 final seed protocol must remain [3407, 6502, 9109]")
    if protocol.get("selectionSeed") != 3407:
        raise ValueError("V2 dev selection seed must remain 3407")
    if protocol.get("ks") != [20, 50, 100]:
        raise ValueError("V2 K protocol must remain [20, 50, 100]")
    if protocol.get("selectionMetric") != "ndcg@100":
        raise ValueError("V2 selection metric must remain dev NDCG@100")
    candidates = config.get("candidateConfigs", [])
    if len(candidates) != 3 or len({row.get("id") for row in candidates}) != 3:
        raise ValueError("V2 must compare exactly three preregistered candidates")
    allowed_sampling = {"in_batch", "uniform_unseen"}
    if any(row.get("negativeSampling") not in allowed_sampling for row in candidates):
        raise ValueError("unsupported negative-sampling protocol")
    metadata = config.get("metadata", {})
    if metadata.get("expectedBytes") != 281523932:
        raise ValueError("official metadata byte boundary drifted")
    if metadata.get("expectedSha256") != "0beb251cec166347a3ec3ef23e55ec89f7fb27a6e8e9a0737d6b34cdc184ebcb":
        raise ValueError("official metadata digest boundary drifted")
    return config


def build_metadata_catalog(
    metadata_path: str | Path,
    catalog: Sequence[str],
    *,
    max_vocabulary: int,
    max_title_tokens: int,
    max_category_tokens: int,
) -> MetadataCatalog:
    if min(max_vocabulary, max_title_tokens, max_category_tokens) < 2:
        raise ValueError("metadata vocabulary and token limits must be positive")
    path = Path(metadata_path)
    if not path.is_file():
        raise FileNotFoundError(f"official Amazon metadata is missing: {path}")
    required = set(catalog)
    rows: dict[str, tuple[list[str], list[str]]] = {}
    malformed = 0
    metadata_rows = 0
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            metadata_rows += 1
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                malformed += 1
                continue
            item_id = str(payload.get("parent_asin") or "")
            if item_id not in required:
                continue
            title_tokens = _tokens(str(payload.get("title") or ""))
            category_values = [str(payload.get("main_category") or "")]
            categories = payload.get("categories") or []
            if isinstance(categories, list):
                category_values.extend(str(value) for value in categories)
            category_tokens = _tokens(" ".join(category_values))
            rows[item_id] = (title_tokens, category_tokens)

    frequencies: Counter[str] = Counter()
    for title_tokens, category_tokens in rows.values():
        frequencies.update(title_tokens)
        frequencies.update(category_tokens)
    retained = sorted(frequencies, key=lambda token: (-frequencies[token], token))[: max_vocabulary - 2]
    vocabulary = {token: index + 2 for index, token in enumerate(retained)}
    title_ids = np.zeros((len(catalog) + 2, max_title_tokens), dtype=np.int64)
    category_ids = np.zeros((len(catalog) + 2, max_category_tokens), dtype=np.int64)
    title_present = category_present = 0

    def encode(values: Sequence[str], width: int) -> np.ndarray:
        encoded = [vocabulary.get(token, 1) for token in values[:width]]
        output = np.zeros(width, dtype=np.int64)
        if encoded:
            output[: len(encoded)] = encoded
        return output

    for item_index, item_id in enumerate(catalog, start=2):
        title_tokens, category_tokens = rows.get(item_id, ([], []))
        title_ids[item_index] = encode(title_tokens, max_title_tokens)
        category_ids[item_index] = encode(category_tokens, max_category_tokens)
        title_present += int(bool(title_tokens))
        category_present += int(bool(category_tokens))

    array_digest = hashlib.sha256()
    array_digest.update(title_ids.tobytes(order="C"))
    array_digest.update(category_ids.tobytes(order="C"))
    array_digest.update(_canonical_json(vocabulary))
    file_evidence = _file_evidence(path)
    evidence = {
        "metadataRows": metadata_rows,
        "malformedRows": malformed,
        "catalogItems": len(catalog),
        "matchedItems": len(rows),
        "matchedCoverage": len(rows) / len(catalog),
        "titlePresent": title_present,
        "categoryPresent": category_present,
        "vocabularySizeIncludingPadUnk": len(vocabulary) + 2,
        "featureSha256": array_digest.hexdigest(),
        "file": {
            "name": path.name,
            "bytes": file_evidence["bytes"],
            "sha256": file_evidence["sha256"],
        },
    }
    return MetadataCatalog(title_ids, category_ids, vocabulary, evidence)


def _make_model(
    data: PreparedAmazonData,
    metadata: MetadataCatalog,
    candidate: Mapping[str, Any],
) -> MetadataTwoTower:
    config = MetadataTwoTowerConfig(
        num_users=len(data.users) + 2,
        num_items=len(data.catalog) + 2,
        metadata_vocabulary_size=len(metadata.vocabulary) + 2,
        embedding_dim=int(candidate["embeddingDim"]),
        hidden_dim=int(candidate["hiddenDim"]),
        output_dim=int(candidate["outputDim"]),
        temperature=float(candidate["temperature"]),
    )
    return MetadataTwoTower(
        config,
        title_token_ids=torch.from_numpy(metadata.title_token_ids),
        category_token_ids=torch.from_numpy(metadata.category_token_ids),
    )


def train_metadata_two_tower(
    data: PreparedAmazonData,
    metadata: MetadataCatalog,
    candidate: Mapping[str, Any],
    *,
    seed: int,
) -> tuple[MetadataTwoTower, tuple[float, ...]]:
    _seed_everything(seed)
    model = _make_model(data, metadata, candidate)
    train_users, positives = _train_pairs(data)
    train_histories = tuple(
        _encode_history(str(row.history), data.item_lookup) for row in data.train.itertuples(index=False)
    )
    histories = _history_matrix(train_histories, max_history=int(candidate["maxHistory"]))
    users_tensor = torch.from_numpy(train_users + 2)
    positives_tensor = torch.from_numpy(positives + 2)
    histories_tensor = torch.from_numpy(histories)
    optimizer = torch.optim.Adam(model.parameters(), lr=float(candidate["learningRate"]))
    rng = np.random.default_rng(seed)
    batch_size = int(candidate["batchSize"])
    losses: list[float] = []
    model.train()

    for _ in range(int(candidate["epochs"])):
        sampled_negatives = None
        if candidate["negativeSampling"] == "uniform_unseen":
            sampled_negatives = _sample_unseen_negatives(data, train_users, rng) + 2
        total_loss = 0.0
        total_rows = 0
        permutation = rng.permutation(len(train_users))
        for row_ids in np.array_split(permutation, math.ceil(len(permutation) / batch_size)):
            rows = torch.from_numpy(row_ids)
            positive_ids = positives_tensor[rows]
            user_vectors = model.encode_users(users_tensor[rows], histories_tensor[rows])
            positive_vectors = model.encode_items(positive_ids)
            candidate_ids = positive_ids
            candidate_vectors = positive_vectors
            if sampled_negatives is not None:
                negative_ids = torch.from_numpy(sampled_negatives[row_ids])
                candidate_ids = torch.cat((candidate_ids, negative_ids))
                candidate_vectors = torch.cat((candidate_vectors, model.encode_items(negative_ids)))
            logits = user_vectors @ candidate_vectors.T / model.config.temperature
            positive_mask = positive_ids[:, None].eq(candidate_ids[None, :])
            positive_logits = logits.masked_fill(~positive_mask, float("-inf"))
            loss = (torch.logsumexp(logits, dim=1) - torch.logsumexp(positive_logits, dim=1)).mean()
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            total_loss += float(loss.detach()) * len(row_ids)
            total_rows += len(row_ids)
        losses.append(total_loss / total_rows)
    return model.eval(), tuple(losses)


def metadata_two_tower_vectors(
    model: MetadataTwoTower,
    data: PreparedAmazonData,
    candidate: Mapping[str, Any],
    *,
    split: str,
) -> tuple[np.ndarray, np.ndarray, tuple[np.ndarray, ...]]:
    if split not in {"dev", "test"}:
        raise ValueError("split must be dev or test")
    query_users = data.dev_query_users if split == "dev" else data.test_query_users
    histories = data.dev_histories if split == "dev" else data.test_histories
    exclusions = tuple(
        np.asarray(sorted(set(data.train_items_by_user[int(user)].tolist()) | set(history.tolist())), dtype=np.int32)
        for user, history in zip(query_users, histories, strict=True)
    )
    history_matrix = _history_matrix(histories, max_history=int(candidate["maxHistory"]))
    with torch.no_grad():
        user_vectors = model.encode_users(
            torch.from_numpy(query_users.astype(np.int64) + 2),
            torch.from_numpy(history_matrix),
        ).numpy()
        item_vectors = model.encode_items(torch.arange(2, len(data.catalog) + 2)).numpy()
    return user_vectors, item_vectors, exclusions


def save_checkpoint(
    model: MetadataTwoTower,
    destination: Path,
    *,
    candidate: Mapping[str, Any],
    seed: int,
    data: PreparedAmazonData,
    metadata: MetadataCatalog,
) -> Mapping[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    torch.save(
        {
            "schemaVersion": 1,
            "modelClass": "MetadataTwoTower",
            "modelConfig": asdict(model.config),
            "candidateConfig": dict(candidate),
            "seed": seed,
            "splitSha256": data.split_hash,
            "metadataFeatureSha256": metadata.evidence["featureSha256"],
            "stateDict": model.state_dict(),
        },
        temporary,
    )
    os.replace(temporary, destination)
    return _file_evidence(destination)


def load_checkpoint(
    checkpoint: Path,
    data: PreparedAmazonData,
    metadata: MetadataCatalog,
) -> tuple[MetadataTwoTower, Mapping[str, Any]]:
    payload = torch.load(checkpoint, map_location="cpu", weights_only=False)
    if payload.get("modelClass") != "MetadataTwoTower":
        raise ValueError("checkpoint model class is invalid")
    if payload.get("splitSha256") != data.split_hash:
        raise ValueError("checkpoint split does not match current data")
    if payload.get("metadataFeatureSha256") != metadata.evidence["featureSha256"]:
        raise ValueError("checkpoint metadata features do not match current data")
    candidate = payload["candidateConfig"]
    model = _make_model(data, metadata, candidate)
    model.load_state_dict(payload["stateDict"], strict=True)
    return model.eval(), payload


def _alias(kind: str, raw_value: str) -> str:
    return hashlib.sha256(f"amazon23-two-tower-v2:{kind}:{raw_value}".encode("utf-8")).hexdigest()[:16]


def write_user_recall_trace(
    destination: Path,
    *,
    data: PreparedAmazonData,
    topk: np.ndarray,
    split: str,
) -> Mapping[str, Any]:
    query_users = data.dev_query_users if split == "dev" else data.test_query_users
    targets = data.dev_targets if split == "dev" else data.test_targets
    histories = data.dev_histories if split == "dev" else data.test_histories
    if topk.shape[0] != len(query_users):
        raise ValueError("trace rankings and query users must align")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    with temporary.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with io.TextIOWrapper(compressed, encoding="utf-8") as text:
                for row_index, (user_index, target, history, recommendations) in enumerate(
                    zip(query_users, targets, histories, topk, strict=True)
                ):
                    matches = np.flatnonzero(recommendations == target)
                    payload = {
                        "row": row_index,
                        "userAlias": _alias("user", data.users[int(user_index)]),
                        "targetItemAlias": _alias("item", data.catalog[int(target)]),
                        "targetRankAt100": int(matches[0] + 1) if len(matches) else None,
                        "historyLength": int(len(history)),
                        "top100ItemAliases": [
                            _alias("item", data.catalog[int(item)]) for item in recommendations.tolist()
                        ],
                    }
                    text.write(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
    os.replace(temporary, destination)
    evidence = dict(_file_evidence(destination))
    evidence["rows"] = len(query_users)
    evidence["rawIdentifiersIncluded"] = False
    return evidence


def _paths(config: Mapping[str, Any]) -> tuple[Path, Path, Path]:
    root = Path(config["artifactsDir"])
    return root, root / "dev-selection.json", root / "test-final-receipt.json"


def _prepare(config_path: Path) -> tuple[dict[str, Any], PreparedAmazonData, MetadataCatalog]:
    config = load_v2_config(config_path)
    data = prepare_amazon_data(config["dataset"]["rawDir"], config)
    metadata_path = Path(config["dataset"]["rawDir"]) / config["metadata"]["file"]
    evidence = _file_evidence(metadata_path)
    if evidence["bytes"] != config["metadata"]["expectedBytes"]:
        raise ValueError("official metadata byte length does not match the frozen config")
    if evidence["sha256"] != config["metadata"]["expectedSha256"]:
        raise ValueError("official metadata SHA-256 does not match the frozen config")
    metadata = build_metadata_catalog(
        metadata_path,
        data.catalog,
        max_vocabulary=int(config["metadata"]["maxVocabulary"]),
        max_title_tokens=int(config["metadata"]["maxTitleTokens"]),
        max_category_tokens=int(config["metadata"]["maxCategoryTokens"]),
    )
    return config, data, metadata


def run_dev_selection(config_path: str | Path) -> Mapping[str, Any]:
    path = Path(config_path)
    config, data, metadata = _prepare(path)
    artifact_root, selection_path, final_receipt = _paths(config)
    if selection_path.exists() or final_receipt.exists():
        raise FileExistsError("V2 selection/test artifact already exists; frozen phases cannot be overwritten")
    artifact_root.mkdir(parents=True, exist_ok=True)
    seed = int(config["protocol"]["selectionSeed"])
    max_k = max(config["protocol"]["ks"])
    rows: list[dict[str, Any]] = []
    for candidate in config["candidateConfigs"]:
        started = time.perf_counter()
        model, losses = train_metadata_two_tower(data, metadata, candidate, seed=seed)
        users, items, exclusions = metadata_two_tower_vectors(model, data, candidate, split="dev")
        topk = _batched_dot_topk(users, items, exclusions, k=max_k)
        metrics = ranking_metrics(topk, data.dev_targets, config["protocol"]["ks"])
        rows.append(
            {
                "id": candidate["id"],
                "config": dict(candidate),
                "epochLosses": losses,
                "devMetrics": metrics,
                "selectionValue": metrics["100"]["ndcg"],
                "elapsedSeconds": time.perf_counter() - started,
            }
        )
        del model
    winner = sorted(rows, key=lambda row: (-float(row["selectionValue"]), str(row["id"])))[0]
    manifest = {
        "schemaVersion": 1,
        "status": "DEV_SELECTION_COMPLETE_TEST_UNSEEN",
        "experimentId": config["experimentId"],
        "configCanonicalSha256": _sha256_bytes(_canonical_json(config)),
        "splitSha256": data.split_hash,
        "metadata": metadata.evidence,
        "selectionSeed": seed,
        "selectionMetric": config["protocol"]["selectionMetric"],
        "candidates": rows,
        "selectedCandidateId": winner["id"],
        "selectedConfig": winner["config"],
        "testMetrics": None,
    }
    temporary = selection_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, selection_path)
    return manifest


def _load_frozen_v1(path: Path) -> Mapping[str, Any]:
    result = json.loads(path.read_text(encoding="utf-8"))
    if result.get("status") != "COMPLETE":
        raise ValueError("frozen V1 result is not complete")
    return result["results"]["models"]["twoTower"]["exactSummary"]


def _dataset_file_evidence(config: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    root = Path(config["dataset"]["rawDir"])
    return [
        {
            "split": split,
            "name": config["dataset"]["files"][split]["name"],
            "bytes": evidence["bytes"],
            "sha256": evidence["sha256"],
        }
        for split in ("train", "dev", "test")
        for evidence in [_file_evidence(root / config["dataset"]["files"][split]["name"])]
    ]


def run_final_test(config_path: str | Path) -> Mapping[str, Any]:
    path = Path(config_path)
    config, data, metadata = _prepare(path)
    artifact_root, selection_path, final_receipt = _paths(config)
    output_path = Path(config["output"])
    if not selection_path.is_file():
        raise FileNotFoundError("dev selection must finish before the test set can be opened")
    if final_receipt.exists() or output_path.exists():
        raise FileExistsError("the one permitted V2 test phase has already been executed")
    selection = json.loads(selection_path.read_text(encoding="utf-8"))
    if selection.get("status") != "DEV_SELECTION_COMPLETE_TEST_UNSEEN":
        raise ValueError("selection manifest does not preserve the test-unseen gate")
    if selection.get("configCanonicalSha256") != _sha256_bytes(_canonical_json(config)):
        raise ValueError("config changed after dev selection")
    if selection.get("splitSha256") != data.split_hash:
        raise ValueError("data split changed after dev selection")
    candidate = selection["selectedConfig"]
    max_k = max(config["protocol"]["ks"])
    seed_metrics: list[Mapping[str, Mapping[str, float | int]]] = []
    per_seed: dict[str, Any] = {}

    for seed in config["protocol"]["seeds"]:
        started = time.perf_counter()
        model, losses = train_metadata_two_tower(data, metadata, candidate, seed=int(seed))
        checkpoint = artifact_root / "checkpoints" / f"{candidate['id']}-seed-{seed}.pt"
        checkpoint_evidence = save_checkpoint(
            model,
            checkpoint,
            candidate=candidate,
            seed=int(seed),
            data=data,
            metadata=metadata,
        )
        loaded, payload = load_checkpoint(checkpoint, data, metadata)
        users, items, exclusions = metadata_two_tower_vectors(loaded, data, candidate, split="test")
        topk = _batched_dot_topk(users, items, exclusions, k=max_k)
        metrics = ranking_metrics(topk, data.test_targets, config["protocol"]["ks"])
        trace_path = artifact_root / "traces" / f"test-top100-seed-{seed}.jsonl.gz"
        trace_evidence = write_user_recall_trace(trace_path, data=data, topk=topk, split="test")
        seed_metrics.append(metrics)
        per_seed[str(seed)] = {
            "epochLosses": losses,
            "testMetrics": metrics,
            "checkpoint": {
                "name": checkpoint.name,
                "bytes": checkpoint_evidence["bytes"],
                "sha256": checkpoint_evidence["sha256"],
                "roundTripLoaded": payload["seed"] == seed,
            },
            "userRecallTrace": {
                "name": trace_path.name,
                "bytes": trace_evidence["bytes"],
                "sha256": trace_evidence["sha256"],
                "rows": trace_evidence["rows"],
                "rawIdentifiersIncluded": False,
            },
            "elapsedSeconds": time.perf_counter() - started,
        }
        del model, loaded

    summary = _metric_summary(seed_metrics)
    frozen_v1_path = Path(config["frozenV1Result"])
    frozen_v1 = _load_frozen_v1(frozen_v1_path)
    deltas: dict[str, Any] = {}
    for k in config["protocol"]["ks"]:
        key = str(k)
        deltas[key] = {
            metric: float(summary[key][metric]["mean"]) - float(frozen_v1[key][metric]["mean"])
            for metric in ("recall", "hitRate", "mrr", "ndcg")
        }
    improved = float(summary["100"]["ndcg"]["mean"]) > float(frozen_v1["100"]["ndcg"]["mean"])
    outcome = "POSITIVE_TEST_IMPROVEMENT" if improved else "NEGATIVE_NO_TEST_IMPROVEMENT"
    result = {
        "schemaVersion": 1,
        "experimentId": config["experimentId"],
        "status": "COMPLETE",
        "outcome": outcome,
        "dataOrigin": "public",
        "claimableOnlinePerformance": False,
        "source": {
            "id": "mcauley-lab-amazon-reviews-2023",
            "name": config["dataset"]["name"],
            "officialUrl": config["dataset"]["officialDocumentationUrl"],
            "terms": "license not assigned by provider; isolated non-commercial research only; no raw-data redistribution",
            "licenseStatus": config["dataset"]["licenseStatus"],
            "interactionMeaning": config["dataset"]["interactionMeaning"],
        },
        "frozenV1": {
            "commit": config["frozenV1Commit"],
            "tag": config["frozenV1Tag"],
            "resultFile": frozen_v1_path.name,
            "resultSha256": _file_evidence(frozen_v1_path)["sha256"],
            "exactSummary": frozen_v1,
        },
        "evidence": {
            "configSha256": _file_evidence(path)["sha256"],
            "configCanonicalSha256": _sha256_bytes(_canonical_json(config)),
            "splitSha256": data.split_hash,
            "datasetFiles": _dataset_file_evidence(config),
            "metadata": metadata.evidence,
            "selectionManifestSha256": _file_evidence(selection_path)["sha256"],
        },
        "protocol": {
            "selectionSplit": "dev",
            "selectionSeed": config["protocol"]["selectionSeed"],
            "selectionMetric": config["protocol"]["selectionMetric"],
            "testOpenedAfterSelectionFrozen": True,
            "testExecutionCount": 1,
            "fullTrainCatalogEvaluation": True,
            "sampledNegativeEvaluation": False,
            "excludeSeen": True,
            "catalogItems": len(data.catalog),
            "testEvaluationUsers": len(data.test_query_users),
            "counts": {
                "trainRows": len(data.train),
                "devRows": len(data.dev),
                "testRows": len(data.test),
                "trainUsers": len(data.users),
                "trainCatalogItems": len(data.catalog),
                "devEvaluationUsers": len(data.dev_query_users),
                "testEvaluationUsers": len(data.test_query_users),
                **data.exclusions,
                **data.timestamp_ties,
            },
            "seeds": config["protocol"]["seeds"],
            "ks": config["protocol"]["ks"],
        },
        "devSelection": selection,
        "selectedCandidate": candidate,
        "test": {"perSeed": per_seed, "summary": summary},
        "comparison": {
            "contrast": "metadata_two_tower_v2_minus_frozen_id_two_tower_v1",
            "delta": deltas,
            "primaryMetricImproved": improved,
            "conclusion": (
                "METADATA_TWO_TOWER_IMPROVED_FROZEN_V1_ON_TEST"
                if improved
                else "NO_TEST_IMPROVEMENT_KEEP_NEGATIVE_RESULT"
            ),
        },
        "results": {
            "selectedCandidateId": candidate["id"],
            "primaryMetric": "ndcg@100",
            "primaryMetricMean": summary["100"]["ndcg"]["mean"],
            "primaryMetricStd": summary["100"]["ndcg"]["std"],
            "comparisonConclusion": (
                "METADATA_TWO_TOWER_IMPROVED_FROZEN_V1_ON_TEST"
                if improved
                else "NO_TEST_IMPROVEMENT_KEEP_NEGATIVE_RESULT"
            ),
        },
        "limitations": [
            "Amazon Reviews'23 interactions are public review/rating proxies, not impressions, clicks, orders, or KAI business data.",
            "The provider has not assigned a dataset license; raw metadata and checkpoints remain local research artifacts and are not redistributed.",
            "Only three preregistered CPU-sized configurations were compared, using one fixed dev selection seed.",
            "The test set was evaluated once after selection; no post-test tuning is permitted.",
            "Checkpoint and user-level traces are local ignored artifacts; the committed report contains only hashes and aggregate metrics.",
            "This experiment does not add a model to production or change the frozen recommendation playground.",
        ],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, output_path)
    receipt = {
        "schemaVersion": 1,
        "status": "TEST_FINAL_EXECUTED_ONCE",
        "resultSha256": _file_evidence(output_path)["sha256"],
        "selectedCandidateId": candidate["id"],
        "testSeeds": config["protocol"]["seeds"],
    }
    temporary_receipt = final_receipt.with_suffix(".json.tmp")
    temporary_receipt.write_text(json.dumps(receipt, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary_receipt, final_receipt)
    return result


def render_markdown(result: Mapping[str, Any]) -> str:
    selected = result["selectedCandidate"]
    lines = [
        "# Amazon Two-Tower V2 — Metadata Item Tower",
        "",
        f"- Status: `{result['status']}` / `{result['outcome']}`",
        "- Boundary: public offline research only; no production claim",
        f"- Frozen V1: `{result['frozenV1']['commit']}` / `{result['frozenV1']['tag']}`",
        f"- Selected on dev only: `{selected['id']}` via NDCG@100",
        f"- Test protocol: one opening, {len(result['protocol']['seeds'])} fixed seeds, {result['protocol']['catalogItems']:,} full-catalog items",
        "",
        "## Test result",
        "",
        "| K | V1 NDCG | V2 NDCG mean ± std | Δ NDCG | V2 Recall mean ± std | V2 MRR mean ± std |",
        "|---:|---:|---:|---:|---:|---:|",
    ]
    for k in result["protocol"]["ks"]:
        key = str(k)
        v1 = result["frozenV1"]["exactSummary"][key]
        v2 = result["test"]["summary"][key]
        delta = result["comparison"]["delta"][key]
        lines.append(
            f"| {k} | {v1['ndcg']['mean']:.6f} | {v2['ndcg']['mean']:.6f} ± {v2['ndcg']['std']:.6f} | "
            f"{delta['ndcg']:+.6f} | {v2['recall']['mean']:.6f} ± {v2['recall']['std']:.6f} | "
            f"{v2['mrr']['mean']:.6f} ± {v2['mrr']['std']:.6f} |"
        )
    lines.extend(
        [
            "",
            "## Evidence and boundary",
            "",
            f"- Metadata match: {result['evidence']['metadata']['matchedItems']:,}/{result['evidence']['metadata']['catalogItems']:,} catalog items",
            f"- Metadata SHA-256: `{result['evidence']['metadata']['file']['sha256']}`",
            "- Every final seed produced a reloadable checkpoint and a hashed-identifier Top-100 user trace.",
            "- Raw metadata, model weights, and user-level traces are ignored local artifacts and are not redistributed.",
            "- The result remains valid if negative; test labels were not used to choose the configuration.",
            "",
            f"Conclusion: `{result['comparison']['conclusion']}`",
            "",
        ]
    )
    return "\n".join(lines)
