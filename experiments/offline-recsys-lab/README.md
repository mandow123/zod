# KAI Offline RecSys Lab

Independent public-data research for end-to-end retrieval/ranking, CTR,
post-click conversion, position-bias evaluation and value-aware ranking.

## Truth boundary

- This directory is physically separate from Compute Production, migration 0066,
  its Data Flywheel and the frozen Compute Ranking benchmark.
- Only `public` and explicitly labeled `synthetic` test data are accepted.
- Synthetic fixtures validate code paths only. They are never reported as public
  benchmark or production results.
- Raw third-party datasets and trained artifacts are ignored by Git. Acquisition
  requires a captured dataset-specific usage record in `sources/source-ledger.json`.
- No offline result is evidence of online CTR, conversion lift, revenue lift or
  KAI Compute marketplace performance.

## Workstreams

1. Retrieval: popularity / ItemKNN / matrix-factorization / Two-Tower / HNSW.
2. Unified ranking: exact/HNSW candidates / hard, uniform and in-batch
   negatives / DIN-style and DCN-style rerankers / calibration / evaluation.
3. CTR and conversion: LR / DeepFM / DCNv2 / post-click CVR / ESMM.
4. Sequence: mean pooling / target-aware DIN-style attention.
5. Debiasing and ads: position baseline / IPS / SNIPS / value-aware ranking.

Every comparison uses one model-independent cohort, feature set, split and seed
protocol. Split semantics stay dataset-specific: Amazon uses the provider's
leave-last-out split, Criteo uses fixed source-order blocks without claiming
chronology, and Open Bandit uses a fixed timestamp cutoff.

## Executed public protocols

- Amazon Reviews'23 `Industrial_and_Scientific`: full 25,754-item train
  catalog, 50,653 common test users, Popularity / ItemKNN / BPR MF /
  Two-Tower exact retrieval and HNSW ANN; Mean Pooling / DIN reranking over a
  frozen ItemKNN Top-100 candidate set.
- Amazon end-to-end V3: one frozen protocol from the existing Two-Tower
  checkpoint through exact/HNSW Top-100, three negative-sampling strategies,
  DIN/DCN-style reranking, train-only calibration, user-level bootstrap,
  metadata/ID/title/category ablation and cold-start/popularity cohorts.
- Criteo 1TB Click Logs: a pinned, non-label-sampled 60,000-row prefix from one
  official parquet shard, LR / DeepFM / DCNv2 with ranking and calibration
  metrics.
- Open Bandit Dataset: full-archive final-window OPE plus the official small
  sample for reward-model and per-position calibration diagnostics.
- Criteo Attribution: a fixed 200,000-row impression population with click and
  conversion labels, naive clicked-only CVR and ESMM, three seeds, train-only
  preprocessing and a single frozen test opening.

The tracked JSON reports include source terms, raw file hashes, config/split
hashes, exact row counts, seeds, metrics and limitations. Raw data and model
indexes remain ignored.

## Local verification

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e .
make test
make smoke
make reproduce-small
make verify-public
make verify-playground
```

`make reproduce-small` runs the unified retrieval/ranking, CVR/ESMM and
evaluation code paths on a deterministic synthetic fixture in one command.
It proves reproducibility of the small code path, not the reported performance.
`make smoke` exercises every model family with an explicitly synthetic fixture
and writes an ignored `artifacts/synthetic-smoke.json`. It is an integration
check, not a benchmark result. `make verify-public` verifies provenance and
reproducibility fields in executed public reports; it does not rerun training.

## Local recruiting playground

Run `make playground`, then open `http://127.0.0.1:4190/playground/`. The
static viewer has no login, API key or external network dependency and reads
the tracked public result reports at runtime. Its first evidence panel exposes
the unified V3 comparison, feature ablation, HNSW trade-off, bootstrap interval
and cold-start support; CVR/ESMM is shown as a separate impression-level ads
task rather than falsely joined to the Amazon funnel. See `playground/README.md`.

GitHub Actions verifies the test suite, one-command reproduction, public
reports and portable page export. A Pages deployment workflow is included, but
no public deployment is claimed until the branch is approved, merged and the
repository Pages environment is configured.

The Amazon catalog in this version has 25,754 items. It supports a measured
tens-of-thousands full-catalog and ANN evaluation claim, not a million-item
retrieval claim.
