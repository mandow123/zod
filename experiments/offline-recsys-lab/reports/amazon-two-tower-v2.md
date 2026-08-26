# Amazon Two-Tower V2 — Metadata Item Tower

- Status: `COMPLETE` / `POSITIVE_TEST_IMPROVEMENT`
- Boundary: public offline research only; no production claim
- Frozen V1: `e1d91ab` / `offline-recsys-lab-v1.0.0`
- Selected on dev only: `metadata-d64-uniform` via NDCG@100
- Test protocol: one opening, 3 fixed seeds, 25,754 full-catalog items

## Test result

| K | V1 NDCG | V2 NDCG mean ± std | Δ NDCG | V2 Recall mean ± std | V2 MRR mean ± std |
|---:|---:|---:|---:|---:|---:|
| 20 | 0.000296 | 0.011111 ± 0.000085 | +0.010815 | 0.027738 ± 0.000484 | 0.006599 ± 0.000013 |
| 50 | 0.000559 | 0.016024 ± 0.000124 | +0.015465 | 0.052751 ± 0.000619 | 0.007366 ± 0.000012 |
| 100 | 0.000879 | 0.020853 ± 0.000229 | +0.019974 | 0.082654 ± 0.001269 | 0.007785 ± 0.000019 |

## Evidence and boundary

- Metadata match: 25,754/25,754 catalog items
- Metadata SHA-256: `0beb251cec166347a3ec3ef23e55ec89f7fb27a6e8e9a0737d6b34cdc184ebcb`
- Every final seed produced a reloadable checkpoint and a hashed-identifier Top-100 user trace.
- Raw metadata, model weights, and user-level traces are ignored local artifacts and are not redistributed.
- The result remains valid if negative; test labels were not used to choose the configuration.

Conclusion: `METADATA_TWO_TOWER_IMPROVED_FROZEN_V1_ON_TEST`
