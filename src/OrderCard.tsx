import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { CloudPayOrder } from './api';
import { Card } from './components';
import { colors } from './theme';
import { creditAmount } from './format';

const statusCopy: Record<CloudPayOrder['status'], { label: string; color: string; background: string }> = {
  reserved: { label: '已锁定', color: colors.amber, background: colors.primarySoft },
  confirmed: { label: '已确认', color: colors.green, background: colors.greenSoft },
  provisioning: { label: '开通中', color: '#2563A7', background: '#EAF3FF' },
  ready: { label: '可连接', color: '#2563A7', background: '#EAF3FF' },
  in_service: { label: '使用中', color: colors.green, background: colors.greenSoft },
  acceptance_pending: { label: '待验收', color: colors.amber, background: colors.primarySoft },
  disputed: { label: '处理中', color: colors.red, background: '#FDECEC' },
  accepted: { label: '已验收', color: colors.green, background: colors.greenSoft },
  release_pending: { label: '待释放', color: colors.amber, background: colors.primarySoft },
  refund_pending: { label: '退款中', color: colors.amber, background: colors.primarySoft },
  closed: { label: '已完成', color: colors.muted, background: colors.canvas },
  cancelled: { label: '已取消', color: colors.muted, background: colors.canvas },
  expired: { label: '已失效', color: colors.muted, background: colors.canvas },
  refunded: { label: '已退款', color: colors.green, background: colors.greenSoft },
};

export function OrderCard({ order, onPress, statusLabel }: Readonly<{
  order: CloudPayOrder; onPress: () => void; statusLabel?: string;
}>) {
  const status = { ...statusForOrder(order), ...(statusLabel ? { label: statusLabel } : {}) };
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`查看订单 ${order.orderNumber}`}>
      <Card style={styles.card}>
        <View style={styles.top}>
          <View style={styles.icon}><Ionicons name="hardware-chip-outline" size={23} color={colors.primary} /></View>
          <View style={styles.copy}>
            <Text style={styles.title} numberOfLines={1}>{order.title}</Text>
            <Text style={styles.meta}>{order.productCode ?? '算力资源'} · {order.region ?? '区域待确认'}</Text>
          </View>
          <View style={[styles.status, { backgroundColor: status.background }]}>
            <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
          </View>
        </View>
        <View style={styles.amountRow}>
          <View><Text style={styles.amountLabel}>订单卡时</Text><Text style={styles.amount}>{creditAmount(order.totalCredits)}</Text></View>
          <View style={styles.quantity}><Text style={styles.amountLabel}>数量</Text><Text style={styles.quantityValue}>{trim(order.quantity)} {order.capacityUnit}</Text></View>
        </View>
        <View style={styles.footer}>
          <Text style={styles.number}>{order.orderNumber}</Text>
          <View style={styles.open}><Text style={styles.openText}>{order.actions.length > 0 ? '去处理' : '详情'}</Text><Ionicons name="chevron-forward" size={15} color={colors.primary} /></View>
        </View>
      </Card>
    </Pressable>
  );
}

export function orderStatusLabel(status: CloudPayOrder['status'], side?: CloudPayOrder['side']) {
  if (side === 'provider' && status === 'accepted') return '待结算';
  if (side === 'provider' && status === 'closed') return '已结算';
  return statusCopy[status].label;
}

function statusForOrder(order: CloudPayOrder) {
  if (order.side === 'provider' && order.status === 'accepted') {
    return { ...statusCopy.accepted, label: '待结算' };
  }
  if (order.side === 'provider' && order.status === 'closed') {
    return { ...statusCopy.closed, label: '已结算' };
  }
  return statusCopy[order.status];
}

function trim(value: string) { return value.replace(/\.0+$/u, '').replace(/(\.\d*?)0+$/u, '$1'); }

const styles = StyleSheet.create({
  card: { padding: 15, marginBottom: 11 },
  top: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft },
  copy: { flex: 1, marginLeft: 11 }, title: { color: colors.ink, fontSize: 15, fontWeight: '900' },
  meta: { color: colors.muted, fontSize: 10, marginTop: 4 },
  status: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 999 }, statusText: { fontSize: 9, fontWeight: '900' },
  amountRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 15, paddingTop: 13, borderTopWidth: 1, borderTopColor: colors.line },
  amountLabel: { color: colors.muted, fontSize: 9 }, amount: { color: colors.primaryDark, fontSize: 22, fontWeight: '900', marginTop: 2 },
  quantity: { alignItems: 'flex-end' }, quantityValue: { color: colors.ink, fontSize: 12, fontWeight: '800', marginTop: 4 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 13 },
  number: { color: colors.subtle, fontSize: 9 }, open: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  openText: { color: colors.primary, fontSize: 11, fontWeight: '900' },
});
