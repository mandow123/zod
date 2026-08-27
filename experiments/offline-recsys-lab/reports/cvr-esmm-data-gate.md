# CVR / ESMM public-data gate

Status: `RESOLVED_COMPLETE_OFFLINE`

The earlier `DEFERRED_NOT_RUN` decision was correct: clicked-only Sponsored
Search rows cannot identify CTR or CTCVR in impression space. The gate is now
resolved with the Criteo Attribution Modeling for Bidding dataset, whose same
impression rows contain click and conversion labels. This does not join the
unrelated Criteo CTR and conversion datasets.

## Frozen source and terms

- Official source page: <https://ailab.criteo.com/criteo-attribution-modeling-bidding-dataset/>
- Publisher mirror: <https://huggingface.co/datasets/criteo/criteo-attribution-dataset>
- Pinned mirror revision: `904188a63cbad78bee43cd26ff5ee4ac77903986`
- License: CC BY-NC-SA 4.0; noncommercial offline research with attribution and
  ShareAlike obligations.
- Artifact: 653,015,824 bytes; SHA-256
  `94ac7a465564349bc7ba008602211d5990a3c53cc133abc0aadef61ea2391a98`.
- The legacy `go.criteo.net` download returned HTTP 404 on 2026-08-27. It was
  not used; the acquisition came from Criteo's own Hugging Face organization.

Raw rows and checkpoints remain ignored and are not redistributed.

## Executed protocol

- Fixed first 200,000 physical impressions in publisher-declared timestamp
  order; no label-conditioned sampling.
- Train/dev/test: 140,000 / 30,000 / 30,000 contiguous rows.
- Three seeds: 3407, 6502, 9109.
- Train-only preprocessing and feature allowlist: `cost`, `campaign`,
  `cat1..cat9`.
- `uid`, timestamp, click/conversion/attribution fields, conversion identifiers,
  CPO, click position/count, and time-since-click are excluded from features.
- Naive CVR is trained only on clicked training impressions. ESMM jointly
  learns CTR and CTCVR on all training impressions.
- CTCVR is explicitly `click × raw_conversion_30d`; `attribution` is audit-only.
- Test was consumed exactly once after dev checkpoint selection.

## Frozen public test summary

Mean across three seeds; population standard deviations are in the JSON report.

| Evaluation | AUC | LogLoss | Brier | ECE |
|---|---:|---:|---:|---:|
| Naive clicked-only CVR | 0.810773 | 0.327262 | 0.097532 | 0.024204 |
| ESMM CTR | 0.736028 | 0.559379 | 0.188682 | 0.014789 |
| ESMM CTCVR | 0.841541 | 0.151314 | 0.039463 | 0.003202 |
| ESMM post-click CVR | 0.823026 | 0.314712 | 0.093289 | 0.012140 |

Exact evidence, per-seed metrics, calibration bins, split counts, source terms,
and limitations are in `criteo-esmm-v1-results.json`.

## Remaining truth boundary

This is a descriptive public-data offline result on a 200,000-row prefix, not
the full 16.5M impressions. It does not establish causal attribution, online
CVR lift, revenue lift, advertising deployment, or KAI production performance.
The first prefix contains no view-through conversion rows after applying the
registered CTCVR definition; the loader's separation of raw conversion from
CTCVR is covered by synthetic contract tests, not claimed as a measured cohort.
