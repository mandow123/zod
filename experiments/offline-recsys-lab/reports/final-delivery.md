# KAI Offline RecSys Lab — Integrated Public Benchmark Delivery

Status: `COMPLETE_PUBLIC_OFFLINE_V3`

Data boundary: `public` benchmark data plus `synthetic` code-path fixtures

Production / online claim: `false`

## 1. Recommendation retrieval

Amazon Reviews'23 `Industrial_and_Scientific` official 5-core protocol:
310,977 train rows, 50,985 dev rows, 50,985 test rows, 25,754 train-catalog
items and 50,653 common test users. All four models use the same users, items,
provider temporal split, full train catalog, history exclusion and evaluation.
The 332 train-cold test targets are excluded once before any model is run.

### Full-catalog test metrics

Values are three-seed means. With one target per user, Recall and HitRate are
numerically identical.

| Model | Recall/HitRate@20 | @50 | @100 | MRR@100 | NDCG@100 |
|---|---:|---:|---:|---:|---:|
| Popularity | 0.026218 | 0.045427 | **0.070618** | 0.007792 | 0.018872 |
| ItemKNN | **0.029396** | **0.046256** | 0.066334 | **0.011436** | **0.021296** |
| BPR MF | 0.013161 | 0.023269 | 0.034661 | 0.003914 | 0.009357 |
| Two-Tower exact | 0.000888 | 0.002224 | 0.004218 | 0.000209 | 0.000879 |

The current ID/history Two-Tower is a negative result: it is near random and
does not beat the classical baselines. No test-driven tuning was used to hide
that result.

### Exact versus HNSW ANN

| Measurement | Mean | Std |
|---|---:|---:|
| ANN Recall@20 | 0.933282 | 0.009339 |
| ANN Recall@50 | 0.912947 | 0.009619 |
| ANN Recall@100 | 0.888194 | 0.009888 |
| Per-query p50 latency | 0.126792 ms | 0.013816 ms |
| Per-query p95 latency | 0.351742 ms | 0.116958 ms |
| QPS | 6,255.72 | 1,253.05 |
| Serialized index size | 7,122,008 bytes | 1,071 bytes |

These latency values are local Apple Silicon, one-query calls with one HNSW
thread, including history-item removal. They are machine/runtime measurements,
not a service SLO. The catalog contains 25,754 items, so this does not prove a
million-item serving claim.

## 2. Sequence modeling

Mean Pooling and DIN rerank the exact same frozen ItemKNN Top-100 candidates,
with the same timestamp-safe histories, positives, negatives, optimizer
settings and seeds.

| Model | NDCG@20 | NDCG@50 | NDCG@100 | MRR@100 |
|---|---:|---:|---:|---:|
| Mean Pooling | **0.011952** | **0.015614** | **0.018963** | **0.008654** |
| DIN | 0.011936 | 0.015569 | 0.018942 | 0.008632 |
| DIN minus Mean Pooling | -0.000016 | -0.000045 | -0.000021 | -0.000022 |

Conclusion: `NO_STABLE_DIN_IMPROVEMENT_ON_FROZEN_PROTOCOL`. Recall@100 is
0.066334 for both because neither reranker can recover a target missing from
the frozen candidate set.

## 2A. Unified retrieval-to-ranking V3

V3 reuses the frozen metadata Two-Tower checkpoint and one Amazon data
protocol through exact/HNSW Top-100 retrieval, negative generation,
DIN/DCN-style reranking, train-only temperature calibration and frozen
evaluation. Dev selection compared five candidates containing hard, uniform
and in-batch negatives, both reranker families and both retrieval modes.

| Frozen test evidence | Result |
|---|---:|
| Exact retrieval NDCG@100 | 0.021026 |
| Selected reranker NDCG@100 | 0.023514 |
| Paired user delta | +0.002488 |
| 95% paired user bootstrap CI | [0.002283, 0.002680] |
| Test users / bootstrap samples | 50,653 / 2,000 |

`exact-din-uniform-64-32` won on dev. Hard negatives did not win and remain a
reported negative result. The test bundle was opened exactly once after dev
selection; the interval excludes zero within this offline protocol, but no
online significance or business lift is claimed.

The feature analysis removes metadata, ID, title and category inputs from the
frozen selected checkpoint on one fixed dev candidate population. It is input
zeroing, not per-variant retraining. The HNSW sweep records Recall@100 from
0.8628 to 0.9965, p95 local-process latency and serialized index bytes across
three settings. The frozen 5-core population has no real new-user, no-history
or unseen-item support, so those cold-start results remain explicitly empty.

## 3. CTR prediction and calibration

Criteo 1TB Click Logs fixed-subset V1 uses 42,000/9,000/9,000 source-order
train/dev/test rows from one pinned official parquet shard. Every model uses
the same 13 numerical and 26 categorical fields, train-only preprocessing and
seeds 3407/6502/9109. The split is not claimed chronological.

| Model | ROC-AUC | PR-AUC | LogLoss | Brier | ECE |
|---|---:|---:|---:|---:|---:|
| LR | **0.710306** | **0.096583** | 0.134786 | 0.029982 | 0.011489 |
| DeepFM | 0.692860 ± 0.015221 | 0.067137 ± 0.008446 | **0.134469 ± 0.000329** | **0.029963 ± 0.000015** | **0.007536 ± 0.004032** |
| DCNv2 | 0.671309 ± 0.009303 | 0.060136 ± 0.002281 | 0.137135 ± 0.001577 | 0.030476 ± 0.000187 | 0.007981 ± 0.000269 |

LR is strongest on ranking discrimination in this fixed subset. DeepFM has a
slightly better mean LogLoss/Brier and lower mean ECE, but lower ROC-AUC and
PR-AUC. The first DeepFM execution was invalidated after train/dev exposed an
embedding-initialization implementation bug; the corrected run kept the same
split, features, seeds, epoch budget and test protocol. The invalidated digest
is preserved in the machine-readable report.

## 4. Position bias and off-policy evaluation

Open Bandit Dataset full `ALL` campaign, fixed final timestamp window:
2,055,926 BTS rows / 11,162 clicks and 229,613 random-policy rows / 885 clicks.
The random policy is the on-policy reference.

| Estimator | Policy value | Absolute error | ESS | Weight variance |
|---|---:|---:|---:|---:|
| On-policy random | 0.00385431 | 0 | — | — |
| Naive BTS | 0.00542918 | 0.00157487 | — | — |
| Position-stratified associational | 0.00542920 | 0.00157489 | — | — |
| IPS | 0.00404723 | 0.00019292 | 24,735.21 | 83.100479 |
| SNIPS | **0.00402322** | **0.00016891** | 24,735.21 | 83.100479 |

Preregistered propensity floors 0.01/0.02/0.05/0.1 raised ESS as high as
1,954,456 and reduced weight variance, but every clipped IPS/SNIPS point
estimate had higher absolute error than raw SNIPS. This bias/variance tradeoff
is retained as a negative clipping result.

The logged propensity is the probability of selecting an item at a position,
not an examination propensity. The experiment supports action-selection OPE
diagnostics under stated assumptions; it does not prove causal removal of
latent position-examination bias.

## 5. CVR / ESMM impression-level experiment

Criteo Sponsored Search remains rejected because it is clicked-row conversion
data. V1 instead executes on the official Criteo Attribution dataset using one
fixed first-200,000 timestamp-sorted impression population. Train/dev/test are
140,000/30,000/30,000 rows. UID, labels, attribution and post-click fields are
excluded from the feature allowlist; preprocessing is fitted on train only.

| Model / task | AUC | LogLoss | Brier | ECE |
|---|---:|---:|---:|---:|
| Naive clicked-only CVR | 0.810773 | 0.327262 | 0.097532 | 0.024204 |
| ESMM CTR | 0.736028 | 0.559379 | 0.188682 | 0.014789 |
| ESMM CTCVR | 0.841541 | 0.151314 | 0.039463 | 0.003202 |
| ESMM post-click CVR | 0.823026 | 0.314712 | 0.093289 | 0.012140 |

Values are three-seed means. CTCVR is pre-registered as `click × raw 30-day
impression conversion`; attribution is audit-only. Test was evaluated once
after dev checkpoint selection. These are offline measurements, not causal
conversion lift.

## 6. Claim boundary

This delivery establishes reproducible public offline experiments for:

- full-catalog candidate generation and exact/HNSW retrieval at 25,754 items;
- CTR ranking plus probability calibration diagnostics;
- target-aware sequence reranking under a fixed candidate ceiling;
- IPS/SNIPS/clipping validity analysis with ESS and per-position diagnostics.

It does not establish million-item retrieval, online CTR/CVR lift, production
recommendation quality, advertising-system deployment, KAI business impact or
Data Flywheel readiness. Public/raw data and model artifacts remain physically
isolated from Production and ignored by Git.

## 7. Evidence index

- Retrieval: `reports/amazon-retrieval-v1.md` and
  `reports/amazon-retrieval-v1-results.json`
- Unified V3: `reports/amazon-end-to-end-v3.md` and
  `reports/amazon-end-to-end-v3-results.json`
- Sequence: `reports/amazon-sequence-v1.md` and
  `reports/amazon-sequence-v1-results.json`
- CTR: `reports/criteo-ctr-v1.md` and
  `reports/criteo-ctr-v1-results.json`
- Position/OPE: `reports/position-bias-open-bandit-full-ope-v1.md` and
  `reports/position-bias-open-bandit-full-ope-v1.json`
- CVR/ESMM: `reports/criteo-esmm-v1.md`,
  `reports/criteo-esmm-v1-results.json` and `reports/cvr-esmm-data-gate.md`

## 8. Local recruitment playground

`playground/` provides a Chinese-first, local-only explanation flow for the
unified Amazon chain, retrieval, CTR/CVR calibration and position-bias
diagnostics. Every displayed
number is loaded from the frozen public JSON reports or an explicitly derived,
non-training demo fixture. Missing user-level BPR/Two-Tower traces remain
unavailable rather than being fabricated.

`make export-playground` creates an ignored, self-contained static directory
and ZIP for controlled migration. GitHub CI and a Pages deployment workflow are
included. Pages is not configured or deployed yet, so no public URL is claimed.

`make verify-public` validates source terms, raw file fingerprints, config and
split fingerprints, counts, seeds and result structure. `make test` and
`make smoke` validate the implementation; synthetic smoke output is not public
benchmark evidence.
