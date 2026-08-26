"""Candidate-generation baselines for the isolated offline research lab."""

from .ann import AnnBenchmark, HnswAnnIndex, benchmark_ann
from .baselines import PopularityRecommender, ScoredRecommendation
from .classical import BprConfig, BprMatrixFactorization, ItemKnnRecommender
from .evaluation import RankingMetrics, evaluate_rankings
from .exact import ScoredItem, exact_full_catalog_topk
from .models import TwoTower, TwoTowerConfig, in_batch_softmax_loss
from .training import TrainingResult, train_two_tower
from .vocabulary import IdVocabulary

__all__ = [
    "AnnBenchmark",
    "BprConfig",
    "BprMatrixFactorization",
    "HnswAnnIndex",
    "IdVocabulary",
    "ItemKnnRecommender",
    "PopularityRecommender",
    "RankingMetrics",
    "ScoredItem",
    "ScoredRecommendation",
    "TrainingResult",
    "TwoTower",
    "TwoTowerConfig",
    "benchmark_ann",
    "evaluate_rankings",
    "exact_full_catalog_topk",
    "in_batch_softmax_loss",
    "train_two_tower",
]
