# ZOD Architecture Optimization · Merge Guide

## Lineage

- Parent SHA: `4a6236ec9bc3ae04f54713617a388f0b0aed7a6f`
- Branch: `codex/architecture-optimization-20260824`
- Required order: **架构分支 → 视觉分支**
- Baseline note: this parent contains 447 changed paths relative to `a251c17cc2395ff98828b5f24e9641866c677a9e`; do not replay an old whole-file `App.tsx`.

## File whitelist

- `App.tsx`
- `src/navigation.ts`
- `src/core/app-navigation-intents.ts`
- `src/core/use-app-lifecycle.ts`
- `src/components.tsx` (BottomNav type/primary-tab contract only)
- focused `test/*.test.mjs`, including `test/provider-assets.test.mjs`
- `docs/ZOD_PRODUCT_CONTRACT.md`
- `docs/ZOD_ARCHITECTURE_OPTIMIZATION.md`
- `architecture-previews/current-state.html`
- `architecture-previews/target-state.html`
- this guide
- `docs/product-audits/PM-20260824-004.json`

## Protected surfaces

The branch must have zero diff under `src/screens/**`, `backend/**`, package or lock files, `tsconfig.json`, `src/theme.ts`, Inquiry/Wallet Sheet implementations, `src/provider-next-navigation.ts`, API/data/error contracts, visual release assets, and `.chief-of-staff/**`.

Static anchors must continue to prove both Inquiry Sheet imports/state/Market callbacks/mount props, Profile wallet support and Qixiang capability/user/subject props, KAI OIDC/session recovery, staging shell/banner, and formal/staging order source handling.

## Verification

Run from a clean checkout of the branch with the lockfile-installed dependencies:

```sh
git diff --check 4a6236ec9bc3ae04f54713617a388f0b0aed7a6f...HEAD
npm run typecheck:mobile
npm test
npm run contract:verify
npm run audit:product -- --commit HEAD
```

Also parse both architecture HTML files with an HTML parser, compare protected paths to the parent, and verify the remote branch ref equals local `HEAD`.

## Integration and rollback

No PR, merge, deployment or production change is authorized by this guide. After separate approval, an integrator may require a linear relationship with:

```sh
git merge-base --is-ancestor 4a6236ec9bc3ae04f54713617a388f0b0aed7a6f codex/architecture-optimization-20260824
git merge --ff-only codex/architecture-optimization-20260824
```

If the architecture commit has been integrated and a separately authorized rollback is required, create a traceable inverse commit rather than rewriting history:

```sh
git revert <architecture-commit-sha>
```

Do not force-push or delete the branch. A revert changes code only; it does not roll back external state because this branch performs no deployment, migration or production mutation.

## Evidence boundary

Static contract counts establish method/path registration coverage only. Node tests establish the checked pure functions and source anchors only. HTML parsing establishes document structure only. None of these proves real-device performance, production identity availability, payment readiness, visual approval, deployment safety or runtime backend reachability.
