# Amazon Reviews'23 retrieval source audit

Status: `APPROVED_FOR_ISOLATED_NON-COMMERCIAL_RESEARCH_WITH_LIMITATIONS`

The selected input is the official `Industrial_and_Scientific` 5-core,
de-duplicated, leave-last-out split published by McAuley Lab. The official
protocol defines train as the first `N-2` interactions, validation as `N-1`,
and test as `N`. Its published scale is approximately 51.0K users, 25.8K
items, and 311.0K / 51.0K / 51.0K train/validation/test rows.

Official protocol and downloads:
https://amazon-reviews-2023.github.io/data_processing/5core.html

Important rights boundary: the repository code is MIT licensed, but the
dataset maintainer explicitly states that they are not in a position to assign
a dataset license and that the data is made available primarily for research.
This experiment therefore treats the files as research-only public inputs,
does not redistribute raw rows, and does not use them in production or the KAI
business flywheel.

Dataset terms evidence:
https://huggingface.co/datasets/McAuley-Lab/Amazon-Reviews-2023/discussions/1

The interaction is a review/rating proxy. It is not an impression, click, or
verified order event. Metrics from this experiment are offline public-data
metrics only and are not evidence of online or KAI Compute performance.

The selected catalog is tens of thousands of items, not one million. No
million-scale claim is permitted from this run.
