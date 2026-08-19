import type { OfferRevisionDraft, OfferWizardDraft, OfferWizardStep } from './publishing';

export type EditableOfferDraft = OfferWizardDraft | OfferRevisionDraft;
export type OfferSaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';

export const offerConflictCopy = Object.freeze({
  alertTitle: '这份方案已更新',
  alertBody: '当前页面的内容不会自动覆盖最新版本。你可以重新读取，或者直接退出。',
  stayLabel: '继续留在此页',
  exitLabel: '退出不覆盖',
  reloadLabel: '重新读取',
});

export function isRevisionDraft(value: EditableOfferDraft): value is OfferRevisionDraft {
  return 'offerId' in value && typeof value.offerId === 'string';
}

export function shouldPromptOfferConflictResolution(saveState: OfferSaveState) {
  return saveState === 'conflict';
}

export function discardOfferConflict(discardLocal: () => void, close: () => void) {
  discardLocal();
  close();
}

export async function reloadLatestOfferAfterConflict({
  current,
  discardLocal,
  loadDraft,
  loadRevision,
  hydrate,
}: Readonly<{
  current: EditableOfferDraft;
  discardLocal: () => void;
  loadDraft: (draftId: string) => Promise<OfferWizardDraft>;
  loadRevision: (offerId: string) => Promise<OfferRevisionDraft>;
  hydrate: (draft: EditableOfferDraft) => void;
}>) {
  discardLocal();
  const latest = isRevisionDraft(current)
    ? await loadRevision(current.offerId)
    : await loadDraft(current.id);
  hydrate(latest);
  return latest;
}

export type OfferWizardFormValues = Readonly<{
  title: string;
  minimumQuantity: string;
  availability: string;
  delivery: string;
  acceptance: string;
  refund: string;
  cleanup: string;
  suggestedUnitCredits: string;
  priceComponents: string;
  evidenceSource: string;
  evidenceSummary: string;
}>;

export function shouldClearFormErrorOnEdit(saveState: OfferSaveState) {
  return saveState !== 'error' && saveState !== 'conflict';
}

type DraftPriceEvidence = Readonly<{
  type: 'contract' | 'invoice' | 'market_quote' | 'cost_breakdown';
  source: string;
  summary: string;
  digest?: string;
}>;

export function draftPriceEvidence(
  type: DraftPriceEvidence['type'],
  source: string,
  summary: string,
  previous?: DraftPriceEvidence,
) {
  return [{
    ...(previous?.digest ? { digest: previous.digest } : {}),
    type,
    source: source.trim(),
    summary: summary.trim(),
  }];
}

export function normalizeCreditInput(input: string) {
  const clean = input.replace(/[^0-9.]/gu, '');
  const dot = clean.indexOf('.');
  if (dot < 0) return clean.slice(0, 9);
  const integer = (clean.slice(0, dot) || '0').slice(0, 9);
  // Keep one extra digit so validation can reject it instead of silently truncating money.
  const decimals = clean.slice(dot + 1).replace(/\./gu, '').slice(0, 3);
  return `${integer}.${decimals}`;
}

export function validateOfferWizardStep(step: OfferWizardStep, form: OfferWizardFormValues) {
  if (step === 'service' && (form.title.trim().length < 2 || Number(form.minimumQuantity) <= 0)) {
    return '请填写服务名称与最小起售量。';
  }
  if (step === 'terms' && [form.availability, form.delivery, form.acceptance, form.refund, form.cleanup]
    .some((value) => value.trim().length < 2)) {
    return '请完整定义保障、交付、验收、退款和数据清理边界。';
  }
  const validCredits = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/u.test(form.suggestedUnitCredits)
    && Number(form.suggestedUnitCredits) > 0;
  if (step === 'price' && (!validCredits || form.priceComponents.trim().length < 4
    || form.evidenceSource.trim().length < 2 || form.evidenceSummary.trim().length < 4)) {
    return '请填写卡时单价（最多两位小数）、价格构成和一条可核验凭证。';
  }
  return null;
}

export function commonDeliveryTerms(productCode: string) {
  const product = productCode.trim() || '资料已核验资源';
  return {
    availability: '平台确认有空闲 GPU 后才锁定订单；开通未完成不计费',
    delivery: '付款后自动开通；5 分钟内未完成健康检查与连接准备则全额退回',
    acceptance: `以 ${product} 型号、单卡独享、已核验配置、节点健康检查和计量记录为准`,
    refund: '开通失败全额退回；使用中按实际有效 GPU 分钟结算，未使用部分退回',
    cleanup: '租约停止后立即撤销连接凭据，48 小时内清理工作数据并保留清理记录',
  } as const;
}
