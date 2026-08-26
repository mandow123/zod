from __future__ import annotations

import numpy as np
import torch

from kai_recsys_lab.ctr import (
    DCNv2,
    DeepFM,
    SklearnLogisticRegressionCTR,
    VocabularyFeatureEncoder,
    binary_logit_loss,
)


# Synthetic-only fixture.  It represents no public or production interaction data.
SYNTHETIC_RECORDS = [
    {"price": 0.10 + index * 0.03, "hour": index % 24, "country": index % 3, "device": f"d{index % 2}"}
    for index in range(16)
]
SYNTHETIC_LABELS = np.asarray(
    [int((row["country"] == 1) or (row["hour"] > 10)) for row in SYNTHETIC_RECORDS],
    dtype=np.int64,
)


def test_vocabulary_encoder_maps_unknown_categories_to_reserved_index() -> None:
    encoder = VocabularyFeatureEncoder.fit(
        SYNTHETIC_RECORDS,
        numeric_names=("price", "hour"),
        categorical_names=("country", "device"),
    )
    batch = encoder.transform(SYNTHETIC_RECORDS)
    unknown = encoder.transform(
        [{"price": 1.0, "hour": 3, "country": 99, "device": "new-device"}]
    )

    assert batch.numeric.shape == (16, 2)
    assert batch.categorical.shape == (16, 2)
    assert unknown.categorical.tolist() == [[0, 0]]


def test_sklearn_lr_supports_mixed_features_and_unseen_category() -> None:
    model = SklearnLogisticRegressionCTR(
        numeric_names=("price", "hour"),
        categorical_names=("country", "device"),
    ).fit(SYNTHETIC_RECORDS, SYNTHETIC_LABELS)

    probability = model.predict_proba(SYNTHETIC_RECORDS)
    unseen = model.predict_proba(
        [{"price": 0.2, "hour": 4, "country": 99, "device": "new-device"}]
    )

    assert probability.shape == (16,)
    assert np.all((probability >= 0) & (probability <= 1))
    assert unseen.shape == (1,)
    assert np.isfinite(unseen).all()


def _assert_torch_model_trains_one_step(model: torch.nn.Module) -> None:
    encoder = VocabularyFeatureEncoder.fit(
        SYNTHETIC_RECORDS,
        numeric_names=("price", "hour"),
        categorical_names=("country", "device"),
    )
    batch = encoder.transform(SYNTHETIC_RECORDS)
    labels = torch.tensor(SYNTHETIC_LABELS, dtype=torch.float32)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-2)
    before = [parameter.detach().clone() for parameter in model.parameters()]

    logits = model(batch)
    loss = binary_logit_loss(logits, labels)
    optimizer.zero_grad()
    loss.backward()
    optimizer.step()

    assert logits.shape == (16,)
    assert torch.isfinite(logits).all()
    assert torch.isfinite(loss)
    assert any(not torch.equal(old, new.detach()) for old, new in zip(before, model.parameters(), strict=True))


def test_deepfm_shape_loss_and_training_step() -> None:
    encoder = VocabularyFeatureEncoder.fit(
        SYNTHETIC_RECORDS,
        numeric_names=("price", "hour"),
        categorical_names=("country", "device"),
    )
    _assert_torch_model_trains_one_step(
        DeepFM(encoder.schema, embedding_dim=4, hidden_dims=(8, 4))
    )


def test_deepfm_fm_terms_start_at_stable_scale() -> None:
    encoder = VocabularyFeatureEncoder.fit(
        SYNTHETIC_RECORDS,
        numeric_names=("price", "hour"),
        categorical_names=("country", "device"),
    )
    model = DeepFM(encoder.schema, embedding_dim=4, hidden_dims=(8, 4), seed=3407)
    assert torch.count_nonzero(model.numeric_linear) == 0
    assert float(model.numeric_factors.detach().std()) < 0.03
    for embedding in model.categorical_linear:
        assert torch.count_nonzero(embedding.weight) == 0
    for embedding in model.categorical_factors:
        assert float(embedding.weight.detach().std()) < 0.03
        assert torch.count_nonzero(embedding.weight[0]) == 0


def test_dcnv2_shape_loss_and_training_step() -> None:
    encoder = VocabularyFeatureEncoder.fit(
        SYNTHETIC_RECORDS,
        numeric_names=("price", "hour"),
        categorical_names=("country", "device"),
    )
    _assert_torch_model_trains_one_step(
        DCNv2(encoder.schema, embedding_dim=4, cross_depth=2, hidden_dims=(8, 4))
    )


def test_torch_initialization_is_reproducible_for_fixed_seed() -> None:
    encoder = VocabularyFeatureEncoder.fit(
        SYNTHETIC_RECORDS,
        numeric_names=("price", "hour"),
        categorical_names=("country", "device"),
    )
    batch = encoder.transform(SYNTHETIC_RECORDS)
    first = DCNv2(encoder.schema, embedding_dim=3, hidden_dims=(6,), seed=3407)
    second = DCNv2(encoder.schema, embedding_dim=3, hidden_dims=(6,), seed=3407)
    assert torch.equal(first(batch), second(batch))
