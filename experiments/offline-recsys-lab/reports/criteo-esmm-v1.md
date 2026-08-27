# Criteo impression-level CVR / ESMM V1

Status: `COMPLETE`; online-performance claim: `false`.

## Frozen evidence and boundary

- Artifact SHA-256: `94ac7a465564349bc7ba008602211d5990a3c53cc133abc0aadef61ea2391a98` (653,015,824 bytes).
- Split SHA-256: `15e3e91f972a2faed67b39448238b83402c325c66b8c426b24430c60ed68aaef`.
- CTCVR is pre-registered as `click × raw 30-day impression conversion`.
- Raw conversion may include view-through association; attribution is audit-only and never a feature/target.
- Preprocessing is fit on train only; test is consumed once after checkpoint freezing.

## Split counts

- Train/dev/test rows: 140,000 / 30,000 / 30,000.
- Train/dev/test CTCVR positives: 7,172 / 1,522 / 1,477.

## Frozen test metrics — mean ± population std across seeds

| Evaluation | AUC | LogLoss | Brier | ECE |
|---|---:|---:|---:|---:|
| Naive clicked-only CVR | 0.810773 ± 0.002142 | 0.327262 ± 0.003020 | 0.097532 ± 0.001243 | 0.024204 ± 0.003253 |
| ESMM CTR | 0.736028 ± 0.000484 | 0.559379 ± 0.000292 | 0.188682 ± 0.000169 | 0.014789 ± 0.005394 |
| ESMM CTCVR | 0.841541 ± 0.000741 | 0.151314 ± 0.000185 | 0.039463 ± 0.000063 | 0.003202 ± 0.000419 |
| ESMM post-click CVR | 0.823026 ± 0.001066 | 0.314712 ± 0.000530 | 0.093289 ± 0.000246 | 0.012140 ± 0.002072 |

These are descriptive offline public-data measurements, not KAI production or online-lift evidence.

## Limitations

- This V1 uses a fixed 200000-row timestamp-ordered prefix, not all 16.5M impressions or the full 30-day span.
- The official raw conversion label is impression-associated within 30 days and must not be described as last-click or causal post-click conversion; ESMM CTCVR is explicitly click multiplied by raw conversion.
- Repeated users and conversion timelines may cross temporal boundaries; uid and conversion_id are excluded from features, but the fixed prefix is not a user- or conversion-group holdout.
- Criteo anonymizes and subsamples the traffic, and contextual feature meanings are undisclosed.
- Cost is transformed by the publisher and is not a real market price.
- The publisher's legacy go.criteo.net archive link returned HTTP 404 on 2026-08-27; acquisition uses the same dataset in Criteo's official Hugging Face organization at a pinned revision.
- Offline public-data metrics do not establish KAI production performance, online lift, or business impact.
- CC BY-NC-SA 4.0 limits this use to noncommercial purposes under its attribution and ShareAlike terms.
