# Interview and Failure Guide

## Three-minute project story

1. **Problem:** retrieval, CTR, and OPE were honest but isolated offline
   experiments. They did not constitute one production funnel.
2. **Protocol:** the Amazon task now shares one user/item/history/metadata split
   across Two-Tower retrieval, exact and HNSW candidate generation, negative
   sampling, reranking, calibration, and paired evaluation.
3. **Analysis:** comparisons hold the cohort and budget fixed, use user-level
   bootstrap confidence intervals, report cold-start cohorts, and measure the
   ANN recall-latency-size trade-off.
4. **Ads task:** CVR/ESMM is evaluated separately on Criteo impression logs so
   click and conversion labels have the right population. It is not presented
   as a continuation of Amazon behavior.
5. **Boundary:** all results are offline and public-data-only. They do not prove
   online lift, revenue impact, marketplace behavior, or production readiness.

## Questions to be ready for

### Why not combine Amazon, Criteo, and Open Bandit into one funnel?

They represent different users, items, policies, labels, and logging processes.
Combining their metrics would invent cross-dataset causality. Amazon supports a
unified retrieval-to-reranking protocol; Criteo supports impression-level CTR
and conversion modeling; Open Bandit supports off-policy evaluation.

### Why are hard negatives useful?

Uniform negatives are often trivially separable. Hard negatives are plausible
items retrieved by the current model, so they focus the reranker on close
mistakes. The experiment must keep training budget, positive rows, split, and
evaluation candidates fixed before attributing a difference to sampling.

### Why bootstrap users instead of rows?

Ranking metrics are aggregated per query/user and interactions from the same
user are dependent. Resampling users preserves the evaluation unit and enables
paired deltas between models on the same queries.

### Why can HNSW recall be high while NDCG is low?

HNSW recall measures agreement with exact nearest-neighbor retrieval. It says
nothing about whether the embedding ranks the true next item well. The first is
systems approximation quality; the second is recommendation relevance.

### Why calibrate after reranking?

Ranking scores need not be probabilities. A calibration layer fitted only on
training data can make probability-like outputs more interpretable for later
decision rules. Calibration metrics and ranking metrics are reported separately
because monotonic calibration may not improve ordering.

### What is the biggest remaining production gap?

Offline public datasets do not provide KAI's real exposure, selection, order,
fulfillment, or settlement feedback. Online logging, delayed-label handling,
drift monitoring, and controlled experiments remain outside this lab.

## Failure cases worth showing

- A target outside the retrieval Top-K demonstrates the candidate bottleneck.
- A target retrieved by exact search but missed by HNSW demonstrates an ANN
  operating-point trade-off.
- A long-history user helped by DIN while a short-history user is not shows why
  aggregate metrics need cohorts.
- A metadata-heavy model failing on sparse catalog rows demonstrates coverage
  and missingness risk.
- A calibrated model with better ECE but unchanged NDCG demonstrates that
  calibrated probabilities and ranking quality are different objectives.
- ESMM improving CTCVR calibration but not post-click CVR discrimination is a
  valid mixed result, not a reason to suppress a metric.
