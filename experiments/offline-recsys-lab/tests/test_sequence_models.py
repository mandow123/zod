from __future__ import annotations

import unittest

import torch

from kai_recsys_lab.sequence import DinSequenceScorer, MeanPoolingSequenceScorer


class SequenceModelsTest(unittest.TestCase):
    def test_mean_pooling_is_order_invariant_and_masks_padding(self) -> None:
        torch.manual_seed(3)
        model = MeanPoolingSequenceScorer(num_items=8, embedding_dim=4, hidden_dim=6)
        candidates = torch.tensor([4, 4])
        histories = torch.tensor([[1, 2, 0], [2, 1, 0]])
        output = model(histories, candidates)

        torch.testing.assert_close(output.interest_vector[0], output.interest_vector[1])
        torch.testing.assert_close(output.logits[0], output.logits[1])
        self.assertEqual(float(output.attention_weights[:, 2].sum()), 0.0)

    def test_din_attention_is_target_aware_and_masks_padding(self) -> None:
        model = DinSequenceScorer(num_items=5, embedding_dim=2, hidden_dim=4, attention_dim=1)
        with torch.no_grad():
            model.item_embedding.weight.zero_()
            model.item_embedding.weight[1] = torch.tensor([-1.0, 0.0])
            model.item_embedding.weight[2] = torch.tensor([1.0, 0.0])
            first = model.attention[0]
            last = model.attention[2]
            first.weight.zero_()
            first.bias.zero_()
            # [history, candidate, history-candidate, history*candidate]
            first.weight[0, 6] = 1.0
            last.weight.fill_(1.0)
            last.bias.zero_()

        histories = torch.tensor([[1, 2, 0], [1, 2, 0]])
        candidates = torch.tensor([1, 2])
        output = model(histories, candidates)

        weights = output.attention_weights.detach()
        self.assertGreater(float(weights[0, 0]), float(weights[0, 1]))
        self.assertGreater(float(weights[1, 1]), float(weights[1, 0]))
        self.assertEqual(float(weights[:, 2].sum()), 0.0)
        torch.testing.assert_close(output.attention_weights.sum(dim=1), torch.ones(2))

    def test_all_padding_history_fails_safe_to_zero_interest(self) -> None:
        torch.manual_seed(5)
        model = DinSequenceScorer(num_items=5, embedding_dim=2, hidden_dim=4, attention_dim=2)
        output = model(torch.zeros((1, 3), dtype=torch.long), torch.tensor([1]))
        torch.testing.assert_close(output.interest_vector, torch.zeros((1, 2)))
        torch.testing.assert_close(output.attention_weights, torch.zeros((1, 3)))
        self.assertTrue(torch.isfinite(output.logits).all())


if __name__ == "__main__":
    unittest.main()
