import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IMPORT_SCHEMA_VERSION = 'supplier-catalog-v1';
const expectedHeaders = [
  '序号', '公司名称', '企业性质', '机房所在地', '可提供GPU型号',
  'H100单卡时租(元)', 'H100单卡包月(元)', 'H200单卡时租(元)', 'H200单卡包月(元)',
  'B300单卡时租(元)', 'B300单卡包月(元)', '合约要求', '网络配置', '现货状态', 'SLA', '备注',
] as const;

export type ImportModel = 'H100' | 'H200' | 'B300';
export type ImportMode = 'hourly' | 'monthly';

export type SupplierWorkbookRow = Readonly<{
  sourceRow: number;
  values: readonly unknown[];
}>;

export type ParsedSupplierLead = Readonly<{
  sourceRow: number;
  supplierName: string;
  privatePayload: Readonly<Record<string, string | number | null>>;
  candidates: readonly Readonly<{
    model: ImportModel;
    cardType: string;
    wideRegion: string;
    modes: readonly ImportMode[];
    sourceObservedAt: string;
  }>[];
  h200Unconfirmed: null | Readonly<{ hourlyQuotePresent: boolean; monthlyQuotePresent: boolean }>;
}>;

export type SupplierImportIssue = Readonly<{
  sourceRow: number;
  sourceColumn: string;
  code: 'ROW_REQUIRED_FIELD_MISSING' | 'ROW_MODEL_INVALID' | 'MODEL_WITHOUT_MODE' | 'H200_QUOTE_WITHOUT_MODEL';
  severity: 'error' | 'warning';
}>;

export type SupplierImportPreflight = Readonly<{
  schemaVersion: typeof IMPORT_SCHEMA_VERSION;
  sourceDigest: string;
  sourceSizeBytes: number;
  sourceObservedAt: string;
  leads: readonly ParsedSupplierLead[];
  issues: readonly SupplierImportIssue[];
  counts: Readonly<{
    leads: number;
    candidates: number;
    candidatesByModel: Readonly<Record<ImportModel, number>>;
    h200UnconfirmedLeads: number;
    sourceWarnings: number;
  }>;
}>;

function xmlDecode(value: string) {
  return value.replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>').replace(/&amp;/gu, '&');
}

function textNodes(xml: string) {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)].map((match) => xmlDecode(match[1] ?? '')).join('');
}

function parseSharedStrings(xml: string) {
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gu)].map((match) => textNodes(match[1] ?? ''));
}

function columnNumber(reference: string) {
  const letters = reference.match(/^[A-Z]+/u)?.[0];
  if (!letters) return null;
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

function parseWorksheet(xml: string, shared: readonly string[]): SupplierWorkbookRow[] {
  const rows: SupplierWorkbookRow[] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/gu)) {
    const sourceRow = Number(rowMatch[1]);
    const values: unknown[] = [];
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gu)) {
      const attributes = cellMatch[1] ?? '';
      const reference = attributes.match(/\br="([A-Z]+\d+)"/u)?.[1];
      const column = reference ? columnNumber(reference) : null;
      if (!column) continue;
      const body = cellMatch[2] ?? '';
      const raw = body.match(/<v>([\s\S]*?)<\/v>/u)?.[1];
      const type = attributes.match(/\bt="([^"]+)"/u)?.[1];
      if (type === 's' && raw !== undefined) values[column - 1] = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') values[column - 1] = textNodes(body);
      else if (raw !== undefined) values[column - 1] = /^-?\d+(?:\.\d+)?$/u.test(raw) ? Number(raw) : xmlDecode(raw);
    }
    rows.push({ sourceRow, values });
  }
  return rows;
}

async function unzipEntry(filePath: string, entry: string) {
  const { stdout } = await execFileAsync('/usr/bin/unzip', ['-p', filePath, entry], {
    encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function cell(row: SupplierWorkbookRow, index: number) {
  const value = row.values[index];
  return value === null || value === undefined ? '' : String(value).normalize('NFKC').trim();
}

function modes(row: SupplierWorkbookRow, model: ImportModel): ImportMode[] {
  const columns: Record<ImportModel, readonly [number, number]> = { H100: [5, 6], H200: [7, 8], B300: [9, 10] };
  const [hourly, monthly] = columns[model];
  return [cell(row, hourly) ? 'hourly' as const : null, cell(row, monthly) ? 'monthly' as const : null]
    .filter((value): value is ImportMode => value !== null);
}

function wideRegion(input: string) {
  const value = input.normalize('NFKC');
  if (value.includes('全球')) return '全球·多区域';
  if (/(?:美欧|美国.*欧洲|欧洲.*美国)/u.test(value)) return '海外·多区域';
  if (/(美国|加拿大)/u.test(value)) return '海外·北美';
  if (/(英国|法国|德国|瑞士|荷兰|奥地利|卢森堡|北欧)/u.test(value)) return '海外·欧洲';
  if (/(新加坡|香港)/u.test(value)) return '亚太';
  const groups = [
    ['中国大陆·华东', /(上海|山东|江苏|浙江|福建|江西|苏州|杭州|青岛|厦门)/u],
    ['中国大陆·华北', /(北京|天津|河北|山西|内蒙古|乌兰察布|张家口|廊坊|唐山|呼和浩特|太原)/u],
    ['中国大陆·华南', /(广东|广西|海南|深圳|广州|东莞|佛山|中山|珠海|惠州|清远|南宁|海口|三亚)/u],
    ['中国大陆·华中', /(河南|湖北|湖南|郑州|武汉|长沙)/u],
    ['中国大陆·西南', /(四川|重庆|贵州|云南|成都|贵阳|昆明|贵安)/u],
    ['中国大陆·西北', /(陕西|甘肃|青海|宁夏|新疆|西安|兰州|中卫)/u],
    ['中国大陆·东北', /(辽宁|吉林|黑龙江|沈阳)/u],
  ] as const;
  const matched = groups.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
  return matched.length === 1 ? matched[0]! : matched.length > 1 ? '中国大陆·多区域' : '宽地区·待确认';
}

function verifiedAtFrom(rows: readonly SupplierWorkbookRow[]) {
  const description = cell(rows.find((row) => row.sourceRow === 2) ?? { sourceRow: 2, values: [] }, 0);
  const date = description.match(/(20\d{2})-(\d{2})-(\d{2})/u);
  if (!date) return null;
  const [, year, month, day] = date;
  return new Date(`${year}-${month}-${day}T00:00:00+08:00`).toISOString();
}

export function preflightSupplierRows(
  rows: readonly SupplierWorkbookRow[],
  source: Readonly<{ digest: string; sizeBytes: number }>,
): SupplierImportPreflight {
  const header = rows.find((row) => row.sourceRow === 3);
  if (!header || expectedHeaders.some((expected, index) => cell(header, index) !== expected)) {
    throw new Error('SUPPLIER_IMPORT_SCHEMA_UNSUPPORTED');
  }
  const sourceObservedAt = verifiedAtFrom(rows);
  if (!sourceObservedAt) throw new Error('SUPPLIER_IMPORT_SOURCE_DATE_MISSING');
  const issues: SupplierImportIssue[] = [];
  const leads: ParsedSupplierLead[] = [];
  for (const row of rows.filter((candidate) => candidate.sourceRow >= 4 && candidate.values.some((value) => value !== undefined && value !== null && value !== ''))) {
    const supplierName = cell(row, 1); const exactRegion = cell(row, 3); const gpuDescription = cell(row, 4).toUpperCase();
    if (!supplierName || !exactRegion || !gpuDescription) {
      issues.push({ sourceRow: row.sourceRow, sourceColumn: !supplierName ? 'B' : !exactRegion ? 'D' : 'E', code: 'ROW_REQUIRED_FIELD_MISSING', severity: 'error' });
      continue;
    }
    const explicitModels = (['H100', 'H200', 'B300'] as const).filter((model) => gpuDescription.includes(model));
    if (explicitModels.length === 0) {
      issues.push({ sourceRow: row.sourceRow, sourceColumn: 'E', code: 'ROW_MODEL_INVALID', severity: 'error' });
      continue;
    }
    const candidates: ParsedSupplierLead['candidates'][number][] = [];
    for (const model of explicitModels) {
      const supportedModes = modes(row, model);
      if (supportedModes.length === 0) {
        issues.push({ sourceRow: row.sourceRow, sourceColumn: 'E', code: 'MODEL_WITHOUT_MODE', severity: 'error' });
        continue;
      }
      const explicitCardType = gpuDescription.match(new RegExp(`${model}\\s+(PCIE|SXM)`, 'u'))?.[1];
      const cardType = explicitCardType === 'PCIE' ? 'PCIe' : explicitCardType === 'SXM' ? 'SXM' : '卡型待确认';
      candidates.push({ model, cardType, wideRegion: wideRegion(exactRegion), modes: supportedModes, sourceObservedAt });
    }
    const h200Hourly = Boolean(cell(row, 7)); const h200Monthly = Boolean(cell(row, 8));
    const h200Unconfirmed = !explicitModels.includes('H200') && (h200Hourly || h200Monthly)
      ? { hourlyQuotePresent: h200Hourly, monthlyQuotePresent: h200Monthly } : null;
    if (h200Unconfirmed) {
      if (h200Hourly) issues.push({ sourceRow: row.sourceRow, sourceColumn: 'H', code: 'H200_QUOTE_WITHOUT_MODEL', severity: 'warning' });
      if (h200Monthly) issues.push({ sourceRow: row.sourceRow, sourceColumn: 'I', code: 'H200_QUOTE_WITHOUT_MODEL', severity: 'warning' });
    }
    leads.push({ sourceRow: row.sourceRow, supplierName,
      privatePayload: {
        companyName: supplierName, enterpriseNature: cell(row, 2), exactRegion, gpuDescription: cell(row, 4),
        h100HourlyQuote: cell(row, 5) || null, h100MonthlyQuote: cell(row, 6) || null,
        h200HourlyQuote: cell(row, 7) || null, h200MonthlyQuote: cell(row, 8) || null,
        b300HourlyQuote: cell(row, 9) || null, b300MonthlyQuote: cell(row, 10) || null,
        contractRequirement: cell(row, 11), networkConfiguration: cell(row, 12),
        sourceAvailabilityClaim: cell(row, 13), sla: cell(row, 14), notes: cell(row, 15),
      }, candidates, h200Unconfirmed });
  }
  const candidates = leads.flatMap((lead) => lead.candidates);
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  return { schemaVersion: IMPORT_SCHEMA_VERSION, sourceDigest: source.digest, sourceSizeBytes: source.sizeBytes,
    sourceObservedAt, leads, issues,
    counts: { leads: leads.length, candidates: candidates.length,
      candidatesByModel: { H100: candidates.filter((item) => item.model === 'H100').length,
        H200: candidates.filter((item) => item.model === 'H200').length,
        B300: candidates.filter((item) => item.model === 'B300').length },
      h200UnconfirmedLeads: leads.filter((lead) => lead.h200Unconfirmed !== null).length,
      sourceWarnings: warnings.length } };
}

export async function readSupplierWorkbook(filePath: string) {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 10 * 1024 * 1024) throw new Error('SUPPLIER_IMPORT_FILE_INVALID');
  const bytes = await readFile(filePath);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const [sharedXml, sheetXml] = await Promise.all([
    unzipEntry(filePath, 'xl/sharedStrings.xml'), unzipEntry(filePath, 'xl/worksheets/sheet1.xml'),
  ]);
  return preflightSupplierRows(parseWorksheet(sheetXml, parseSharedStrings(sharedXml)), { digest, sizeBytes: metadata.size });
}

export function assertExpectedSupplierImport(preflight: SupplierImportPreflight) {
  const errors = preflight.issues.filter((issue) => issue.severity === 'error');
  const expected = preflight.counts.leads === 100 && preflight.counts.candidates === 120
    && preflight.counts.candidatesByModel.H100 === 100 && preflight.counts.candidatesByModel.H200 === 16
    && preflight.counts.candidatesByModel.B300 === 4 && preflight.counts.h200UnconfirmedLeads === 84
    && preflight.counts.sourceWarnings === 168;
  if (errors.length || !expected) throw new Error('SUPPLIER_IMPORT_EXPECTATION_MISMATCH');
  return preflight;
}
