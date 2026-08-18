export type InquiryValidationInput = Readonly<{
  startsAt: string;
  endsAt: string;
  confirmBy: string;
  timeZone: string;
  gpuCount: number;
  description: string;
  storageGiB: number;
  dataRegion: string;
  maxCreditAmount: string;
}>;

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const CREDIT_AMOUNT = /^(?:0|[1-9]\d*)\.\d{2}$/u;

export const COMMON_TIME_ZONES = [
  ['Asia/Shanghai', '上海'], ['Asia/Hong_Kong', '香港'], ['Asia/Singapore', '新加坡'],
  ['Asia/Tokyo', '东京'], ['Asia/Seoul', '首尔'], ['Asia/Dubai', '迪拜'],
  ['Europe/London', '伦敦'], ['Europe/Frankfurt', '法兰克福'], ['Europe/Paris', '巴黎'],
  ['America/Los_Angeles', '洛杉矶'], ['America/Denver', '丹佛'], ['America/Chicago', '芝加哥'],
  ['America/New_York', '纽约'], ['America/Toronto', '多伦多'], ['America/Sao_Paulo', '圣保罗'],
  ['Australia/Sydney', '悉尼'], ['Pacific/Auckland', '奥克兰'], ['UTC', '协调世界时'],
] as const;

export function validTimeZone(value: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; }
  catch { return false; }
}

export function systemTimeZone() {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return resolved && validTimeZone(resolved) ? resolved : 'Asia/Shanghai';
}

export function initialInquirySchedule(now = Date.now()) {
  const startsAt = new Date(now + 24 * 60 * 60 * 1000);
  startsAt.setMinutes(0, 0, 0);
  const endsAt = new Date(startsAt.getTime() + 8 * 60 * 60 * 1000);
  const confirmBy = new Date(startsAt.getTime() - 12 * 60 * 60 * 1000);
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), confirmBy: confirmBy.toISOString() };
}

export function formatZonedDateTime(value: string, timeZone: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || !validTimeZone(timeZone)) return { date: '待选择', time: '--:--' };
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(parsed);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

export function validateInquiryInput(input: InquiryValidationInput, now = Date.now()) {
  if (!Number.isInteger(input.gpuCount) || input.gpuCount < 1 || input.gpuCount > 100_000) return 'GPU 数量需为 1 至 100000 的整数。';
  if (!validTimeZone(input.timeZone)) return '请填写有效的 IANA 时区，例如 Asia/Shanghai。';
  if (![input.startsAt, input.endsAt, input.confirmBy].every((value) => ISO_WITH_ZONE.test(value))) return '请填写包含时区的完整日期时间。';
  const startsAt = Date.parse(input.startsAt);
  const endsAt = Date.parse(input.endsAt);
  const confirmBy = Date.parse(input.confirmBy);
  if (![startsAt, endsAt, confirmBy].every(Number.isFinite)) return '请填写包含时区的完整日期时间。';
  if (startsAt <= now) return '开始时间必须晚于当前时间。';
  if (startsAt >= endsAt) return '归还时间必须晚于开始时间。';
  if (confirmBy >= startsAt) return '最晚确认时间必须早于开始时间。';
  if (confirmBy < now) return '最晚确认时间不能早于当前时间。';
  const descriptionLength = input.description.trim().length;
  if (descriptionLength < 20 || descriptionLength > 500) return '需求说明需为 20 至 500 字。';
  if (!Number.isInteger(input.storageGiB) || input.storageGiB < 1 || input.storageGiB > 10_000_000) return '存储容量需为 1 至 10000000 的整数 GiB。';
  const dataRegionLength = input.dataRegion.trim().length;
  if (dataRegionLength < 2 || dataRegionLength > 80) return '数据区域需为 2 至 80 字。';
  if (input.maxCreditAmount.length > 40 || !CREDIT_AMOUNT.test(input.maxCreditAmount) || input.maxCreditAmount === '0.00') return '最大可接受卡时需为严格正数并保留两位小数。';
  return null;
}

export function inquiryCardTypeLabel(cardType: string) {
  return /(?:^|\s)(?:SXM\d*|PCIe)(?:$|\s)/iu.test(cardType.trim()) ? cardType.trim() : '卡型待确认';
}
