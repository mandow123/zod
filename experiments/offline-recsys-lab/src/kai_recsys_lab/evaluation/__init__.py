"""Deterministic offline evaluation metrics.

The metrics in this package describe a supplied public or synthetic evaluation
set. They do not make claims about production traffic or business outcomes.
"""

from .binary import (
    BinaryClassificationMetrics,
    average_precision,
    binary_classification_metrics,
    brier_score,
    constraint_violation_rate,
    expected_calibration_error,
    log_loss,
    post_click_cvr,
    pr_auc,
    roc_auc,
)
from .retrieval import (
    RetrievalMetrics,
    graded_ndcg_at_k,
    mean_retrieval_metrics_at_k,
    retrieval_metrics_at_k,
)

__all__ = [
    "BinaryClassificationMetrics",
    "RetrievalMetrics",
    "average_precision",
    "binary_classification_metrics",
    "brier_score",
    "constraint_violation_rate",
    "expected_calibration_error",
    "graded_ndcg_at_k",
    "log_loss",
    "mean_retrieval_metrics_at_k",
    "post_click_cvr",
    "pr_auc",
    "retrieval_metrics_at_k",
    "roc_auc",
]
