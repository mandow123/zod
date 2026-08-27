from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "reports" / "amazon-end-to-end-v3-results.json"
OUTPUT = ROOT / "reports" / "amazon-end-to-end-v3.md"


def metric(value: float) -> str:
    return f"{value:.6f}"


def main() -> None:
    report = json.loads(SOURCE.read_text(encoding="utf-8"))
    dev = report["devSelection"]
    ci = report["results"]["confidenceInterval"]
    exact = report["test"]["retrieval"]["exact"]["100"]
    reranked = report["test"]["rerankedSummary"]["100"]
    cohort = report["test"]["cohorts"]["selectedReranker"]

    lines = [
        "# Amazon End-to-End Recommendation V3",
        "",
        "**Status: COMPLETE · PUBLIC OFFLINE DATA · NOT ONLINE PERFORMANCE**",
        "",
        "Two-Tower retrieval → exact/HNSW Top-K → negative sampling → DIN/DCN-style reranking → train-only temperature calibration → frozen offline evaluation. All stages use one Amazon Industrial and Scientific 5-core protocol.",
        "",
        "## Final frozen test result",
        "",
        "| Evidence | Value |",
        "| --- | ---: |",
        f"| Test users | {report['protocol']['testEvaluationUsers']:,} |",
        f"| Exact retrieval NDCG@100 | {metric(exact['ndcg'])} |",
        f"| Selected reranker NDCG@100 | {metric(reranked['ndcg']['mean'])} |",
        f"| Paired user delta | {metric(ci['mean_difference'])} |",
        f"| 95% paired user bootstrap CI | [{metric(ci['lower_bound'])}, {metric(ci['upper_bound'])}] |",
        f"| Bootstrap samples | {ci['bootstrap_samples']:,} |",
        "",
        f"The selected candidate is `{report['selectedCandidate']['id']}`. Selection used dev NDCG@100 only; the bundled test was opened once after the selection manifest was frozen. The interval excludes zero under this offline protocol, but the report deliberately makes no online significance or lift claim.",
        "",
        "## Dev model and negative-sampling comparison",
        "",
        "| Candidate | Reranker | Negatives | Retrieval | Dev NDCG@100 |",
        "| --- | --- | --- | --- | ---: |",
    ]
    for candidate in dev["candidates"]:
        config = candidate["config"]
        lines.append(
            f"| `{candidate['id']}` | {config['modelType']} | {config['negativeSampling']} | {config['retrievalMode']} | {metric(candidate['devMetrics']['100']['ndcg'])} |"
        )
    lines += [
        "",
        "Hard negatives did **not** win this frozen comparison; uniform negatives selected the strongest dev candidate. That negative result is retained rather than hidden.",
        "",
        "## Feature ablation",
        "",
        "| Variant | Dev NDCG@100 | Delta from full |",
        "| --- | ---: | ---: |",
    ]
    deltas = dev["metadataAblations"]["ndcgAt100DifferenceFromFull"]
    for row in dev["metadataAblations"]["rows"]:
        variant = row["variant"]
        lines.append(f"| {variant} | {metric(row['metrics']['100']['ndcg'])} | {metric(deltas[variant])} |")
    lines += [
        "",
        "This is frozen-checkpoint inference input zeroing on one fixed dev candidate set, not retraining each variant. It measures reliance under the frozen model and must not be described as a full retrained ablation.",
        "",
        "## HNSW recall–latency–size sweep",
        "",
        "| M | efSearch | Recall@100 vs exact | p95 latency (ms) | Index bytes |",
        "| ---: | ---: | ---: | ---: | ---: |",
    ]
    for point in dev["hnswSweep"]["points"]:
        lines.append(
            f"| {point['m']} | {point['ef_search']} | {metric(point['recall_at_k'])} | {metric(point['p95_latency_ms'])} | {point['index_size_bytes']:,} |"
        )
    lines += [
        "",
        "Latency is local-process wall-clock evidence, not a production SLA. The sweep was diagnostic and did not select the reranking winner.",
        "",
        "## Cold-start and provenance boundary",
        "",
        f"Cohort-eligible test queries: {cohort['queryCount']:,}. Equal-timestamp exclusions: {cohort['equalTimestampQueriesExcluded']}. The two values reconcile to the full {report['protocol']['testEvaluationUsers']:,}-user test population.",
        "",
        "The frozen 5-core protocol contains no true new users, no known users without history, and no unseen target items. The report exposes those groups with zero support rather than inventing cold-start performance. Cohort features come only from earlier splits and strictly pre-evaluation timestamps.",
        "",
        "## Reproduce and verify",
        "",
        "```bash",
        "make reproduce-small",
        "make verify-public",
        "make verify-playground",
        "```",
        "",
        "`reproduce-small` checks the complete code path on synthetic data and makes no performance claim. The tracked aggregate report above comes from the pinned public dataset and frozen artifacts; raw third-party records and model weights are not published.",
    ]
    OUTPUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"rendered {OUTPUT}")


if __name__ == "__main__":
    main()
