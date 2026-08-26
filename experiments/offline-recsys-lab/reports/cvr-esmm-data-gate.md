# CVR / ESMM public-data gate

Status: `DEFERRED_NOT_RUN`

This is a data-validity decision, not a model result. No public CVR/ESMM
training or scoring was run in this phase.

## Gate requirements

An ESMM experiment must expose, for the same impression population:

- an impression row;
- a click indicator;
- a conversion indicator with a documented attribution window;
- features available at impression time;
- terms that permit this non-commercial offline research use.

Clicked-only conversion logs fail the gate because they cannot identify CTR or
CTCVR in impression space. Joining unrelated Criteo CTR and conversion datasets
would also fail: the rows, populations and feature semantics are not linkable.

## Audited candidates

### Criteo Sponsored Search Conversion Logs — rejected for ESMM

- Official page: <https://ailab.criteo.com/criteo-sponsored-search-conversion-log-dataset/>
- Terms: CC BY-NC-SA 4.0 on the official page.
- Official schema: sale/conversion, revenue and conversion delay, plus product,
  user and click-time features.
- Fatal limitation: Criteo states each row is an action, specifically a click.
  Non-clicked impressions are absent.
- Allowed future use: post-click CVR only. It must not be reported as
  impression-space CTR, CTCVR or ESMM.

### Criteo Attribution Modeling for Bidding — schema-eligible, deferred

- Official page: <https://ailab.criteo.com/criteo-attribution-modeling-bidding-dataset/>
- Official description: 16.5M impression rows over 30 days, with `click`,
  `conversion`, timestamps, campaign/context features, cost and attribution.
- Terms: the Criteo dataset terms presented by the publisher are
  CC BY-NC-SA 4.0; use is non-commercial and requires attribution/share-alike
  compliance.
- Schema decision: eligible for a future controlled ESMM experiment because
  the same impression records contain click and conversion outcomes.
- Label caveat: `conversion` means a conversion within 30 days after the
  impression, independently of whether that impression was the last click.
  The protocol must pre-register whether CTCVR is `click * conversion` and must
  not silently treat view-through conversion as post-click conversion.
- Current decision: deferred until Retrieval, CTR and sequence baselines are
  stable, as required by the staged research plan. The 623 MB archive was not
  downloaded in this phase.

### Ali-CCP — blocked pending exact terms/download evidence

- Dataset page: <https://tianchi.aliyun.com/dataset/408>
- Tianchi identifies it as Ali-CCP, but the unauthenticated page exposed here
  did not provide a verifiable per-dataset license or downloadable artifact.
- Tianchi's platform guidance says use must follow each dataset's license.
- Current decision: do not download, train or report metrics until the exact
  Ali-CCP license/terms and artifact identity are captured through an
  authorized Tianchi session.

## Future frozen comparison

When the eligible dataset is deliberately activated, the minimum comparison is:

1. naive post-click CVR trained only on clicked samples;
2. ESMM trained on all impressions with CTR and CTCVR objectives.

Both must use one train/dev/test split and train-fitted preprocessing. Report
CTR AUC/LogLoss/calibration, CTCVR AUC/LogLoss/calibration, and post-click CVR
AUC/LogLoss/calibration. Metrics must include row counts and positive counts;
test data cannot select features, epochs, calibration or hyperparameters.

## Truth boundary

`DEFERRED_NOT_RUN` means no conclusion about ESMM superiority or
sample-selection-bias correction has been measured. Existing synthetic smoke
tests only verify code paths and are not public-data evidence.
