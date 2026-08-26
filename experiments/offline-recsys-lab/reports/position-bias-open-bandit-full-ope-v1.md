# Position Bias Validity — Open Bandit Dataset Full OPE

- Status: `COMPLETE`
- Data origin: `public`
- Claimable online performance: `false`
- BTS held-out rows/clicks: `2055926` / `11162`
- Random held-out rows/clicks: `229613` / `885`
- Config SHA-256: `49c1224d7616a13e1e3d2210a9dcbc1e5486f0b8eb0cc4f8c4415098d6dae36b`
- Split SHA-256: `25fbf5ffa8d3ee7dbc0d357140384cf24b2fb34116eb83ec0e7bc15eeff4e80c`
- Result SHA-256: `4ada23dbb5f3a434bdbef59f9d0b9f19e8241acdb1ae624324af4d30494ab2ef`

This deterministic run streams every held-out row in the official ALL-campaign full archive. It evaluates logged action-selection IPS validity, not latent examination-propensity correction.

## Full held-out OPE

| Estimator | Policy value | Abs. error | ESS | Weight variance | Clipped |
|---|---:|---:|---:|---:|---:|
| on_policy_random | 0.00385431 | 0.00000000 | - | - | - |
| naive_bts | 0.00542918 | 0.00157487 | - | - | - |
| position_stratified_associational | 0.00542920 | 0.00157489 | - | - | - |
| ips | 0.00404723 | 0.00019292 | 24735.21 | 83.100479 | 0 |
| snips | 0.00402322 | 0.00016891 | 24735.21 | 83.100479 | 0 |
| ips_clipped_0p01 | 0.00185544 | 0.00199887 | 968751.02 | 0.168089 | 266755 |
| snips_clipped_0p01 | 0.00479427 | 0.00093996 | 968751.02 | 0.168089 | 266755 |
| ips_clipped_0p02 | 0.00140648 | 0.00244783 | 1286255.14 | 0.047712 | 453015 |
| snips_clipped_0p02 | 0.00498090 | 0.00112659 | 1286255.14 | 0.047712 | 453015 |
| ips_clipped_0p05 | 0.00090327 | 0.00295104 | 1714486.46 | 0.005943 | 851148 |
| snips_clipped_0p05 | 0.00522871 | 0.00137440 | 1714486.46 | 0.005943 | 851148 |
| ips_clipped_0p1 | 0.00058725 | 0.00326706 | 1954455.81 | 0.000622 | 1309503 |
| snips_clipped_0p1 | 0.00536631 | 0.00151200 | 1954455.81 | 0.000622 | 1309503 |

## Calibration by position

| Estimator | Position 1 abs. error | Position 2 abs. error | Position 3 abs. error |
|---|---:|---:|---:|
| ips | 0.00068794 | 0.00030594 | 0.00096070 |
| snips | 0.00077457 | 0.00014732 | 0.00126198 |
| ips_clipped_0p01 | 0.00206256 | 0.00171075 | 0.00222327 |
| snips_clipped_0p01 | 0.00039714 | 0.00118307 | 0.00132522 |
| ips_clipped_0p02 | 0.00250751 | 0.00212763 | 0.00270836 |
| snips_clipped_0p02 | 0.00059464 | 0.00136263 | 0.00148244 |
| ips_clipped_0p05 | 0.00300561 | 0.00259646 | 0.00325104 |
| snips_clipped_0p05 | 0.00091556 | 0.00157374 | 0.00163860 |
| ips_clipped_0p1 | 0.00331077 | 0.00288341 | 0.00360699 |
| snips_clipped_0p1 | 0.00109605 | 0.00173711 | 0.00168278 |

Per-position OPE estimates, raw counts, source evidence and all clipping diagnostics are preserved in the JSON report.

## Limitations

- The full-data OPE result evaluates the fixed final 20% time window of the seven-day ALL campaign only; traffic volume means this is not exactly 20% of rows, and it is not an online experiment.
- The logged propensity is item-at-position action-selection probability, not examination propensity; causal position-examination debiasing is not identified.
- The paper's OPE validity assumptions include overlap/consistency and a reward model depending on item and position; violations remain possible.
- Clipping thresholds were preregistered and all are reported; none was selected on test results.
- The deterministic full OPE has no between-seed variance; sampling uncertainty is not represented by the listed seeds.
- No production, revenue-lift, or online-CTR claim follows from this offline public-data result.
