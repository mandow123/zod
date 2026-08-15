import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CloudPayOrder, CloudPaySnapshot } from '../api';
import type { WorkMode } from '../components';
import { creditAmount } from '../format';
import { colors } from '../theme';

type AssetGroup = 'bought' | 'provided';

type Props = Readonly<{
  snapshot: CloudPaySnapshot;
  mode: WorkMode;
  refreshing: boolean;
  onRefresh: () => void;
  onLogin: () => void;
  onOpenCredits: () => void;
  onOpenOrder: (order: CloudPayOrder) => void;
  onOpenMarket: () => void;
  onOpenProviderAssets: () => void;
  onOpenPublish: () => void;
  onOpenPayout: () => void;
}>;

const activeOrderStatuses: CloudPayOrder['status'][] = ['reserved', 'confirmed', 'provisioning', 'ready', 'in_service', 'acceptance_pending', 'disputed', 'accepted', 'release_pending', 'refund_pending'];

function orderState(order: CloudPayOrder) {
  if (order.status === 'reserved') return '待确认';
  if (order.status === 'confirmed' || order.status === 'provisioning') return '部署中';
  if (order.status === 'ready' || order.status === 'in_service') return '使用中';
  if (order.status === 'accepted' || order.status === 'release_pending') return '待结算';
  if (order.status === 'closed') return '已完成';
  if (order.status === 'disputed' || order.status === 'refund_pending') return '核对中';
  return '查看进度';
}

export function UnifiedAssetsScreen({ snapshot, mode, refreshing, onRefresh, onLogin, onOpenCredits, onOpenOrder, onOpenMarket, onOpenProviderAssets, onOpenPublish, onOpenPayout }: Props) {
  const [group, setGroup] = useState<AssetGroup>(mode === 'provider' ? 'provided' : 'bought');
  const [moreStatuses, setMoreStatuses] = useState(false);
  useEffect(() => { setGroup(mode === 'provider' ? 'provided' : 'bought'); }, [mode]);

  const buyerOrders = useMemo(() => snapshot.orders.filter((order) => order.side === 'buyer'), [snapshot.orders]);
  const providerOrders = useMemo(() => snapshot.orders.filter((order) => order.side === 'provider'), [snapshot.orders]);
  const shownOrders = group === 'bought' ? buyerOrders : providerOrders;
  const workspace = snapshot.providerWorkspace;
  const deviceCount = workspace ? Object.values(workspace.resources).reduce((sum, value) => sum + value, 0) : 0;
  const listingCount = workspace ? Object.values(workspace.listings).reduce((sum, value) => sum + value, 0) : 0;
  const boughtCount = buyerOrders.filter((order) => activeOrderStatuses.includes(order.status)).length;
  const deployingCount = buyerOrders.filter((order) => order.status === 'confirmed' || order.status === 'provisioning').length;
  const usingCount = buyerOrders.filter((order) => order.status === 'ready' || order.status === 'in_service').length;
  const assetUnits = snapshot.deviceAssets.reduce((sum, asset) => sum + asset.quantity, 0);
  const deviceDeploying = snapshot.deviceOrders.filter((order) => order.status === 'confirmed' || order.status === 'shipping').reduce((sum, order) => sum + order.quantity, 0);
  const devicePending = snapshot.deviceOrders.filter((order) => order.status === 'reserved').reduce((sum, order) => sum + order.quantity, 0);
  const statuses = [
    { label: '托管设备', count: assetUnits },
    { label: '部署中', count: deviceDeploying + deployingCount },
    { label: '待处理', count: devicePending + buyerOrders.filter((order) => order.requiresAttention).length },
    { label: '运营中', count: group === 'provided' ? workspace?.listings.selling ?? 0 : usingCount },
    { label: '已回购', count: 0 },
    { label: '已续产', count: 0 },
    { label: '设备关闭', count: group === 'provided' ? (workspace?.resources.suspended ?? 0) + (workspace?.resources.retired ?? 0) : 0 },
  ];

  return <View style={styles.root}>
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
      <View style={styles.header}>
        <View><Text style={styles.title}>我的资产</Text><Text style={styles.subtitle}>一个账号，统一查看购买与提供记录</Text></View>
        {group === 'provided' ? <Pressable onPress={onOpenPublish} hitSlop={8}><Text style={styles.textAction}>管理上架</Text></Pressable> : null}
      </View>

      <View style={styles.segment}>
        <Pressable onPress={() => setGroup('bought')} style={[styles.segmentItem, group === 'bought' && styles.segmentActive]}><Text style={[styles.segmentText, group === 'bought' && styles.segmentTextActive]}>我购买的</Text></Pressable>
        <Pressable onPress={() => setGroup('provided')} style={[styles.segmentItem, group === 'provided' && styles.segmentActive]}><Text style={[styles.segmentText, group === 'provided' && styles.segmentTextActive]}>我提供的</Text></Pressable>
      </View>

      {!snapshot.authenticated ? <View style={styles.emptyCard}><Ionicons name="lock-closed-outline" size={25} color={colors.primary} /><Text style={styles.emptyTitle}>登录后查看资产</Text><Text style={styles.emptyText}>卡时、已购算力和提供进度都会保留在同一账号。</Text><Pressable onPress={onLogin} style={styles.primary}><Text style={styles.primaryText}>登录 CloudPay</Text></Pressable></View> : <>
        <Pressable onPress={onOpenCredits} style={styles.walletCard} accessibilityRole="button" accessibilityLabel="查看 KAI 卡时明细">
          <View style={styles.walletHeading}><Text style={styles.cardTitle}>KAI 卡时</Text><Ionicons name="chevron-forward" size={17} color={colors.muted} /></View>
          <View style={styles.balanceRow}>
            <Balance label="可用" value={snapshot.creditBalance ? creditAmount(snapshot.creditBalance.available) : '—'} />
            <Balance label="订单预留" value={snapshot.creditBalance ? creditAmount(snapshot.creditBalance.reserved) : '—'} />
            <Balance label="待结算" value={snapshot.creditBalance ? creditAmount(snapshot.creditBalance.supplierReceivable) : '—'} />
            <Balance label="兑付冻结" value={snapshot.creditBalance ? creditAmount(snapshot.creditBalance.payoutFrozen) : '—'} />
          </View>
        </Pressable>

        {group === 'bought' ? <>
          <Text style={styles.sectionTitle}>算力资产</Text>
          <View style={styles.metricGrid}>
            <Metric label="已购算力" value={String(boughtCount)} />
            <Metric label="部署中" value={String(deployingCount)} />
            <Metric label="使用中" value={String(usingCount)} />
            <Metric label="续费 / 到期" value="查看" />
          </View>
          {snapshot.deviceAssets.length || snapshot.deviceOrders.length ? <View style={styles.deviceList}>
            {snapshot.deviceAssets.map((asset) => <View key={asset.id} style={styles.deviceRow}><View style={styles.deviceIcon}><Ionicons name="cube-outline" size={18} color={colors.ink} /></View><View style={styles.orderCopy}><Text style={styles.orderTitle}>{asset.title}</Text><Text style={styles.orderMeta}>已购设备 · {asset.quantity} 台 · {new Date(asset.acquiredAt).toLocaleDateString('zh-CN')}</Text></View><Text style={styles.stateOk}>已拥有</Text></View>)}
            {snapshot.deviceOrders.filter((order) => order.status !== 'received').map((order) => <View key={order.id} style={styles.deviceRow}><View style={styles.deviceIcon}><Ionicons name="car-outline" size={18} color={colors.ink} /></View><View style={styles.orderCopy}><Text style={styles.orderTitle}>NVIDIA DGX Spark · {order.quantity} 台</Text><Text style={styles.orderMeta}>{order.orderNumber} · {creditAmount(order.totalCredit)} 卡时</Text></View><Text style={styles.state}>{order.status === 'reserved' ? '待确认' : order.status === 'confirmed' ? '待发货' : order.status === 'shipping' ? '运输中' : order.status === 'cancelled' ? '已取消' : '已过期'}</Text></View>)}
          </View> : null}
        </> : <>
          <Text style={styles.sectionTitle}>供给资产</Text>
          <View style={styles.metricGrid}>
            <Metric label="设备" value={String(deviceCount)} />
            <Metric label="挂牌" value={String(listingCount)} />
            <Metric label="运营中" value={String(workspace?.listings.selling ?? 0)} />
            <Metric label="待结算" value={snapshot.creditBalance ? creditAmount(snapshot.creditBalance.supplierReceivable) : '—'} />
          </View>
          <View style={styles.revenueCard}>
            <View><Text style={styles.revenueLabel}>可兑付收益</Text><Text style={styles.revenueValue}>{snapshot.creditBalance ? creditAmount(snapshot.creditBalance.redeemableSupplierEarnings) : '—'} <Text style={styles.revenueUnit}>KAI 卡时</Text></Text></View>
            <Pressable onPress={onOpenPayout}><Text style={styles.textAction}>兑付与明细</Text></Pressable>
          </View>
          <Pressable onPress={onOpenProviderAssets} style={styles.inlineEntry}><View><Text style={styles.inlineTitle}>设备与节点</Text><Text style={styles.inlineText}>查看部署、待处理、运营与关闭状态</Text></View><Ionicons name="arrow-forward" size={17} color={colors.primary} /></Pressable>
        </>}

        <View style={styles.statusHeading}><Text style={styles.sectionTitle}>设备状态</Text><Pressable onPress={() => setMoreStatuses((value) => !value)}><Text style={styles.textAction}>{moreStatuses ? '收起' : '更多状态'}</Text></Pressable></View>
        <View style={styles.statusGrid}>{statuses.slice(0, moreStatuses ? 7 : 4).map((item) => <View key={item.label} style={styles.statusChip}><Text style={styles.statusCount}>{item.count}</Text><Text style={styles.statusLabel}>{item.label}</Text></View>)}</View>
        <Text style={styles.evidenceNote}>状态只统计平台已有订单、设备资产和资源记录；没有记录的状态显示为 0。</Text>

        {group === 'provided' && snapshot.payouts.length ? <><View style={styles.orderHeading}><Text style={styles.sectionTitle}>兑付记录</Text><Text style={styles.orderCount}>{snapshot.payouts.length} 笔</Text></View>{snapshot.payouts.slice(0, 3).map((payout) => <View key={payout.id} style={styles.orderRow}><View style={styles.orderIcon}><Ionicons name="cash-outline" size={19} color={colors.ink} /></View><View style={styles.orderCopy}><Text style={styles.orderTitle}>{payout.payoutNumber}</Text><Text style={styles.orderMeta}>{creditAmount(payout.creditAmount)} 卡时 · ¥{payout.amountCny}</Text></View><Text style={styles.state}>{payout.status === 'submitted' ? '已提交' : payout.status === 'reviewing' ? '审核中' : payout.status === 'paying' ? '付款中' : payout.status === 'succeeded' ? '已到账' : payout.status === 'cancelled' ? '已取消' : '已退回'}</Text></View>)}</> : null}

        <View style={styles.orderHeading}><Text style={styles.sectionTitle}>{group === 'bought' ? '最近购买' : '最近供给'}</Text><Text style={styles.orderCount}>{shownOrders.length} 笔</Text></View>
        {shownOrders.length ? shownOrders.slice(0, 6).map((order) => <Pressable key={order.id} onPress={() => onOpenOrder(order)} style={styles.orderRow}><View style={styles.orderIcon}><Ionicons name={group === 'bought' ? 'flash-outline' : 'server-outline'} size={19} color={colors.ink} /></View><View style={styles.orderCopy}><Text numberOfLines={1} style={styles.orderTitle}>{order.title}</Text><Text style={styles.orderMeta}>{orderState(order)} · {creditAmount(order.totalCredits)} 卡时</Text></View><Ionicons name="chevron-forward" size={16} color={colors.subtle} /></Pressable>) : <View style={styles.orderEmpty}><Text style={styles.emptyText}>{group === 'bought' ? '还没有购买记录。' : '还没有供给订单。'}</Text>{group === 'bought' ? <Pressable onPress={onOpenMarket} style={styles.primary}><Text style={styles.primaryText}>去市场看看</Text></Pressable> : null}</View>}
      </>}
    </ScrollView>
  </View>;
}

function Balance({ label, value }: Readonly<{ label: string; value: string }>) { return <View style={styles.balance}><Text style={styles.balanceValue}>{value}</Text><Text style={styles.balanceLabel}>{label}</Text></View>; }
function Metric({ label, value }: Readonly<{ label: string; value: string }>) { return <View style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></View>; }

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 16, paddingBottom: 34 },
  header: { minHeight: 54, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }, title: { color: colors.ink, fontSize: 25, fontWeight: '900' }, subtitle: { color: colors.muted, fontSize: 11, marginTop: 5 }, textAction: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  segment: { flexDirection: 'row', padding: 3, marginTop: 12, marginBottom: 12, borderRadius: 10, backgroundColor: '#EDEFF2' }, segmentItem: { flex: 1, minHeight: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 8 }, segmentActive: { backgroundColor: colors.surface }, segmentText: { color: colors.muted, fontSize: 12, fontWeight: '700' }, segmentTextActive: { color: colors.ink, fontWeight: '900' },
  walletCard: { padding: 15, borderWidth: 1, borderColor: colors.line, borderRadius: 12, backgroundColor: colors.surface }, walletHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, cardTitle: { color: colors.ink, fontSize: 15, fontWeight: '900' }, balanceRow: { flexDirection: 'row', marginTop: 18 }, balance: { flex: 1 }, balanceValue: { color: colors.ink, fontSize: 14, fontWeight: '900' }, balanceLabel: { color: colors.muted, fontSize: 8, marginTop: 5 },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '900', marginTop: 20, marginBottom: 10 }, metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, metric: { width: '48%', minHeight: 72, padding: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 12, backgroundColor: colors.surface }, metricValue: { color: colors.ink, fontSize: 19, fontWeight: '900' }, metricLabel: { color: colors.muted, fontSize: 10, marginTop: 7 },
  revenueCard: { minHeight: 76, marginTop: 10, padding: 13, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#F1F7FF' }, revenueLabel: { color: colors.muted, fontSize: 9 }, revenueValue: { color: colors.ink, fontSize: 20, fontWeight: '900', marginTop: 4 }, revenueUnit: { fontSize: 9, color: colors.muted },
  inlineEntry: { minHeight: 68, marginTop: 10, paddingHorizontal: 13, borderWidth: 1, borderColor: colors.line, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface }, inlineTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, inlineText: { color: colors.muted, fontSize: 9, marginTop: 4 },
  deviceList: { gap: 8, marginTop: 10 }, deviceRow: { minHeight: 62, paddingHorizontal: 12, borderRadius: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, deviceIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F3F5' }, state: { color: colors.muted, fontSize: 9, fontWeight: '800' }, stateOk: { color: colors.green, fontSize: 9, fontWeight: '800' }, statusHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, statusGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, statusChip: { width: '23%', minHeight: 57, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, statusCount: { color: colors.ink, fontSize: 15, fontWeight: '900' }, statusLabel: { color: colors.muted, fontSize: 8, marginTop: 4 }, evidenceNote: { color: colors.muted, fontSize: 8, lineHeight: 13, marginTop: 7 },
  orderHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, orderCount: { color: colors.muted, fontSize: 10, marginTop: 10 }, orderRow: { minHeight: 68, paddingHorizontal: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.line, borderRadius: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface }, orderIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F3F5' }, orderCopy: { flex: 1, marginHorizontal: 10 }, orderTitle: { color: colors.ink, fontSize: 12, fontWeight: '800' }, orderMeta: { color: colors.muted, fontSize: 9, marginTop: 5 },
  emptyCard: { padding: 22, alignItems: 'center', borderWidth: 1, borderColor: colors.line, borderRadius: 12, backgroundColor: colors.surface }, emptyTitle: { color: colors.ink, fontSize: 17, fontWeight: '900', marginTop: 12 }, emptyText: { color: colors.muted, fontSize: 11, lineHeight: 17, textAlign: 'center', marginTop: 6 }, primary: { minHeight: 44, marginTop: 15, paddingHorizontal: 18, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 12, fontWeight: '900' }, orderEmpty: { padding: 18, alignItems: 'center', borderWidth: 1, borderColor: colors.line, borderRadius: 12, backgroundColor: colors.surface },
});
