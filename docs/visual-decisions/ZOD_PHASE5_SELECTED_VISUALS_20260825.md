# Phase 5 selected visual implementation record (2026-08-25)

This record binds the approved Phase 5 choices to the local CloudPay source
integration candidate. It is not an APK, a release declaration, or evidence
extracted from a signed package.

## Operator decisions

| Decision ID | Selected option | Implementation boundary |
| --- | --- | --- |
| `ZOD-PHASE5-APP-BUTTONS-20260825` | C — ledger outline | Ordinary mobile action buttons only; no navigation, payment, inquiry, wallet, or order behavior changes. |
| `ZOD-PHASE5-GAME-CONTROLS-20260825` | G1 — App-aligned / precise dark controls | Existing `game/**` implementation remains the selected evidence and is not redrawn in this repair. |
| `ZOD-PHASE5-FILING-ICON-20260825` | F1 — existing cyan KAI wordmark | `assets/icon.png` remains source evidence only; its SHA-256 is `179be7fc660ea246266f226b13efaf30e2461fb154ae74c0b23d8b3e27b7dfb0`. |

## C implementation contract

`src/theme.ts` exports `ledgerActionButton` with exactly `borderWidth: 1`,
`borderColor: '#AABBD5'`, `backgroundColor: 'transparent'`, and
`borderRadius: 12`. `ledgerActionText` preserves a legible primary-color
label. The token is intentionally applied to this explicit action whitelist:

- `BrandHeader.iconButton`
- Home Spark detail action; Market empty-state action; Credit and unified-assets actions
- Provider workspace and resources login/retry actions; Messages login action
- Publish retry/continue actions
- Inquiry submit; card-hour wallet actions; Qixiang H5 payment actions

Bottom navigation, cards, status pills, badges, chips, radio controls, and
danger/success state semantics are outside this token. Disabled and loading
states keep their existing opacity and busy behavior; only their action-shell
geometry changes.

## Protected evidence boundary

This repair does not change `game/**`, `assets/icon.png`, K/A/I mascot assets,
backend code, migrations, payment behavior, inquiry behavior, wallet behavior,
or the selected G1/F1 source bytes. The existing F1 file hash must not be
reported as an APK-extracted icon hash until a formal signed APK exists.
