from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from kai_recsys_lab.contracts import DataOrigin, Split
from kai_recsys_lab.data import (
    load_amazon_processed_csv,
    load_criteo_display_tsv,
    load_criteo_sponsored_search_tsv,
)


class DataLoadersTest(unittest.TestCase):
    def test_amazon_processed_history_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "amazon.csv"
            path.write_text(
                "user_id,parent_asin,rating,timestamp,history\n"
                "u1,i3,5.0,1700000000000,i1 i2\n",
                encoding="utf-8",
            )
            rows = load_amazon_processed_csv(path, split=Split.TEST, origin=DataOrigin.SYNTHETIC)
        self.assertEqual(rows[0].history_item_ids, ("i1", "i2"))
        self.assertEqual(rows[0].split, Split.TEST)

    def test_criteo_display_reader_preserves_click_label(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "display.tsv"
            fields = ["1", *(str(index) for index in range(13)), *(f"c{index}" for index in range(26))]
            path.write_text("\t".join(fields) + "\n", encoding="utf-8")
            rows = load_criteo_display_tsv(path, split=Split.TRAIN, origin=DataOrigin.SYNTHETIC)
        self.assertEqual(rows[0].label, 1)
        self.assertEqual(rows[0].clicked, 1)
        self.assertEqual(len(rows[0].features), 39)

    def test_sponsored_search_excludes_post_outcome_leakage(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sponsored.tsv"
            fields = [
                "1", "42.5", "3600", "1700000000", "2", "50.0",
                "adult", "desktop", "aud", "unisex", "brand",
                "c1", "c2", "c3", "c4", "c5", "c6", "c7",
                "FR", "p1", "title", "partner", "u1",
            ]
            path.write_text("\t".join(fields) + "\n", encoding="utf-8")
            rows = load_criteo_sponsored_search_tsv(
                path, split=Split.TRAIN, origin=DataOrigin.SYNTHETIC
            )
        self.assertEqual(rows[0].converted, 1)
        self.assertEqual(rows[0].value, 42.5)
        self.assertNotIn("conversion_delay", rows[0].features)
        self.assertNotIn("sales_amount_euro", rows[0].features)


if __name__ == "__main__":
    unittest.main()
