import type {
  StagingFulfillmentStatus, StagingOrder, StagingOrderAction, StagingOrderStatus, StagingTopup,
} from './staging-sandbox-api';

export const stagingTopupCopy = Object.freeze({
  processing: { title: '测试支付处理中', action: '重新查询', requiredAction: 'refresh' },
  succeeded: { title: '测试卡时已到账', action: '查看测试余额', requiredAction: 'view_balance' },
  failed: { title: '测试支付失败', action: '重新充值', requiredAction: 'create_new' },
  canceled: { title: '已取消测试支付', action: '重新充值', requiredAction: 'create_new' },
} as const);

export function topupPresentation(topup: StagingTopup) {
  const copy = stagingTopupCopy[topup.status];
  return { ...copy, actionAllowed: topup.allowedActions.includes(copy.requiredAction) };
}

const fulfillmentCopy: Record<StagingFulfillmentStatus, string> = {
  queued: '测试卡时已预留',
  provisioning: '模拟部署中',
  ready: '模拟访问已就绪',
  running: '模拟资源运行中',
  disconnected: '模拟连接中断',
  stopping: '正在停止模拟资源',
  stopped: '待生成模拟计量',
  failed: '模拟部署失败',
};
const orderCopy: Partial<Record<StagingOrderStatus, string>> = {
  acceptance_pending: '待验收',
  accepted: '测试订单已验收',
  refunded: '测试卡时已退回',
  disputed: '争议处理中',
  canceled: '测试订单已取消',
  failed: '模拟部署失败，测试卡时已退回',
};

export function stagingOrderStatus(order: StagingOrder) {
  return orderCopy[order.status] ?? fulfillmentCopy[order.fulfillment.status];
}

const knownActions = new Set<StagingOrderAction>([
  'cancel', 'access_preview', 'request_stop', 'accept', 'open_dispute',
]);
export function stagingOrderActions(order: StagingOrder) {
  return order.allowedActions.filter((action): action is StagingOrderAction => knownActions.has(action));
}

export function cardHourProduct(unitPrice: string, quantity: string) {
  if (!/^\d+\.\d{2}$/u.test(unitPrice) || !/^\d+\.\d{2}$/u.test(quantity)) return null;
  const toMinor = (value: string) => {
    const [major = '0', minor = '0'] = value.split('.');
    return BigInt(major) * 100n + BigInt(minor);
  };
  const product = toMinor(unitPrice) * toMinor(quantity);
  if (product <= 0n || product % 100n !== 0n) return null;
  const result = product / 100n;
  return `${result / 100n}.${(result % 100n).toString().padStart(2, '0')}`;
}

export function normalizeStagingQuantity(input: string) {
  const trimmed = input.trim();
  if (!/^\d{1,12}(?:\.\d{1,2})?$/u.test(trimmed)) return null;
  const [major = '0', minor = ''] = trimmed.split('.');
  const value = BigInt(major) * 100n + BigInt(minor.padEnd(2, '0'));
  if (value <= 0n) return null;
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

function cardHourMinor(value: string) {
  if (!/^\d+\.\d{2}$/u.test(value)) return null;
  const [major = '0', minor = '0'] = value.split('.');
  return BigInt(major) * 100n + BigInt(minor);
}

export type StagingPurchaseGate = Readonly<{
  quantity: string | null;
  total: string | null;
  reason: 'invalid_quantity' | 'invalid_total_precision' | 'capacity_exceeded'
    | 'balance_unavailable' | 'insufficient_balance' | null;
}>;

export function stagingPurchaseGate(input: Readonly<{
  quantityInput: string;
  unitPriceCredits: string;
  capacityAvailable: string;
  availableBalance: string | null;
}>): StagingPurchaseGate {
  const quantity = normalizeStagingQuantity(input.quantityInput);
  if (!quantity) return { quantity: null, total: null, reason: 'invalid_quantity' };
  const total = cardHourProduct(input.unitPriceCredits, quantity);
  if (!total) return { quantity, total: null, reason: 'invalid_total_precision' };
  const capacity = cardHourMinor(input.capacityAvailable);
  const requested = cardHourMinor(quantity);
  if (capacity === null || requested === null || requested > capacity) {
    return { quantity, total, reason: 'capacity_exceeded' };
  }
  if (input.availableBalance === null) return { quantity, total, reason: 'balance_unavailable' };
  const available = cardHourMinor(input.availableBalance);
  const required = cardHourMinor(total);
  if (available === null || required === null || required > available) {
    return { quantity, total, reason: 'insufficient_balance' };
  }
  return { quantity, total, reason: null };
}
