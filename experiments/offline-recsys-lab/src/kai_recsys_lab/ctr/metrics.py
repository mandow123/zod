from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np
from sklearn.metrics import (
    auc,
    average_precision_score,
    brier_score_loss,
    log_loss,
    precision_recall_curve,
    roc_auc_score,
)


@dataclass(frozen=True, slots=True)
class CalibrationBin:
    lower: float
    upper: float
    count: int
    mean_prediction: float | None
    positive_rate: float | None


@dataclass(frozen=True, slots=True)
class BinaryPredictionMetrics:
    n_examples: int
    positive_rate: float
    auc: float | None
    log_loss: float
    brier_score: float
    expected_calibration_error: float
    calibration: tuple[CalibrationBin, ...]
    # Average Precision is a non-interpolated weighted mean over recall steps;
    # PR-AUC is trapezoidal integration.  They are deliberately kept separate.
    average_precision: float | None = None
    pr_auc: float | None = None


def evaluate_binary_predictions(
    labels: Sequence[int] | np.ndarray,
    probabilities: Sequence[float] | np.ndarray,
    *,
    n_calibration_bins: int = 10,
) -> BinaryPredictionMetrics:
    """Return AUC, log loss and equal-width calibration without fitting anything."""

    if n_calibration_bins < 1:
        raise ValueError("n_calibration_bins must be positive")
    y = np.asarray(labels, dtype=np.int64)
    probability = np.asarray(probabilities, dtype=np.float64)
    if y.ndim != 1 or probability.ndim != 1 or y.shape != probability.shape:
        raise ValueError("labels and probabilities must be equally sized vectors")
    if y.size == 0:
        raise ValueError("metrics require at least one example")
    if not np.isin(y, [0, 1]).all():
        raise ValueError("labels must be binary")
    if not np.isfinite(probability).all() or np.any((probability < 0) | (probability > 1)):
        raise ValueError("probabilities must be finite values in [0, 1]")

    edges = np.linspace(0.0, 1.0, n_calibration_bins + 1)
    # A prediction of exactly one belongs in the final bin.
    bin_indices = np.minimum(np.digitize(probability, edges[1:-1], right=False), n_calibration_bins - 1)
    calibration: list[CalibrationBin] = []
    ece = 0.0
    for index in range(n_calibration_bins):
        mask = bin_indices == index
        count = int(mask.sum())
        mean_prediction = float(probability[mask].mean()) if count else None
        positive_rate = float(y[mask].mean()) if count else None
        if count:
            ece += count / y.size * abs(mean_prediction - positive_rate)
        calibration.append(
            CalibrationBin(
                lower=float(edges[index]),
                upper=float(edges[index + 1]),
                count=count,
                mean_prediction=mean_prediction,
                positive_rate=positive_rate,
            )
        )

    has_both_classes = np.unique(y).size == 2
    roc_auc = float(roc_auc_score(y, probability)) if has_both_classes else None
    average_precision = (
        float(average_precision_score(y, probability)) if has_both_classes else None
    )
    if has_both_classes:
        precision, recall, _ = precision_recall_curve(y, probability)
        pr_auc = float(auc(recall, precision))
    else:
        pr_auc = None
    return BinaryPredictionMetrics(
        n_examples=int(y.size),
        positive_rate=float(y.mean()),
        auc=roc_auc,
        log_loss=float(log_loss(y, probability, labels=[0, 1])),
        brier_score=float(brier_score_loss(y, probability)),
        expected_calibration_error=float(ece),
        calibration=tuple(calibration),
        average_precision=average_precision,
        pr_auc=pr_auc,
    )
