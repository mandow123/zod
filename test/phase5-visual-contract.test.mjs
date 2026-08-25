import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('C ledger-outline token and explicit ordinary-action whitelist are stable', async () => {
  const theme = await source('src/theme.ts');
  assert.match(theme, /export const ledgerActionButton[\s\S]*?borderWidth:\s*1,[\s\S]*?borderColor:\s*'#AABBD5',[\s\S]*?backgroundColor:\s*'transparent',[\s\S]*?borderRadius:\s*12/u);
  for (const path of [
    'src/components.tsx', 'src/screens/HomeScreen.tsx', 'src/screens/MarketScreen.tsx',
    'src/screens/CreditScreen.tsx', 'src/screens/UnifiedAssetsScreen.tsx',
    'src/screens/ProviderWorkspaceScreen.tsx', 'src/screens/ProviderResourcesScreen.tsx',
    'src/screens/MessagesScreen.tsx', 'src/screens/PublishScreen.tsx',
    'src/InquiryComposerSheet.tsx', 'src/CreditWalletSheet.tsx', 'src/QixiangTopupPanel.tsx',
  ]) assert.match(await source(path), /ledgerActionButton/u, `${path} must use the selected C token`);
  const components = await source('src/components.tsx');
  assert.match(components, /iconButton:[\s\S]*?\.\.\.ledgerActionButton/u);
  assert.match(components, /navItem: \{ flex: 1, alignItems: 'center'/u);
  assert.doesNotMatch(components, /navItem:[\s\S]*?ledgerActionButton/u);
});

test('resolved C/G1/F1 decisions are recorded without overstating APK evidence', async () => {
  const record = await source('docs/visual-decisions/ZOD_PHASE5_SELECTED_VISUALS_20260825.md');
  assert.match(record, /ZOD-PHASE5-APP-BUTTONS-20260825[\s\S]*?C — ledger outline/u);
  assert.match(record, /ZOD-PHASE5-GAME-CONTROLS-20260825[\s\S]*?G1/u);
  assert.match(record, /ZOD-PHASE5-FILING-ICON-20260825[\s\S]*?F1/u);
  assert.match(record, /not an APK/u);
  assert.match(record, /must not be[\s\S]*?reported as an APK-extracted icon hash/u);
});

test('F1 icon source hash remains fixed and selected G1 source remains untouched', async () => {
  const icon = await readFile(new URL('../assets/icon.png', import.meta.url));
  assert.equal(createHash('sha256').update(icon).digest('hex'), '179be7fc660ea246266f226b13efaf30e2461fb154ae74c0b23d8b3e27b7dfb0');
  const game = await source('game/docs/CLOUDPAY_BILLING.md');
  assert.match(game, /CloudPay billing is disabled|disabled/iu);
});
