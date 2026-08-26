# Amazon Reviews'23 Retrieval V1

Status: `COMPLETE`

Data origin: `public`

Online-performance claim: `false`

## Protocol

- Official `Industrial_and_Scientific` 5-core, de-duplicated,
  leave-last-out-with-history files.
- Same 50,653 test users and same 25,754-item complete train catalog for
  Popularity, ItemKNN, BPR MF, and Two-Tower.
- The 332 test targets absent from the train catalog are excluded once before
  any model runs. No test user is cold.
- Every model excludes the complete timestamp-safe query history. Evaluation
  uses no sampled negatives.
- Seeds: 3407, 6502, 9109. Popularity and ItemKNN are deterministic, so their
  repeated-seed standard deviation is zero.
- Rows: 310,977 train / 50,985 dev / 50,985 test.

## Full-catalog test metrics

Values are mean ± population standard deviation across the fixed seeds.
With one test target per user, Recall and HitRate are numerically identical;
both fields are retained in the JSON report.

| Model | K | Recall / HitRate | MRR | NDCG |
|---|---:|---:|---:|---:|
| Popularity | 20 | 0.026218 ± 0.000000 | 0.006836 ± 0.000000 | 0.011009 ± 0.000000 |
| Popularity | 50 | 0.045427 ± 0.000000 | 0.007438 ± 0.000000 | 0.014802 ± 0.000000 |
| Popularity | 100 | 0.070618 ± 0.000000 | 0.007792 ± 0.000000 | 0.018872 ± 0.000000 |
| ItemKNN | 20 | 0.029396 ± 0.000000 | 0.010628 ± 0.000000 | 0.014728 ± 0.000000 |
| ItemKNN | 50 | 0.046256 ± 0.000000 | 0.011155 ± 0.000000 | 0.018057 ± 0.000000 |
| ItemKNN | 100 | 0.066334 ± 0.000000 | 0.011436 ± 0.000000 | 0.021296 ± 0.000000 |
| BPR MF | 20 | 0.013161 ± 0.000620 | 0.003440 ± 0.000181 | 0.005526 ± 0.000244 |
| BPR MF | 50 | 0.023269 ± 0.000920 | 0.003754 ± 0.000189 | 0.007517 ± 0.000306 |
| BPR MF | 100 | 0.034661 ± 0.001338 | 0.003914 ± 0.000192 | 0.009357 ± 0.000366 |
| Two-Tower exact | 20 | 0.000888 ± 0.000113 | 0.000141 ± 0.000022 | 0.000296 ± 0.000041 |
| Two-Tower exact | 50 | 0.002224 ± 0.000034 | 0.000182 ± 0.000017 | 0.000559 ± 0.000012 |
| Two-Tower exact | 100 | 0.004218 ± 0.000262 | 0.000209 ± 0.000015 | 0.000879 ± 0.000026 |

## Exact versus HNSW ANN

| Measurement | Mean | Std |
|---|---:|---:|
| ANN Recall@20 | 0.933282 | 0.009339 |
| ANN Recall@50 | 0.912947 | 0.009619 |
| ANN Recall@100 | 0.888194 | 0.009888 |
| Per-query p50 latency | 0.126792 ms | 0.013816 ms |
| Per-query p95 latency | 0.351742 ms | 0.116958 ms |
| QPS | 6,255.72 | 1,253.05 |
| Serialized index size | 7,122,008 bytes | 1,071 bytes |

Latency includes one-query HNSW lookup and removal of history items. Index
construction uses one thread and inner-product search. Detailed per-seed index
hashes and timings are in the JSON report.

## Finding

This run does not show an embedding-retrieval win. ItemKNN has the strongest
MRR/NDCG at each reported K, Popularity has the highest Recall@100, and the
configured ID/history Two-Tower is near the random-retrieval rate and loses to
all three baselines. The result is retained without test-set tuning.

Plausible causes such as short histories, an ID-only item tower, in-batch
negative composition, and limited training are hypotheses, not findings. Any
next configuration must be selected using dev only and reported as a new
experiment version.

The measured catalog has 25,754 items. This supports a tens-of-thousands
full-catalog retrieval claim, not a million-item claim.

## Provenance and limitations

- Official protocol: https://amazon-reviews-2023.github.io/data_processing/5core.html
- Terms evidence: https://huggingface.co/datasets/McAuley-Lab/Amazon-Reviews-2023/discussions/1
- The provider has not assigned a dataset license and describes the release as
  primarily for research. This is isolated non-commercial research use; raw
  rows are not redistributed.
- Review/rating interactions are not impressions, clicks, orders, or KAI
  business events.
- Full hashes, file sizes, split hash, counts, exclusions, per-seed results,
  and limitations: `reports/amazon-retrieval-v1-results.json`.
