from __future__ import annotations

from kai_recsys_lab.conversion import evaluate_esmm_predictions, evaluate_post_click_cvr


def test_post_click_metrics_evaluate_only_clicked_synthetic_examples() -> None:
    metrics = evaluate_post_click_cvr(
        clicked=[1, 0, 1, 1],
        converted=[1, 0, 0, 1],
        cvr_probability=[0.8, 0.9, 0.2, 0.7],
        n_calibration_bins=3,
    )
    assert metrics.n_examples == 3
    assert metrics.auc == 1.0


def test_esmm_metrics_keep_ctr_ctcvr_and_post_click_cvr_separate() -> None:
    metrics = evaluate_esmm_predictions(
        clicked=[1, 0, 1, 0],
        converted=[1, 0, 0, 0],
        ctr_probability=[0.8, 0.2, 0.7, 0.1],
        ctcvr_probability=[0.6, 0.05, 0.2, 0.01],
        inferred_cvr_probability=[0.75, 0.25, 0.29, 0.10],
        n_calibration_bins=4,
    )
    assert metrics.ctr.n_examples == 4
    assert metrics.ctcvr.n_examples == 4
    assert metrics.post_click_cvr is not None
    assert metrics.post_click_cvr.n_examples == 2
