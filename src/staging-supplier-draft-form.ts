import type {
  StagingGpuCardType, StagingMachineType, StagingOperatingSystem, StagingRegionCode,
  StagingSupplierDraft, StagingSupplierDraftPayload,
} from './staging-supplier-drafts-api';

export type SupplierDraftForm = Readonly<{
  clientDraftId: string;
  name: string; gpuModel: string; gpuCardType: '' | StagingGpuCardType;
  gpuCount: string; gpuMemoryGb: string; regionCode: '' | StagingRegionCode; city: string;
  machineType: '' | StagingMachineType; cpuModel: string; cpuCores: string; memoryGb: string;
  storageGb: string; networkMbps: string; operatingSystem: '' | StagingOperatingSystem;
  capacityGpuHours: string; fulfillmentNotes: string;
  deliveryMode: 'none' | 'scheduled_window' | 'preparation_lead_time';
  startsAt: string; endsAt: string; timezone: string; leadTimeHours: string;
  priceAmount: string; ownershipConfirmed: boolean; remoteAccessSafetyAcknowledged: boolean;
}>;

export type SupplierDraftFieldErrors = Readonly<Record<string, string>>;

const sensitivePattern = /(?:password|passphrase|private\s*key|token|ssh|身份证|银行卡|手机号|密码|口令|私钥|密钥|精确机房|(?:^|\D)(?:\d{1,3}\.){3}\d{1,3}(?:\D|$)|(?:^|\D)port\s*[:=]?\s*\d+|端口\s*[:：]?\s*\d+)/iu;
const bannedCopyPattern = new RegExp([
  [0x6f14, 0x793a], [0x5c55, 0x793a], [0x671f, 0x8d27], [0x4ea4, 0x6613],
].map((points) => String.fromCodePoint(...points)).join('|'), 'u');

export function emptySupplierDraftForm(clientDraftId: string, timezone: string): SupplierDraftForm {
  const now = new Date();
  const startsAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 24 * 60 * 60 * 1000);
  return {
    clientDraftId, name: '', gpuModel: '', gpuCardType: '', gpuCount: '', gpuMemoryGb: '', regionCode: '', city: '',
    machineType: '', cpuModel: '', cpuCores: '', memoryGb: '', storageGb: '', networkMbps: '', operatingSystem: '',
    capacityGpuHours: '', fulfillmentNotes: '', deliveryMode: 'none', startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(), timezone, leadTimeHours: '', priceAmount: '', ownershipConfirmed: false,
    remoteAccessSafetyAcknowledged: false,
  };
}

export function supplierDraftToForm(draft: StagingSupplierDraft): SupplierDraftForm {
  const plan = draft.deliveryPlan;
  return {
    clientDraftId: draft.clientDraftId,
    name: draft.resource.name ?? '', gpuModel: draft.resource.gpuModel ?? '', gpuCardType: draft.resource.gpuCardType ?? '',
    gpuCount: numberText(draft.resource.gpuCount), gpuMemoryGb: numberText(draft.resource.gpuMemoryGb),
    regionCode: draft.resource.regionCode ?? '', city: draft.resource.city ?? '', machineType: draft.resource.machineType ?? '',
    cpuModel: draft.resource.cpuModel ?? '', cpuCores: numberText(draft.resource.cpuCores),
    memoryGb: numberText(draft.resource.memoryGb), storageGb: numberText(draft.resource.storageGb),
    networkMbps: numberText(draft.resource.networkMbps), operatingSystem: draft.resource.operatingSystem ?? '',
    capacityGpuHours: draft.resource.capacityGpuHours ?? '', fulfillmentNotes: draft.resource.fulfillmentNotes ?? '',
    deliveryMode: plan?.mode ?? 'none',
    startsAt: plan?.mode === 'scheduled_window' ? plan.startsAt : new Date(Date.now() + 86400000).toISOString(),
    endsAt: plan?.mode === 'scheduled_window' ? plan.endsAt : new Date(Date.now() + 172800000).toISOString(),
    timezone: plan?.mode === 'scheduled_window' ? plan.timezone : systemTimeZone(),
    leadTimeHours: plan?.mode === 'preparation_lead_time' ? String(plan.leadTimeHours) : '',
    priceAmount: draft.pricing.amount ?? '', ownershipConfirmed: draft.acknowledgements.ownershipConfirmed,
    remoteAccessSafetyAcknowledged: draft.acknowledgements.remoteAccessSafetyAcknowledged,
  };
}

export function validateSupplierDraftForm(form: SupplierDraftForm): SupplierDraftFieldErrors {
  const errors: Record<string, string> = {};
  validateText(errors, 'name', form.name, 80);
  validateText(errors, 'gpuModel', form.gpuModel, 80);
  validateText(errors, 'city', form.city, 40);
  validateText(errors, 'cpuModel', form.cpuModel, 120);
  validateText(errors, 'fulfillmentNotes', form.fulfillmentNotes, 500);
  validateInteger(errors, 'gpuCount', form.gpuCount, 1, 1024);
  validateInteger(errors, 'gpuMemoryGb', form.gpuMemoryGb, 1, 2048);
  validateInteger(errors, 'cpuCores', form.cpuCores, 1, 1024);
  validateInteger(errors, 'memoryGb', form.memoryGb, 1, 65536);
  validateInteger(errors, 'storageGb', form.storageGb, 1, 1000000);
  validateInteger(errors, 'networkMbps', form.networkMbps, 1, 1000000);
  validateCredit(errors, 'capacityGpuHours', form.capacityGpuHours, 'GPU 时容量');
  validateCredit(errors, 'priceAmount', form.priceAmount, '拟定卡时价');
  if (form.deliveryMode === 'scheduled_window') {
    if (!validTimeZone(form.timezone)) errors.timezone = '请选择有效的 IANA 时区。';
    const start = new Date(form.startsAt).getTime(); const end = new Date(form.endsAt).getTime();
    if (!Number.isFinite(start)) errors.startsAt = '请选择开始日期和时间。';
    if (!Number.isFinite(end) || end <= start) errors.endsAt = '结束时间必须晚于开始时间。';
  }
  if (form.deliveryMode === 'preparation_lead_time') {
    validateInteger(errors, 'leadTimeHours', form.leadTimeHours, 1, 2160);
  }
  return errors;
}

export function supplierDraftPayload(form: SupplierDraftForm): StagingSupplierDraftPayload {
  const errors = validateSupplierDraftForm(form);
  if (Object.keys(errors).length) throw new Error('草稿字段仍有错误，请按字段提示修改。');
  return {
    clientDraftId: form.clientDraftId,
    resource: {
      name: textOrNull(form.name), gpuModel: textOrNull(form.gpuModel), gpuCardType: form.gpuCardType || null,
      gpuCount: integerOrNull(form.gpuCount), gpuMemoryGb: integerOrNull(form.gpuMemoryGb),
      regionCode: form.regionCode || null, city: textOrNull(form.city), machineType: form.machineType || null,
      cpuModel: textOrNull(form.cpuModel), cpuCores: integerOrNull(form.cpuCores), memoryGb: integerOrNull(form.memoryGb),
      storageGb: integerOrNull(form.storageGb), networkMbps: integerOrNull(form.networkMbps),
      operatingSystem: form.operatingSystem || null, capacityGpuHours: creditOrNull(form.capacityGpuHours),
      fulfillmentNotes: textOrNull(form.fulfillmentNotes),
    },
    deliveryPlan: form.deliveryMode === 'scheduled_window'
      ? { mode: 'scheduled_window', startsAt: form.startsAt, endsAt: form.endsAt, timezone: form.timezone, leadTimeHours: null }
      : form.deliveryMode === 'preparation_lead_time'
        ? { mode: 'preparation_lead_time', startsAt: null, endsAt: null, timezone: null,
          leadTimeHours: Number(form.leadTimeHours) }
        : null,
    pricing: { unit: 'KAI_CARD_HOUR_PER_GPU_HOUR', amount: creditOrNull(form.priceAmount) },
    acknowledgements: { ownershipConfirmed: form.ownershipConfirmed,
      remoteAccessSafetyAcknowledged: form.remoteAccessSafetyAcknowledged },
  };
}

export function systemTimeZone() {
  const value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return value && validTimeZone(value) ? value : 'Asia/Shanghai';
}

export function validTimeZone(value: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
}

export function formatSupplierDateTime(value: string, timezone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || !validTimeZone(timezone)) return '待选择';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

function numberText(value: number | null) { return value === null ? '' : String(value); }
function textOrNull(value: string) { const normalized = value.trim(); return normalized || null; }
function integerOrNull(value: string) { return value.trim() ? Number(value) : null; }
function creditOrNull(value: string) {
  if (!value.trim()) return null;
  const [major, minor = ''] = value.trim().split('.');
  return `${major}.${minor.padEnd(2, '0')}`;
}

function validateText(errors: Record<string, string>, field: string, value: string, max: number) {
  const normalized = value.trim();
  if (!normalized) return;
  if (normalized.length > max) errors[field] = `最多填写 ${max} 个字符。`;
  else if (bannedCopyPattern.test(normalized)) errors[field] = '请使用测试资源与履约和消耗相关表述。';
  else if (sensitivePattern.test(normalized)) errors[field] = '禁止填写密码、密钥、连接资料或个人敏感信息。';
}
function validateInteger(errors: Record<string, string>, field: string, value: string, min: number, max: number) {
  if (!value.trim()) return;
  if (!/^\d+$/u.test(value.trim()) || Number(value) < min || Number(value) > max) {
    errors[field] = `请输入 ${min}–${max} 的整数。`;
  }
}
function validateCredit(errors: Record<string, string>, field: string, value: string, label: string) {
  if (!value.trim()) return;
  if (!/^\d+(?:\.\d{1,2})?$/u.test(value.trim()) || Number(value) <= 0 || Number(value) > 1000000000) {
    errors[field] = `${label}必须为正数，最多两位小数。`;
  }
}
