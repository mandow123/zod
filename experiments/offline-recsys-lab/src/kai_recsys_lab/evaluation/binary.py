from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence


@dataclass(frozen=True, slots=True)
class BinaryClassificationMetrics:
    auc: float
    average_precision: float
    log_loss: float
    brier: float
    ece: float

    @property
    def pr_auc(self) -> float:
        """PR-AUC reported as non-interpolated Average Precision."""

        return self.average_precision


def _validated_binary_inputs(
    labels: Sequence[int], probabilities: Sequence[float]
) -> tuple[tuple[int, ...], tuple[float, ...]]:
    checked_labels = tuple(labels)
    checked_probabilities = tuple(float(probability) for probability in probabilities)
    if not checked_labels:
        raise ValueError("at least one binary example is required")
    if len(checked_labels) != len(checked_probabilities):
        raise ValueError("labels and probabilities must have equal length")
    if any(label not in (0, 1) for label in checked_labels):
        raise ValueError("labels must be binary")
    if any(not math.isfinite(probability) or not 0 <= probability <= 1 for probability in checked_probabilities):
        raise ValueError("probabilities must be finite and in [0, 1]")
    return checked_labels, checked_probabilities


def roc_auc(labels: Sequence[int], probabilities: Sequence[float]) -> float:
    """AUC via average ranks, including exact tie handling."""

    checked_labels, checked_probabilities = _validated_binary_inputs(labels, probabilities)
    positive_count = sum(checked_labels)
    negative_count = len(checked_labels) - positive_count
    if positive_count == 0 or negative_count == 0:
        raise ValueError("AUC is undefined without both positive and negative examples")

    ordered = sorted(zip(checked_probabilities, checked_labels), key=lambda pair: pair[0])
    positive_rank_sum = 0.0
    start = 0
    while start < len(ordered):
        end = start + 1
        while end < len(ordered) and ordered[end][0] == ordered[start][0]:
            end += 1
        average_rank = ((start + 1) + end) / 2.0
        positive_rank_sum += average_rank * sum(label for _, label in ordered[start:end])
        start = end

    mann_whitney_u = positive_rank_sum - positive_count * (positive_count + 1) / 2.0
    return mann_whitney_u / (positive_count * negative_count)


def average_precision(labels: Sequence[int], probabilities: Sequence[float]) -> float:
    """Non-interpolated Average Precision with score ties evaluated as a group.

    This is the lab's explicit PR-AUC definition: each increase in recall is
    weighted by precision at that score threshold. It is not trapezoidal
    interpolation of the precision-recall curve.
    """

    checked_labels, checked_probabilities = _validated_binary_inputs(labels, probabilities)
    positive_count = sum(checked_labels)
    if positive_count == 0:
        raise ValueError("Average Precision is undefined without positive examples")

    ordered = sorted(zip(checked_probabilities, checked_labels), key=lambda pair: pair[0], reverse=True)
    true_positives = 0
    examples_seen = 0
    previous_recall = 0.0
    result = 0.0
    start = 0
    while start < len(ordered):
        end = start + 1
        while end < len(ordered) and ordered[end][0] == ordered[start][0]:
            end += 1
        true_positives += sum(label for _, label in ordered[start:end])
        examples_seen += end - start
        recall = true_positives / positive_count
        precision = true_positives / examples_seen
        result += (recall - previous_recall) * precision
        previous_recall = recall
        start = end
    return result


def pr_auc(labels: Sequence[int], probabilities: Sequence[float]) -> float:
    """Alias for the lab's documented Average Precision PR-AUC definition."""

    return average_precision(labels, probabilities)


def log_loss(labels: Sequence[int], probabilities: Sequence[float], *, epsilon: float = 1e-15) -> float:
    checked_labels, checked_probabilities = _validated_binary_inputs(labels, probabilities)
    if not math.isfinite(epsilon) or not 0 < epsilon < 0.5:
        raise ValueError("epsilon must be finite and in (0, 0.5)")
    total = 0.0
    for label, probability in zip(checked_labels, checked_probabilities):
        clipped = min(max(probability, epsilon), 1.0 - epsilon)
        total -= label * math.log(clipped) + (1 - label) * math.log(1.0 - clipped)
    return total / len(checked_labels)


def brier_score(labels: Sequence[int], probabilities: Sequence[float]) -> float:
    checked_labels, checked_probabilities = _validated_binary_inputs(labels, probabilities)
    return sum((probability - label) ** 2 for label, probability in zip(checked_labels, checked_probabilities)) / len(
        checked_labels
    )


def expected_calibration_error(
    labels: Sequence[int], probabilities: Sequence[float], *, bin_count: int = 10
) -> float:
    """Equal-width expected calibration error (ECE)."""

    checked_labels, checked_probabilities = _validated_binary_inputs(labels, probabilities)
    if isinstance(bin_count, bool) or not isinstance(bin_count, int) or bin_count < 1:
        raise ValueError("bin_count must be a positive integer")

    bins: list[list[tuple[int, float]]] = [[] for _ in range(bin_count)]
    for label, probability in zip(checked_labels, checked_probabilities):
        bin_index = min(int(probability * bin_count), bin_count - 1)
        bins[bin_index].append((label, probability))

    example_count = len(checked_labels)
    ece = 0.0
    for bucket in bins:
        if not bucket:
            continue
        accuracy = sum(label for label, _ in bucket) / len(bucket)
        confidence = sum(probability for _, probability in bucket) / len(bucket)
        ece += len(bucket) / example_count * abs(accuracy - confidence)
    return ece


def binary_classification_metrics(
    labels: Sequence[int], probabilities: Sequence[float], *, ece_bin_count: int = 10
) -> BinaryClassificationMetrics:
    return BinaryClassificationMetrics(
        auc=roc_auc(labels, probabilities),
        average_precision=average_precision(labels, probabilities),
        log_loss=log_loss(labels, probabilities),
        brier=brier_score(labels, probabilities),
        ece=expected_calibration_error(labels, probabilities, bin_count=ece_bin_count),
    )


def constraint_violation_rate(violated: Sequence[int | bool]) -> float:
    """Compute marketplace hard-constraint violation rate.

    This name is intentionally distinct from post-click conversion rate.
    """

    values = tuple(violated)
    if not values:
        raise ValueError("at least one constraint result is required")
    if any(value not in (0, 1, False, True) for value in values):
        raise ValueError("constraint outcomes must be binary")
    return sum(int(value) for value in values) / len(values)


def post_click_cvr(clicked: Sequence[int], converted: Sequence[int]) -> float:
    """PostClickCVR: conversions divided by clicks, never by impressions."""

    checked_clicks = tuple(clicked)
    checked_conversions = tuple(converted)
    if not checked_clicks or len(checked_clicks) != len(checked_conversions):
        raise ValueError("clicked and converted must be non-empty and have equal length")
    if any(value not in (0, 1) for value in (*checked_clicks, *checked_conversions)):
        raise ValueError("clicked and converted must be binary")
    if any(conversion == 1 and click == 0 for click, conversion in zip(checked_clicks, checked_conversions)):
        raise ValueError("a conversion cannot be attributed to a known non-click")
    click_count = sum(checked_clicks)
    if click_count == 0:
        raise ValueError("PostClickCVR is undefined without clicks")
    return (
        sum(conversion for click, conversion in zip(checked_clicks, checked_conversions) if click == 1)
        / click_count
    )
