# Amazon End-to-End Recommendation V3

**Status: COMPLETE · PUBLIC OFFLINE DATA · NOT ONLINE PERFORMANCE**

Two-Tower retrieval → exact/HNSW Top-K → negative sampling → DIN/DCN-style reranking → train-only temperature calibration → frozen offline evaluation. All stages use one Amazon Industrial and Scientific 5-core protocol.

## Final frozen test result

| Evidence | Value |
| --- | ---: |
| Test users | 50,653 |
| Exact retrieval NDCG@100 | 0.021026 |
| Selected reranker NDCG@100 | 0.023514 |
| Paired user delta | 0.002488 |
| 95% paired user bootstrap CI | [0.002283, 0.002680] |
| Bootstrap samples | 2,000 |

The selected candidate is `exact-din-uniform-64-32`. Selection used dev NDCG@100 only; the bundled test was opened once after the selection manifest was frozen. The interval excludes zero under this offline protocol, but the report deliberately makes no online significance or lift claim.

## Dev model and negative-sampling comparison

| Candidate | Reranker | Negatives | Retrieval | Dev NDCG@100 |
| --- | --- | --- | --- | ---: |
| `exact-din-hard-64-32` | din_style | hard | exact | 0.017976 |
| `exact-dcn-hard-64-32` | dcn_style | hard | exact | 0.018183 |
| `exact-din-uniform-64-32` | din_style | uniform | exact | 0.027767 |
| `exact-din-inbatch-64-32` | din_style | in_batch | exact | 0.023907 |
| `hnsw-din-hard-64-32` | din_style | hard | hnsw | 0.017969 |

Hard negatives did **not** win this frozen comparison; uniform negatives selected the strongest dev candidate. That negative result is retained rather than hidden.

## Feature ablation

| Variant | Dev NDCG@100 | Delta from full |
| --- | ---: | ---: |
| full | 0.024723 | 0.000000 |
| without_metadata | 0.020647 | -0.004076 |
| without_id | 0.022373 | -0.002350 |
| without_title | 0.022383 | -0.002340 |
| without_category | 0.020740 | -0.003983 |

This is frozen-checkpoint inference input zeroing on one fixed dev candidate set, not retraining each variant. It measures reliance under the frozen model and must not be described as a full retrained ablation.

## HNSW recall–latency–size sweep

| M | efSearch | Recall@100 vs exact | p95 latency (ms) | Index bytes |
| ---: | ---: | ---: | ---: | ---: |
| 8 | 100 | 0.862800 | 0.059568 | 8,785,452 |
| 16 | 200 | 0.981100 | 0.268627 | 10,417,976 |
| 16 | 400 | 0.996500 | 0.280265 | 10,417,976 |

Latency is local-process wall-clock evidence, not a production SLA. The sweep was diagnostic and did not select the reranking winner.

## Cold-start and provenance boundary

Cohort-eligible test queries: 50,652. Equal-timestamp exclusions: 1. The two values reconcile to the full 50,653-user test population.

The frozen 5-core protocol contains no true new users, no known users without history, and no unseen target items. The report exposes those groups with zero support rather than inventing cold-start performance. Cohort features come only from earlier splits and strictly pre-evaluation timestamps.

## Reproduce and verify

```bash
make reproduce-small
make verify-public
make verify-playground
```

`reproduce-small` checks the complete code path on synthetic data and makes no performance claim. The tracked aggregate report above comes from the pinned public dataset and frozen artifacts; raw third-party records and model weights are not published.
