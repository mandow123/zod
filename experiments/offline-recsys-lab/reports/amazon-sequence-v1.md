# Amazon Reviews'23 Sequence V1

Status: `COMPLETE`

Data origin: `public`

Online-performance claim: `false`

## Protocol

- The retrieval V1 dataset, official temporal split, 25,754-item train catalog,
  and pre-filtered dev/test cohorts are unchanged.
- A frozen sparse ItemKNN generates Top-100 from the complete train catalog.
  Test targets are never injected. Both sequence models receive the exact same
  candidate rows.
- Mean Pooling and target-aware DIN use the same 259,992 timestamp-safe
  non-empty train histories, positives, per-seed full-catalog negatives,
  optimizer settings, max history length, dev/test users, and seeds.
- The negative sampler excludes every train interaction for that user to avoid
  known future train positives becoming false negatives.
- Training ran on Apple MPS with seeds 3407, 6502, and 9109. Test was not used
  for tuning.

## Frozen candidate ceiling

The ItemKNN candidate generator reaches test Recall@20/50/100 of
0.029396/0.046256/0.066334. At K=100, no reranker can exceed this recall
without changing retrieval.

## End-to-end test metrics

Values are mean ± population standard deviation across the fixed seeds.

| Model | K | Recall / HitRate | MRR | NDCG |
|---|---:|---:|---:|---:|
| Mean Pooling | 20 | 0.026988 ± 0.000343 | 0.007787 ± 0.000138 | 0.011952 ± 0.000188 |
| Mean Pooling | 50 | 0.045585 ± 0.000449 | 0.008364 ± 0.000114 | 0.015614 ± 0.000045 |
| Mean Pooling | 100 | 0.066334 ± 0.000000 | 0.008654 ± 0.000119 | 0.018963 ± 0.000106 |
| DIN | 20 | 0.026994 ± 0.000152 | 0.007768 ± 0.000080 | 0.011936 ± 0.000100 |
| DIN | 50 | 0.045446 ± 0.000558 | 0.008339 ± 0.000063 | 0.015569 ± 0.000062 |
| DIN | 100 | 0.066334 ± 0.000000 | 0.008632 ± 0.000068 | 0.018942 ± 0.000059 |

## Finding

DIN does not show a stable improvement on this frozen protocol. Its paired
seed mean NDCG delta versus Mean Pooling is -0.000016 at K=20, -0.000045 at
K=50, and -0.000021 at K=100. MRR deltas are also negative at every K.
Recall@100 is identical because both models rerank the same 100 candidates.

This is a valid negative result. No split, candidate set, test target, or gold
label was changed to produce a favorable outcome. Potential improvements must
be evaluated in a new dev-selected experiment, not by rewriting this test.

## Limitations

- DIN only reranks ItemKNN Top-100 and cannot recover retrieval misses.
- Review/rating histories are interaction proxies, not impression/click logs.
- The provider has not assigned a dataset license; this remains isolated
  non-commercial research and cannot enter the production flywheel.
- Full source hashes, split/config fingerprints, dev/test metrics, paired-seed
  deltas, counts, and limitations are in
  `reports/amazon-sequence-v1-results.json`.
