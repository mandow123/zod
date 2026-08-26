"""Dataset-specific readers that preserve source semantics."""

from .amazon import load_amazon_processed_csv
from .criteo import load_criteo_display_tsv, load_criteo_sponsored_search_tsv

__all__ = [
    "load_amazon_processed_csv",
    "load_criteo_display_tsv",
    "load_criteo_sponsored_search_tsv",
]
