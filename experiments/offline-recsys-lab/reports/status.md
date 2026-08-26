# Offline RecSys Lab Status

| Area | Status | Evidence boundary |
|---|---|---|
| Isolated branch/worktree | READY | Based on canonical main; no Compute benchmark or P0-A files copied |
| Source ledger | READY | Amazon research-only/no assigned license; Criteo CC BY-NC-SA 4.0; Open Bandit CC BY 4.0 |
| Python environment | READY | Pinned macOS arm64 PyTorch/scikit-learn/HNSW environment |
| Retrieval/ANN/sequence code | READY | Popularity, ItemKNN, BPR, Two-Tower, exact/HNSW and target-aware attention |
| CTR/conversion code | READY | LR, DeepFM, DCNv2, naive PostClickCVR and ESMM |
| Debiasing/ads code | READY | IPS/SNIPS diagnostics and five deterministic ad objectives |
| Synthetic unit/smoke tests | PASSED | Unified code-path smoke; not performance evidence |
| Amazon public benchmark | COMPLETE | 310,977/50,985/50,985 official rows; 25,754-item catalog; 50,653 common test users |
| Amazon sequence benchmark | COMPLETE_NEGATIVE | DIN did not stably exceed Mean Pooling on the frozen ItemKNN Top-100 protocol |
| Criteo CTR benchmark | COMPLETE_FIXED_SUBSET | 60,000 fixed rows from one official shard; not the full 1TB corpus |
| CVR/ESMM public benchmark | DEFERRED_NOT_RUN | Clicked-only source rejected; eligible impression dataset intentionally deferred |
| Position-bias public benchmark | COMPLETE | Full archive OPE plus small-sample reward-model calibration; action propensity only |
| Production integration | OUT_OF_SCOPE | No 0066, Data Flywheel, UI, order or business-data writes |
| Recruitment playground | COMPLETE_LOCAL_DEMO | Chinese-first, local-only, artifact-driven; browser-checked at desktop and mobile widths |
| Portable static export | READY | Reproducible self-contained directory/ZIP; generated output is ignored by Git |
| Public portfolio deployment | NOT_EXECUTED | Requires separate attribution/license review and personal-site build/deployment QA |

Executed metrics are public offline measurements only. They are not evidence of
online lift, marketplace performance, conversion lift or revenue lift.
