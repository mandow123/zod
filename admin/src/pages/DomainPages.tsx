import { useCallback } from 'react';
import { adminApi } from '../api/client';
import type { ComputeOrder, DeviceOrder, ListQuery, Page, Payout, Topup } from '../api/contracts';
import { formatDateTime, StatusBadge } from '../components/States';
import { ListPage, type Column } from './ListPage';

const identity = <T extends { id: string }>(item: T) => item.id;

const computeColumns: readonly Column<ComputeOrder>[] = [
  { key: 'number', label: '订单编号', render: (item) => <strong className="mono">{item.orderNumber}</strong> },
  { key: 'status', label: '状态', render: (item) => <StatusBadge status={item.status}/> },
  { key: 'quantity', label: '数量', render: (item) => `${item.quantity} ${item.capacityUnit}`.trim(), numeric: true },
  { key: 'credit', label: '总卡时（微）', render: (item) => <strong className="mono">{item.totalCreditMicros}</strong>, numeric: true },
  { key: 'created', label: '创建时间', render: (item) => <time>{formatDateTime(item.createdAt)}</time> },
  { key: 'updated', label: '更新时间', render: (item) => <time>{formatDateTime(item.updatedAt)}</time> },
];

const deviceColumns: readonly Column<DeviceOrder>[] = [
  { key: 'number', label: '订单编号', render: (item) => <strong className="mono">{item.orderNumber}</strong> },
  { key: 'status', label: '状态', render: (item) => <StatusBadge status={item.status}/> },
  { key: 'quantity', label: '数量', render: (item) => item.quantity, numeric: true },
  { key: 'credit', label: '卡时（微）', render: (item) => <strong className="mono">{item.grossCreditMicros}</strong>, numeric: true },
  { key: 'created', label: '创建时间', render: (item) => <time>{formatDateTime(item.createdAt)}</time> },
  { key: 'updated', label: '更新时间', render: (item) => <time>{formatDateTime(item.updatedAt)}</time> },
];

const payoutColumns: readonly Column<Payout>[] = [
  { key: 'number', label: '提现编号', render: (item) => <strong className="mono">{item.payoutNumber}</strong> },
  { key: 'status', label: '状态', render: (item) => <StatusBadge status={item.status}/> },
  { key: 'credit', label: '卡时（微）', render: (item) => <strong className="mono">{item.creditMicros}</strong>, numeric: true },
  { key: 'payment', label: '付款金额（分）', render: (item) => <strong className="mono">{item.paymentAmountCents}</strong>, numeric: true },
  { key: 'created', label: '创建时间', render: (item) => <time>{formatDateTime(item.createdAt)}</time> },
  { key: 'updated', label: '更新时间', render: (item) => <time>{formatDateTime(item.updatedAt)}</time> },
];

const topupColumns: readonly Column<Topup>[] = [
  { key: 'id', label: '充值编号', render: (item) => <strong className="mono">{item.id}</strong> },
  { key: 'status', label: '状态', render: (item) => <StatusBadge status={item.status}/> },
  { key: 'provider', label: '渠道', render: (item) => item.provider },
  { key: 'amount', label: '充值金额（分）', render: (item) => <strong className="mono">{item.amountCents} {item.currency}</strong>, numeric: true },
  { key: 'credit', label: '到账卡时（微）', render: (item) => <strong className="mono">{item.creditMicros}</strong>, numeric: true },
  { key: 'reversed', label: '冲正', render: (item) => <span className="mono">{item.reversedAmountCents} 分 / {item.reversedCreditMicros} 微</span>, numeric: true },
  { key: 'created', label: '创建时间', render: (item) => <time>{formatDateTime(item.createdAt)}</time> },
  { key: 'updated', label: '更新时间', render: (item) => <time>{formatDateTime(item.updatedAt)}</time> },
];

function useLoader<T>(fn: (query: ListQuery, signal?: AbortSignal) => Promise<Page<T>>) {
  return useCallback((query: ListQuery, signal: AbortSignal) => fn(query, signal), [fn]);
}

export function ComputeOrdersPage() {
  return <ListPage eyebrow="COMPUTE COMMERCE" title="算力订单" description="查看算力订单与履约状态，不包含写操作。" emptyTitle="暂无算力订单" emptyDetail="当前没有可展示的记录。" columns={computeColumns} rowKey={identity} load={useLoader(adminApi.computeOrders)} />;
}

export function DeviceOrdersPage() {
  return <ListPage eyebrow="DEVICE COMMERCE" title="设备订单" description="查看实体设备订单与交付状态。" emptyTitle="暂无设备订单" emptyDetail="当前没有可展示的记录。" columns={deviceColumns} rowKey={identity} load={useLoader(adminApi.deviceOrders)} />;
}

export function PayoutsPage() {
  return <ListPage eyebrow="FINANCE / PAYOUT" title="提现管理" description="只读核对提现请求与资金处理状态。" emptyTitle="暂无提现请求" emptyDetail="当前没有可展示的记录。" columns={payoutColumns} rowKey={identity} load={useLoader(adminApi.payouts)} />;
}

export function TopupsPage() {
  return <ListPage eyebrow="FINANCE / TOPUP" title="充值记录" description="只读核对充值订单、渠道和入账结果。" emptyTitle="暂无充值记录" emptyDetail="当前没有可展示的记录。" columns={topupColumns} rowKey={identity} load={useLoader(adminApi.topups)} />;
}
