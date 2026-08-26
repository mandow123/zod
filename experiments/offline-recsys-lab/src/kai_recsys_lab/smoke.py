from __future__ import annotations

import math
import random
from typing import Any

import numpy as np
import torch

from .ads import AdsCandidate, RankingObjective, evaluate_ads_ranking, rank_candidates
from .contracts import DataOrigin, RetrievalExample, Split
from .conversion import ESMM, esmm_loss
from .ctr import DCNv2, DeepFM, SklearnLogisticRegressionCTR, VocabularyFeatureEncoder, evaluate_binary_predictions
from .debias import inverse_propensity_estimate
from .retrieval import (
    BprConfig,
    BprMatrixFactorization,
    HnswAnnIndex,
    ItemKnnRecommender,
    PopularityRecommender,
    TwoTower,
    TwoTowerConfig,
    benchmark_ann,
    train_two_tower,
)
from .sequence import DinSequenceScorer, MeanPoolingSequenceScorer


def run_synthetic_smoke(seed: int = 3407) -> dict[str, Any]:
    """Exercise every model family without producing claimable benchmark evidence."""

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)

    implicit_examples = [
        RetrievalExample("u1", "a", 1, Split.TRAIN, DataOrigin.SYNTHETIC),
        RetrievalExample("u1", "b", 2, Split.TRAIN, DataOrigin.SYNTHETIC),
        RetrievalExample("u2", "a", 3, Split.TRAIN, DataOrigin.SYNTHETIC),
        RetrievalExample("u2", "c", 4, Split.TRAIN, DataOrigin.SYNTHETIC),
        RetrievalExample("u3", "b", 5, Split.TRAIN, DataOrigin.SYNTHETIC),
        RetrievalExample("u3", "d", 6, Split.TRAIN, DataOrigin.SYNTHETIC),
    ]
    popularity = PopularityRecommender().fit(implicit_examples).recommend("u1", 2)
    item_knn = ItemKnnRecommender().fit(implicit_examples).recommend("u1", 2)
    bpr = BprMatrixFactorization(BprConfig(factors=4, epochs=3, seed=seed)).fit(
        implicit_examples
    ).recommend("u1", 2)

    users = torch.tensor([2, 3, 4, 5, 2, 3, 4, 5], dtype=torch.long)
    positives = torch.tensor([2, 3, 4, 5, 2, 3, 4, 5], dtype=torch.long)
    histories = torch.tensor(
        [[6, 0], [7, 0], [6, 7], [7, 6], [6, 0], [7, 0], [6, 7], [7, 6]],
        dtype=torch.long,
    )
    two_tower = TwoTower(TwoTowerConfig(8, 8, embedding_dim=8, hidden_dim=12, output_dim=8))
    training = train_two_tower(
        two_tower,
        users,
        positives,
        history_item_indices=histories,
        epochs=3,
        batch_size=4,
        learning_rate=0.01,
        seed=seed,
    )
    with torch.no_grad():
        query_vectors = two_tower.encode_users(users[:4], histories[:4]).numpy().astype(np.float32)
        item_ids = np.arange(2, 8, dtype=np.int64)
        item_vectors = two_tower.encode_items(torch.tensor(item_ids)).numpy().astype(np.float32)
    exact_ids = item_ids[np.argsort(-(query_vectors @ item_vectors.T), axis=1)[:, :3]]
    ann = HnswAnnIndex(8, max_elements=len(item_ids), ef_search=len(item_ids), seed=seed).fit(
        item_ids, item_vectors
    )
    ann_result = benchmark_ann(ann, query_vectors, exact_ids, k=3)

    sequence_history = torch.tensor([[2, 3, 0], [4, 5, 6]], dtype=torch.long)
    sequence_candidates = torch.tensor([4, 2], dtype=torch.long)
    mean_sequence = MeanPoolingSequenceScorer(8, embedding_dim=4, hidden_dim=6)(
        sequence_history, sequence_candidates
    )
    din_sequence = DinSequenceScorer(8, embedding_dim=4, hidden_dim=6, attention_dim=4)(
        sequence_history, sequence_candidates
    )

    records = [
        {
            "price": 0.1 + index * 0.04,
            "hour": index % 6,
            "country": f"c{index % 3}",
            "device": f"d{index % 2}",
        }
        for index in range(18)
    ]
    labels = np.asarray([int(index % 3 == 0 or index > 12) for index in range(18)], dtype=np.int64)
    encoder = VocabularyFeatureEncoder.fit(
        records,
        numeric_names=("price", "hour"),
        categorical_names=("country", "device"),
    )
    batch = encoder.transform(records)
    lr = SklearnLogisticRegressionCTR(
        numeric_names=("price", "hour"), categorical_names=("country", "device"), seed=seed
    ).fit(records, labels)
    lr_probabilities = lr.predict_proba(records)
    ctr_metrics = evaluate_binary_predictions(labels, lr_probabilities)
    deepfm_logits = DeepFM(encoder.schema, embedding_dim=4, hidden_dims=(8, 4), seed=seed)(batch)
    dcn_logits = DCNv2(encoder.schema, embedding_dim=4, hidden_dims=(8, 4), seed=seed)(batch)

    clicked = torch.tensor(labels, dtype=torch.float32)
    converted = torch.tensor([int(click and index % 2 == 0) for index, click in enumerate(labels)], dtype=torch.float32)
    esmm = ESMM(encoder.schema, embedding_dim=4, hidden_dims=(8, 4), seed=seed)
    esmm_output = esmm(batch)
    esmm_training_loss = esmm_loss(esmm_output, clicked, converted)

    ips = inverse_propensity_estimate([1, 0, 1, 0], [0.8, 0.5, 0.25, 0.1], min_propensity=0.2)
    candidates = [
        AdsCandidate("a", 0.4, 0.2, conversion_value=10.0, bid=2.0),
        AdsCandidate("b", 0.2, 0.6, conversion_value=8.0, bid=4.0),
        AdsCandidate("c", 0.6, 0.1, conversion_value=12.0, bid=1.5),
    ]
    ads_ranking = rank_candidates(candidates, RankingObjective.VALUE_AWARE)
    ads_metrics = evaluate_ads_ranking(candidates, ads_ranking, {"a": 3, "b": 2, "c": 1}, k=3)

    finite_tensors = (
        deepfm_logits,
        dcn_logits,
        esmm_output.ctr_probability,
        esmm_output.ctcvr_probability,
        esmm_training_loss.reshape(1),
        mean_sequence.logits,
        din_sequence.logits,
    )
    if not all(bool(torch.isfinite(tensor).all()) for tensor in finite_tensors):
        raise RuntimeError("synthetic smoke produced a non-finite tensor")

    return {
        "schemaVersion": 1,
        "artifactKind": "synthetic_code_path_smoke",
        "dataOrigin": "synthetic",
        "businessData": False,
        "claimablePerformance": False,
        "seed": seed,
        "modules": {
            "retrieval": {
                "status": "passed",
                "baselines": ["popularity", "item_knn", "bpr_matrix_factorization", "two_tower"],
                "classicalOutputsNonEmpty": all((popularity, item_knn, bpr)),
                "epochs": len(training.epoch_losses),
                "finiteLoss": all(math.isfinite(value) for value in training.epoch_losses),
                "annRecallAt3OnSyntheticFixture": ann_result.recall_at_k,
            },
            "sequence": {
                "status": "passed",
                "meanPoolingShape": list(mean_sequence.logits.shape),
                "targetAwareShape": list(din_sequence.logits.shape),
            },
            "ctr": {
                "status": "passed",
                "models": ["logistic_regression", "deepfm", "dcnv2"],
                "finiteSyntheticLogLoss": math.isfinite(ctr_metrics.log_loss),
            },
            "conversion": {
                "status": "passed",
                "models": ["post_click_cvr_contract", "esmm"],
                "ctcvrNeverExceedsCtr": bool(
                    torch.all(esmm_output.ctcvr_probability <= esmm_output.ctr_probability)
                ),
            },
            "debias": {
                "status": "passed",
                "finiteIps": math.isfinite(ips.ips),
                "finiteSnips": math.isfinite(ips.snips),
                "clippingReported": ips.clipped_count,
            },
            "ads": {
                "status": "passed",
                "valueAwareRanking": list(ads_ranking),
                "finiteExpectedValue": math.isfinite(ads_metrics.expected_value),
            },
        },
    }
