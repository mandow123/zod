from __future__ import annotations

import unittest

import torch

from kai_recsys_lab.retrieval import (
    TwoTower,
    TwoTowerConfig,
    exact_full_catalog_topk,
    in_batch_softmax_loss,
    train_two_tower,
)


class TwoTowerTest(unittest.TestCase):
    def test_in_batch_training_reduces_loss_on_synthetic_pairs(self) -> None:
        torch.manual_seed(7)
        model = TwoTower(TwoTowerConfig(num_users=6, num_items=6, embedding_dim=8, hidden_dim=12, output_dim=8))
        users = torch.tensor([2, 3, 4, 5], dtype=torch.long)
        items = torch.tensor([2, 3, 4, 5], dtype=torch.long)

        with torch.no_grad():
            before_vectors = model(users, items)
            before = float(
                in_batch_softmax_loss(
                    *before_vectors,
                    temperature=model.config.temperature,
                    positive_item_indices=items,
                )
            )
        result = train_two_tower(
            model,
            users,
            items,
            epochs=40,
            batch_size=4,
            learning_rate=0.02,
            seed=7,
        )
        with torch.no_grad():
            after_vectors = model(users, items)
            after = float(
                in_batch_softmax_loss(
                    *after_vectors,
                    temperature=model.config.temperature,
                    positive_item_indices=items,
                )
            )

        self.assertEqual(len(result.epoch_losses), 40)
        self.assertLess(after, before)

    def test_duplicate_batch_items_are_not_false_negatives(self) -> None:
        user_vectors = torch.tensor([[1.0, 0.0], [1.0, 0.0]])
        item_vectors = torch.tensor([[1.0, 0.0], [1.0, 0.0]])
        item_ids = torch.tensor([2, 2])
        loss = in_batch_softmax_loss(user_vectors, item_vectors, temperature=1.0, positive_item_indices=item_ids)
        self.assertAlmostEqual(float(loss), 0.0, places=6)

    def test_exact_retrieval_scores_entire_catalog_and_excludes_history(self) -> None:
        users = torch.tensor([[1.0, 0.0], [0.0, 1.0]])
        items = torch.tensor([[1.0, 0.0], [0.8, 0.2], [0.0, 1.0]])
        item_ids = torch.tensor([10, 11, 12])
        result = exact_full_catalog_topk(users, items, item_ids, 2, exclude_item_indices={0: {10}})
        self.assertEqual([row.item_index for row in result[0]], [11, 12])
        self.assertEqual([row.item_index for row in result[1]], [12, 11])


if __name__ == "__main__":
    unittest.main()
