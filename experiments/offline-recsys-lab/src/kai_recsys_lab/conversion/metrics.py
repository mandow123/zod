from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np

from kai_recsys_lab.ctr.metrics import BinaryPredictionMetrics, evaluate_binary_predictions


@dataclass(frozen=True, slots=True)
class ESMMMetrics:
    ctr: BinaryPredictionMetrics
    ctcvr: BinaryPredictionMetrics
    post_click_cvr: BinaryPredictionMetrics | None


def evaluate_post_click_cvr(
    clicked: Sequence[int] | np.ndarray,
    converted: Sequence[int] | np.ndarray,
    cvr_probability: Sequence[float] | np.ndarray,
    *,
    n_calibration_bins: int = 10,
) -> BinaryPredictionMetrics:
    clicks = np.asarray(clicked, dtype=np.int64)
    conversions = np.asarray(converted, dtype=np.int64)
    probability = np.asarray(cvr_probability, dtype=np.float64)
    if clicks.shape != conversions.shape or probability.shape != clicks.shape or clicks.ndim != 1:
        raise ValueError("clicked, converted and probability must be equally sized vectors")
    if np.any((conversions == 1) & (clicks == 0)):
        raise ValueError("conversion cannot be positive when click is zero")
    mask = clicks == 1
    if not mask.any():
        raise ValueError("post-click CVR metrics require at least one clicked example")
    return evaluate_binary_predictions(
        conversions[mask], probability[mask], n_calibration_bins=n_calibration_bins
    )


def evaluate_esmm_predictions(
    clicked: Sequence[int] | np.ndarray,
    converted: Sequence[int] | np.ndarray,
    ctr_probability: Sequence[float] | np.ndarray,
    ctcvr_probability: Sequence[float] | np.ndarray,
    inferred_cvr_probability: Sequence[float] | np.ndarray,
    *,
    n_calibration_bins: int = 10,
) -> ESMMMetrics:
    clicks = np.asarray(clicked, dtype=np.int64)
    conversions = np.asarray(converted, dtype=np.int64)
    ctr = np.asarray(ctr_probability, dtype=np.float64)
    ctcvr = np.asarray(ctcvr_probability, dtype=np.float64)
    cvr = np.asarray(inferred_cvr_probability, dtype=np.float64)
    if not (clicks.shape == conversions.shape == ctr.shape == ctcvr.shape == cvr.shape):
        raise ValueError("all ESMM metric vectors must have the same shape")
    post_click = (
        evaluate_post_click_cvr(
            clicks,
            conversions,
            cvr,
            n_calibration_bins=n_calibration_bins,
        )
        if np.any(clicks == 1)
        else None
    )
    return ESMMMetrics(
        ctr=evaluate_binary_predictions(clicks, ctr, n_calibration_bins=n_calibration_bins),
        ctcvr=evaluate_binary_predictions(
            conversions, ctcvr, n_calibration_bins=n_calibration_bins
        ),
        post_click_cvr=post_click,
    )
