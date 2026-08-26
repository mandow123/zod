# Position Bias Validity — Open Bandit Dataset Small

- Status: `COMPLETE`
- Data origin: `public`
- Claimable online performance: `false`
- Config SHA-256: `49c1224d7616a13e1e3d2210a9dcbc1e5486f0b8eb0cc4f8c4415098d6dae36b`
- Split SHA-256: `c2d1164e7ad9a816051898f1bb482e45fcb31f6116c20ad5eaf144b74ed6ff44`
- Result SHA-256: `4aa39b082a1da8ecd4e2411afa547d7ca5af7e9ee00a6b336c24ad4c3cf936b1`

This run uses the official 10,000-row-per-policy quickstart sample, not the 26M-row full dataset. The logged propensity supports action-selection OPE under its assumptions, but it is not an examination propensity. Therefore the run does not claim causal removal of latent position examination bias.

## Off-policy estimates

| Estimator | Policy value | Absolute error to random on-policy | ESS | Weight variance | Clipped |
|---|---:|---:|---:|---:|---:|
| on_policy_random | 0.00300000 | 0.00000000 | - | - | - |
| naive_bts | 0.00250000 | 0.00050000 | - | - | - |
| position_as_feature_standardization | 0.00254426 | 0.00045574 | - | - | - |
| ips | 0.00060645 | 0.00239355 | 45.07 | 66.968840 | 0 |
| snips | 0.00048808 | 0.00251192 | 45.07 | 66.968840 | 0 |
| ips_clipped_0p01 | 0.00060645 | 0.00239355 | 897.96 | 0.176029 | 269 |
| snips_clipped_0p01 | 0.00160129 | 0.00139871 | 897.96 | 0.176029 | 269 |
| ips_clipped_0p02 | 0.00058311 | 0.00241689 | 1191.97 | 0.050041 | 441 |
| snips_clipped_0p02 | 0.00214618 | 0.00085382 | 1191.97 | 0.050041 | 441 |
| ips_clipped_0p05 | 0.00035047 | 0.00264953 | 1607.11 | 0.006583 | 792 |
| snips_clipped_0p05 | 0.00213584 | 0.00086416 | 1607.11 | 0.006583 | 792 |
| ips_clipped_0p1 | 0.00022547 | 0.00277453 | 1863.79 | 0.000807 | 1161 |
| snips_clipped_0p1 | 0.00214580 | 0.00085420 | 1863.79 | 0.000807 | 1161 |

## Reward-model calibration on random-policy test data

| Reward model | Random-test LogLoss mean/std | Brier mean/std | ECE mean/std |
|---|---:|---:|---:|
| ips | 0.02512357 / 0.00000000 | 0.00336597 / 0.00000000 | 0.00173150 / 0.00000000 |
| ips_clipped_0p01 | 0.02231239 / 0.00000000 | 0.00301852 / 0.00000000 | 0.00195916 / 0.00000000 |
| ips_clipped_0p02 | 0.02241317 / 0.00000000 | 0.00301805 / 0.00000000 | 0.00274103 / 0.00000000 |
| ips_clipped_0p05 | 0.02277992 / 0.00000000 | 0.00302529 / 0.00000000 | 0.00423801 / 0.00000000 |
| ips_clipped_0p1 | 0.02346295 / 0.00000000 | 0.00304012 / 0.00000000 | 0.00561678 / 0.00000000 |
| naive | 0.02230425 / 0.00000000 | 0.00303134 / 0.00000000 | 0.00236055 / 0.00000000 |
| position_as_feature | 0.02214996 / 0.00000000 | 0.00302940 / 0.00000000 | 0.00221920 / 0.00000000 |
| snips | 0.02522480 / 0.00000000 | 0.00337780 / 0.00000000 | 0.00170130 / 0.00000000 |

## Position calibration and weighted metric

| Reward model | Position 1 gap | Position 2 gap | Position 3 gap | Weighted BTS-test LogLoss |
|---|---:|---:|---:|---:|
| ips | 0.00063796 | 0.00145788 | 0.00436088 | 0.00593753 |
| ips_clipped_0p01 | 0.00032600 | 0.00182957 | 0.00371160 | 0.00788035 |
| ips_clipped_0p02 | 0.00118627 | 0.00260003 | 0.00442723 | 0.00901078 |
| ips_clipped_0p05 | 0.00270379 | 0.00410086 | 0.00589990 | 0.01044203 |
| ips_clipped_0p1 | 0.00407583 | 0.00550306 | 0.00726158 | 0.01209620 |
| naive | 0.00089702 | 0.00205723 | 0.00412096 | 0.00764467 |
| position_as_feature | 0.00132571 | 0.00175982 | 0.00357225 | 0.00768906 |
| snips | 0.00068551 | 0.00141999 | 0.00435569 | 0.00587057 |

Per-position observed CTR, predicted CTR, calibration gaps, all seed-level metrics, raw file hashes, weight diagnostics and clipping results are preserved in the JSON report.

## Limitations

- The official small files contain only 10,000 rows per policy and very few clicks; estimates and calibration bins have high sampling uncertainty.
- The logged propensity is item-at-position action-selection probability, not user examination propensity; this run does not causally identify or remove position examination bias.
- Position-as-feature may learn the presentation shortcut and is an associational baseline, not a debiasing method.
- The reward models are trained only on the BTS train partition and evaluated on a temporally later random-policy sample; no test result selected a feature, clipping threshold, or model.
- The official full archive identifies the dataset license as CC BY 4.0; this offline run still makes no production-performance claim.
- Offline OPE and calibration results are not evidence of online CTR or revenue lift.
- The three seed runs use a deterministic convex LR solver, so zero between-seed standard deviation is not a sampling-uncertainty estimate.
