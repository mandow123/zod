from __future__ import annotations

import torch

from kai_recsys_lab.conversion import (
    ESMM,
    ESMMOutput,
    NaivePostClickCVR,
    esmm_loss,
    post_click_cvr_loss,
)
from kai_recsys_lab.ctr import VocabularyFeatureEncoder


# Synthetic-only fixture.  Conversion=1 always implies click=1 by construction.
SYNTHETIC_RECORDS = [
    {"price": 0.2 + index * 0.05, "context": index % 2, "item_group": f"g{index % 3}"}
    for index in range(8)
]
SYNTHETIC_CLICKED = torch.tensor([1, 1, 0, 1, 0, 1, 0, 1], dtype=torch.float32)
SYNTHETIC_CONVERTED = torch.tensor([1, 0, 0, 0, 0, 1, 0, 0], dtype=torch.float32)


def _batch_and_schema():
    encoder = VocabularyFeatureEncoder.fit(
        SYNTHETIC_RECORDS,
        numeric_names=("price",),
        categorical_names=("context", "item_group"),
    )
    return encoder.transform(SYNTHETIC_RECORDS), encoder.schema


def test_naive_post_click_cvr_masks_non_clicked_examples_and_trains_one_step() -> None:
    batch, schema = _batch_and_schema()
    model = NaivePostClickCVR(schema, embedding_dim=4, hidden_dims=(8, 4))
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-2)
    before = [parameter.detach().clone() for parameter in model.parameters()]

    logits = model(batch)
    loss = post_click_cvr_loss(logits, SYNTHETIC_CLICKED, SYNTHETIC_CONVERTED)
    optimizer.zero_grad()
    loss.backward()
    optimizer.step()

    assert logits.shape == (8,)
    assert torch.isfinite(loss)
    assert any(not torch.equal(old, new.detach()) for old, new in zip(before, model.parameters(), strict=True))


def test_esmm_enforces_ctr_ctcvr_relationship_and_trains_one_step() -> None:
    batch, schema = _batch_and_schema()
    model = ESMM(schema, embedding_dim=4, hidden_dims=(8, 4), seed=6502)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-2)
    before = [parameter.detach().clone() for parameter in model.parameters()]

    output = model(batch)
    inferred_cvr = output.inferred_cvr()
    loss = esmm_loss(output, SYNTHETIC_CLICKED, SYNTHETIC_CONVERTED)
    optimizer.zero_grad()
    loss.backward()
    optimizer.step()

    assert output.ctr_probability.shape == (8,)
    assert output.ctcvr_probability.shape == (8,)
    assert torch.all(output.ctcvr_probability <= output.ctr_probability)
    assert torch.allclose(
        output.ctcvr_probability,
        output.ctr_probability * inferred_cvr,
        rtol=1e-5,
        atol=1e-7,
    )
    assert torch.isfinite(loss)
    assert any(not torch.equal(old, new.detach()) for old, new in zip(before, model.parameters(), strict=True))


def test_esmm_ratio_is_bounded_and_stable_near_zero_ctr() -> None:
    output = ESMMOutput(
        ctr_probability=torch.tensor([0.0, 1e-30, 0.4]),
        ctcvr_probability=torch.tensor([0.0, 1e-30, 0.2]),
    )
    inferred = output.inferred_cvr()
    assert torch.isfinite(inferred).all()
    assert torch.all((inferred >= 0) & (inferred <= 1))
    assert inferred[0].item() == 0.0
    assert inferred[2].item() == 0.5
