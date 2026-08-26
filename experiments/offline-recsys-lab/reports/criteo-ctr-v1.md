# Criteo CTR public fixed-subset V1

Status: `COMPLETE`; data origin: `public`; online claim: `false`.

## Frozen protocol

- Rows: 42,000 train / 9,000 dev / 9,000 test.
- Split: fixed contiguous source-order blocks; not claimed chronological.
- Features: 13 numeric + 26 categorical, identical for all models; preprocessing fit on train only.
- Seeds: 3407, 6502, 9109.
- Config SHA-256: `f8f6b7be473ae28d5f0f27104c50f10fa7d831defba7230559e1cdd16142d6c1`.
- Split SHA-256: `857c6be8314aba44e9edf7acbf93e6421abfc75888dc63db9bd32545de629064`.
- Result SHA-256: `14b3e956e576dee5c3faa4e80bde3c78c34c5ed3734ccd3f45b4a18243079e08`.

## Test metrics — mean ± population std

| Model | ROC-AUC | PR-AUC | LogLoss | Brier | ECE |
|---|---:|---:|---:|---:|---:|
| Logistic Regression | 0.710306 ± 0.000000 | 0.096583 ± 0.000000 | 0.134786 ± 0.000000 | 0.029982 ± 0.000000 | 0.011489 ± 0.000000 |
| DeepFM | 0.692860 ± 0.015221 | 0.067137 ± 0.008446 | 0.134469 ± 0.000329 | 0.029963 ± 0.000015 | 0.007536 ± 0.004032 |
| DCNv2 | 0.671309 ± 0.009303 | 0.060136 ± 0.002281 | 0.137135 ± 0.001577 | 0.030476 ± 0.000187 | 0.007981 ± 0.000269 |

The first DeepFM execution was invalidated before final reporting because unit-scale default factor initialization made train/dev loss explode. The implementation was corrected from train/dev evidence, then the same frozen split, seeds, feature set, epoch budget and test protocol were rerun. Invalidated-run training digest: `11a2dbae709f90c918491986b17e5ddda846b8beb283dbbda6ff8782f5a7016c`.

LR has the strongest ROC-AUC and PR-AUC in this fixed subset; DeepFM has the lowest mean LogLoss/Brier; DeepFM and DCNv2 have lower mean ECE than LR. These are descriptive offline comparisons, not online lift.

## Limitations

- This is a fixed 60000-row prefix of one official parquet shard, not the full 1TB or 24-day dataset.
- The shard belongs to one published day, but the Hugging Face parquet conversion order was not independently audited; the split is source-order, not claimed temporal.
- Criteo states positive and negative examples were subsampled at different rates, so raw probabilities are not population CTR without correction.
- Hashed categorical feature semantics are undisclosed.
- Offline public-data metrics do not establish KAI production, online lift, or business performance.
- CC BY-NC-SA 4.0 restricts this dataset use to noncommercial purposes under its terms.
