import { API_BASE_URL } from './api-client';

const CLOUDPAY_MARKET_CANDLES_URL = `${API_BASE_URL}/api/market/candles`;

export type CloudPayMarketKind = 'gpu' | 'token' | 'rack' | 'server';
export type CloudPayMarketInterval = '5m' | '15m' | '1h' | '4h' | '1d' | '1w' | '1mo';

export type CloudPayMarketCandle = Readonly<{
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}>;

export type CloudPayMarketOption = Readonly<{ id: string; name: string }>;

export type CloudPayMarketPayload = Readonly<{
  ok: true;
  kind: CloudPayMarketKind;
  product: CloudPayMarketOption & Readonly<{ unit: string }>;
  region: CloudPayMarketOption;
  interval: CloudPayMarketInterval;
  source: string;
  referenceOnly: boolean;
  candles: readonly CloudPayMarketCandle[];
  updatedAt: string;
  notice: string;
  options: Readonly<{
    products: Readonly<Record<CloudPayMarketKind, readonly CloudPayMarketOption[]>>;
    regions: readonly CloudPayMarketOption[];
    intervals: readonly CloudPayMarketInterval[];
  }>;
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效。`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}格式无效。`);
  return value;
}

function finite(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}格式无效。`);
  return value;
}

const kinds = new Set<CloudPayMarketKind>(['gpu', 'token', 'rack', 'server']);
const intervals = new Set<CloudPayMarketInterval>(['5m', '15m', '1h', '4h', '1d', '1w', '1mo']);

function kind(value: unknown): CloudPayMarketKind {
  const parsed = string(value, '行情类型') as CloudPayMarketKind;
  if (!kinds.has(parsed)) throw new Error('行情类型不受支持。');
  return parsed;
}

function interval(value: unknown): CloudPayMarketInterval {
  const parsed = string(value, '行情周期') as CloudPayMarketInterval;
  if (!intervals.has(parsed)) throw new Error('行情周期不受支持。');
  return parsed;
}

function option(value: unknown, label: string): CloudPayMarketOption {
  const item = record(value, label);
  return { id: string(item.id, `${label}编号`), name: string(item.name, `${label}名称`) };
}

function candle(value: unknown, index: number): CloudPayMarketCandle {
  const item = record(value, `第 ${index + 1} 根K线`);
  const parsed = {
    time: finite(item.time, 'K线时间'),
    open: finite(item.open, '开盘价'),
    high: finite(item.high, '最高价'),
    low: finite(item.low, '最低价'),
    close: finite(item.close, '收盘价'),
    volume: finite(item.volume, '成交量'),
  };
  if (parsed.time <= 0 || parsed.low < 0 || parsed.volume < 0 || parsed.low > Math.min(parsed.open, parsed.close)
    || parsed.high < Math.max(parsed.open, parsed.close) || parsed.high < parsed.low) {
    throw new Error(`第 ${index + 1} 根K线数值无效。`);
  }
  return parsed;
}

export function decodeCloudPayMarketPayload(value: unknown): CloudPayMarketPayload {
  const payload = record(value, '行情响应');
  if (payload.ok !== true) throw new Error('CloudPay 行情服务未确认成功。');
  const parsedKind = kind(payload.kind);
  const parsedInterval = interval(payload.interval);
  const productValue = record(payload.product, '产品');
  const candlesValue = payload.candles;
  if (!Array.isArray(candlesValue) || candlesValue.length === 0 || candlesValue.length > 500) {
    throw new Error('CloudPay 行情暂无有效K线。');
  }
  const optionsValue = record(payload.options, '行情选项');
  const productsValue = record(optionsValue.products, '产品选项');
  const productEntries = Object.fromEntries([...kinds].map((item) => {
    const list = productsValue[item];
    if (!Array.isArray(list)) throw new Error('产品选项格式无效。');
    return [item, list.map((entry) => option(entry, '产品选项'))];
  }));
  const products: Record<CloudPayMarketKind, readonly CloudPayMarketOption[]> = {
    gpu: productEntries.gpu, token: productEntries.token, rack: productEntries.rack, server: productEntries.server,
  };
  if (!Array.isArray(optionsValue.regions) || !Array.isArray(optionsValue.intervals)) throw new Error('行情选项格式无效。');
  const allowedIntervals = optionsValue.intervals.map(interval);
  return {
    ok: true,
    kind: parsedKind,
    product: { ...option(productValue, '产品'), unit: string(productValue.unit, '计价单位') },
    region: option(payload.region, '地区'),
    interval: parsedInterval,
    source: string(payload.source, '数据源'),
    referenceOnly: payload.reference_only === true,
    candles: candlesValue.map(candle).sort((left, right) => left.time - right.time),
    updatedAt: string(payload.updated_at, '更新时间'),
    notice: string(payload.notice, '行情说明'),
    options: {
      products,
      regions: optionsValue.regions.map((entry) => option(entry, '地区选项')),
      intervals: allowedIntervals,
    },
  };
}

export async function loadCloudPayMarketCandles(input: Readonly<{
  kind?: CloudPayMarketKind;
  product?: string;
  region?: string;
  interval?: CloudPayMarketInterval;
  signal?: AbortSignal;
}> = {}) {
  const params = new URLSearchParams({
    kind: input.kind ?? 'gpu',
    region: input.region ?? 'shanghai',
    interval: input.interval ?? '1d',
    limit: '120',
  });
  if (input.product) params.set('product', input.product);
  const response = await fetch(`${CLOUDPAY_MARKET_CANDLES_URL}?${params.toString()}`, {
    method: 'GET', headers: { Accept: 'application/json' }, signal: input.signal,
  });
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error('CloudPay 行情响应不是有效数据。'); }
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body
      ? (body as { error?: { message?: unknown } }).error?.message : null;
    throw new Error(typeof message === 'string' && message ? message : `CloudPay 行情读取失败（${response.status}）。`);
  }
  return decodeCloudPayMarketPayload(body);
}
