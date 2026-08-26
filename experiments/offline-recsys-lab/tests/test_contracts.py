from __future__ import annotations

import unittest

from kai_recsys_lab.contracts import BinaryExample, DataOrigin, RetrievalExample, Split


class ContractsTest(unittest.TestCase):
    def test_retrieval_example_rejects_missing_identity(self) -> None:
        with self.assertRaises(ValueError):
            RetrievalExample("", "item", 1, Split.TRAIN, DataOrigin.SYNTHETIC)

    def test_conversion_cannot_follow_known_non_click(self) -> None:
        with self.assertRaises(ValueError):
            BinaryExample(
                example_id="x",
                timestamp_ms=1,
                split=Split.TRAIN,
                origin=DataOrigin.SYNTHETIC,
                label=1,
                features={},
                clicked=0,
                converted=1,
            )

    def test_feature_mapping_is_immutable(self) -> None:
        example = BinaryExample("x", 1, Split.TRAIN, DataOrigin.PUBLIC, 0, {"price": 2.0})
        with self.assertRaises(TypeError):
            example.features["price"] = 3.0  # type: ignore[index]


if __name__ == "__main__":
    unittest.main()
