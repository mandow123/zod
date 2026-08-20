import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CloudPaySnapshot } from '../api';
import {
  loadAssetPortfolio, type AssetAction, type AssetPortfolio, type ProvidedComputeAsset,
  type PurchasedComputeAsset, type PurchasedDeviceOrderAsset, type SuppliedDeviceOrderAsset,
} from '../asset-portfolio';
import { creditAmount } from '../format';
import { colors } from '../theme';
import { loadVastOrders, type VastOrder, type VastOrderStatus } from '../vast-commerce';

type Props = Readonly<{
  snapshot: CloudPaySnapshot;
  refreshing: boolean;
  onRefresh: () => void | Promise<void>;
  onLogin: () => void;
  onOpenCredits: () => void;
  onOpenOrder: (orderId: string) => void;
  onOpenDeviceOrder: (orderId: string) => void;
  onOpenMarket: () => void;
  onOpenProviderAssets: (resourceId?: string) => void;
  onOpenPublish: () => void;
  onOpenPayout: () => void;
}>;

type ProvidedFilter = 'all' | 'attention' | 'hosted' | 'deploying' | 'repurchased' | 'renewed' | 'closed' | 'operating';

const providedFilterLabels: Record<ProvidedFilter, string> = {
  all: '全部', attention: '待处理', hosted: '托管设备', deploying: '部署中', repurchased: '已回购',
  renewed: '已续产', closed: '设备关闭', operating: '运营中',
};

function matchesProvidedFilter(item: ProvidedComputeAsset, filter: ProvidedFilter) {
  if (filter === 'all') return true;
  if (filter === 'closed') return item.views.includes('closed') && !item.views.includes('repurchased');
  return item.views.includes(filter);
}

export function UnifiedAssetsScreen({ snapshot, refreshing, onRefresh, onLogin, onOpenCredits, onOpenOrder,
  onOpenDeviceOrder, onOpenMarket, onOpenProviderAssets, onOpenPublish, onOpenPayout }: Props) {
  const [portfolio, setPortfolio] = useState<AssetPortfolio | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vastOrders, setVastOrders] = useState<VastOrder[]>([]);
  const [vastError, setVastError] = useState(false);
  const [provided, setProvided] = useState(false);
  const [providedFilter, setProvidedFilter] = useState<ProvidedFilter>('all');
  const [filtersExpanded, setFiltersExpanded] = useState(false);

  const load = useCallback(async () => {
    if (!snapshot.authenticated) { setPortfolio(null); setVastOrders([]); setError(null); return; }
    setLoading(true); setError(null);
    try {
      const [portfolioResult, vastResult] = await Promise.allSettled([loadAssetPortfolio(), loadVastOrders()]);
      if (portfolioResult.status === 'rejected') throw portfolioResult.reason;
      setPortfolio(portfolioResult.value);
      setVastOrders(vastResult.status === 'fulfilled' ? vastResult.value : []);
      setVastError(vastResult.status === 'rejected');
    }
    catch (reason) { setPortfolio(null); setVastOrders([]); setError(reason instanceof Error ? reason.message : '资产暂时无法读取。'); }
    finally { setLoading(false); }
  }, [snapshot.authenticated, snapshot.currentSubjectId]);

  useEffect(() => { setPortfolio(null); void load(); }, [load]);
  const filteredProvidedCompute = useMemo(() => portfolio?.groups.providedCompute
    .filter((item) => matchesProvidedFilter(item, providedFilter)) ?? [], [portfolio, providedFilter]);
  const providedFilters = useMemo(() => {
    if (!portfolio) return [];
    const items = portfolio.groups.providedCompute;
    return (Object.keys(providedFilterLabels) as ProvidedFilter[]).map((key) => ({
      key, label: providedFilterLabels[key], count: items.filter((item) => matchesProvidedFilter(item, key)).length,
    }));
  }, [portfolio]);
  const refreshAll = async () => { await Promise.allSettled([onRefresh(), load()]); };
  const openCompute = (item: PurchasedComputeAsset) => onOpenOrder(item.id);
  const openAction = (item: PurchasedComputeAsset | PurchasedDeviceOrderAsset | SuppliedDeviceOrderAsset | ProvidedComputeAsset,
    action: AssetAction) => {
    if (item.assetType === 'purchased_compute') { openCompute(item); return; }
    if (item.assetType === 'provided_compute') { onOpenProviderAssets(item.resourceId); return; }
    onOpenDeviceOrder(item.id);
    void action;
  };

  return <View style={styles.root}><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}
    refreshControl={<RefreshControl refreshing={refreshing || loading} onRefresh={() => void refreshAll()} tintColor={colors.primary} />}>
    <View style={styles.heading}><View><Text style={styles.title}>我的资产</Text><Text style={styles.subtitle}>{portfolio?.subject.displayName ?? '购买与提供记录按当前主体隔离'}</Text></View><Pressable onPress={onOpenPublish}><Text style={styles.textAction}>上架资源</Text></Pressable></View>
    <View style={styles.segment}><Pressable onPress={() => setProvided(false)} style={[styles.segmentItem, !provided && styles.segmentActive]}><Text style={[styles.segmentText, !provided && styles.segmentTextActive]}>我购买的</Text></Pressable><Pressable onPress={() => setProvided(true)} style={[styles.segmentItem, provided && styles.segmentActive]}><Text style={[styles.segmentText, provided && styles.segmentTextActive]}>我提供的</Text></Pressable></View>

    {!snapshot.authenticated ? <Empty icon="lock-closed-outline" title="登录后查看资产" text="已购算力、设备和供应资产都会保留在同一账号。" action="安全登录" onPress={onLogin} />
      : error ? <Empty icon="cloud-offline-outline" title="资产暂时没能同步" text="页面不会用订单数量推算资产，也不会把旧主体数据当成当前数据。" action="重新读取" onPress={() => void load()} />
      : loading && !portfolio ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>正在读取当前主体资产…</Text></View>
      : portfolio ? <>
        <Pressable onPress={onOpenCredits} style={styles.wallet}><View><Text style={styles.walletLabel}>KAI 卡时账户</Text><Text style={styles.walletValue}>{snapshot.creditBalance ? creditAmount(snapshot.creditBalance.available, true) : '—'}</Text></View><Ionicons name="chevron-forward" size={18} color={colors.primary} /></Pressable>
        <View style={styles.metrics}>{provided ? <><Metric label="提供算力" value={portfolio.summary.providedCompute} /><Metric label="设备销售单" value={portfolio.summary.suppliedDeviceOrders} /><Metric label="运营中" value={portfolio.summary.operating} /><Metric label="待处理" value={portfolio.summary.actionRequired} /></> : <><Metric label="已购算力" value={portfolio.summary.purchasedCompute} /><Metric label="设备订单" value={portfolio.summary.purchasedDevices} /><Metric label="拥有设备" value={portfolio.summary.ownedDevices} /><Metric label="待处理" value={portfolio.summary.actionRequired} /></>}</View>
        {provided ? <>
          <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>供应状态</Text><Pressable onPress={() => setFiltersExpanded((current) => !current)}><Text style={styles.textAction}>{filtersExpanded ? '收起筛选' : '展开筛选'}</Text></Pressable></View><View style={styles.statuses}>{[
            ['待处理', portfolio.summary.attention],
            ['托管与部署', portfolio.summary.hosted + portfolio.summary.deploying],
            ['运营中', portfolio.summary.operating],
            ['生命周期', portfolio.summary.repurchased + portfolio.summary.renewed + portfolio.summary.closed],
          ].map(([label, count]) => <View key={String(label)} style={styles.status}><Text style={styles.statusCount}>{count}</Text><Text style={styles.statusLabel}>{label}</Text></View>)}</View>
          {filtersExpanded ? <View style={styles.filterGrid}>{providedFilters.map((item) => <Pressable key={item.key} onPress={() => setProvidedFilter(item.key)} style={[styles.filterChip, providedFilter === item.key && styles.filterChipActive]}><Text style={[styles.filterChipText, providedFilter === item.key && styles.filterChipTextActive]}>{item.label} {item.count}</Text></Pressable>)}</View> : null}
          <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>提供中的算力</Text><Pressable onPress={() => onOpenProviderAssets()}><Text style={styles.textAction}>全部资源</Text></Pressable></View>
          {filteredProvidedCompute.map((item) => <AssetRow key={item.id} title={item.title} meta={`${item.region} · ${item.statusLabel}`} action={item.actions[0]} onPress={() => item.actions[0] ? openAction(item, item.actions[0]) : onOpenProviderAssets(item.resourceId)} />)}
          {!filteredProvidedCompute.length ? <View style={styles.filteredEmpty}><Text style={styles.filteredEmptyText}>当前筛选下没有资源</Text></View> : null}
          {portfolio.groups.suppliedDeviceOrders.length ? <Text style={styles.sectionTitle}>设备销售订单</Text> : null}
          {portfolio.groups.suppliedDeviceOrders.map((item) => <AssetRow key={item.id} title={snapshot.deviceProducts.find((value) => value.id === item.productId)?.title ?? item.orderNumber} meta={`${item.quantity} 台 · ${creditAmount(item.grossCredit)} 卡时`} action={item.actions[0]} onPress={() => onOpenDeviceOrder(item.id)} />)}
          {snapshot.payoutProfile?.status === 'active' ? <Pressable onPress={onOpenPayout} style={styles.inlineAction}><Text style={styles.inlineActionText}>查看供应收益与兑付</Text><Ionicons name="arrow-forward" size={16} color={colors.primary} /></Pressable> : null}
        </> : <>
          <Text style={styles.sectionTitle}>已购算力</Text>{portfolio.groups.purchasedCompute.map((item) => <AssetRow key={item.id} title={item.title} meta={`${item.quantity} ${item.capacityUnit} · ${creditAmount(item.totalCredit)} 卡时`} action={item.actions[0]} onPress={() => openCompute(item)} />)}
          {vastOrders.length ? <><Text style={styles.sectionTitle}>Vast.ai 即时算力</Text>{vastOrders.map((item) => <VastAssetRow key={item.id} order={item} />)}</> : null}
          {vastError ? <Text style={styles.readWarning}>Vast.ai 订单暂时没能同步，下拉刷新后再试。</Text> : null}
          {portfolio.groups.purchasedDeviceOrders.length ? <Text style={styles.sectionTitle}>设备订单</Text> : null}{portfolio.groups.purchasedDeviceOrders.map((item) => <AssetRow key={item.id} title={snapshot.deviceProducts.find((value) => value.id === item.productId)?.title ?? item.orderNumber} meta={`${item.quantity} 台 · ${creditAmount(item.totalCredit)} 卡时`} action={item.actions[0]} onPress={() => onOpenDeviceOrder(item.id)} />)}
          {portfolio.groups.ownedDevices.length ? <Text style={styles.sectionTitle}>已拥有设备</Text> : null}{portfolio.groups.ownedDevices.map((item) => <AssetRow key={item.id} title={item.title} meta={`${item.quantity} 台 · ${new Date(item.acquiredAt).toLocaleDateString('zh-CN')}`} action={item.actions[0]} onPress={() => onOpenDeviceOrder(item.orderId)} />)}
          {!portfolio.groups.purchasedCompute.length && !vastOrders.length && !portfolio.groups.purchasedDeviceOrders.length && !portfolio.groups.ownedDevices.length ? <Empty icon="cube-outline" title="还没有购买资产" text="市场只显示服务端确认可购买的资源。" action="去市场看看" onPress={onOpenMarket} /> : null}
        </>}
      </> : null}
  </ScrollView></View>;
}

function Metric({ label, value }: Readonly<{ label: string; value: number }>) { return <View style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></View>; }
function AssetRow({ title, meta, action, onPress }: Readonly<{ title: string; meta: string; action?: AssetAction; onPress: () => void }>) { return <Pressable onPress={onPress} style={styles.row}><View style={styles.rowIcon}><Ionicons name="cube-outline" size={18} color={colors.ink} /></View><View style={styles.rowCopy}><Text numberOfLines={1} style={styles.rowTitle}>{title}</Text><Text style={styles.rowMeta}>{meta}</Text></View><Text style={styles.rowAction}>{action?.label ?? '查看'}</Text></Pressable>; }
const vastStatusLabels: Record<VastOrderStatus, string> = { confirming: '确认中', pending_reconciliation: '状态核对中', provisioning: '部署中', ready: '待启用', running: '运行中', stopping: '关闭中', closed: '已关闭', refunded: '已退回' };
function VastAssetRow({ order }: Readonly<{ order: VastOrder }>) { return <View style={styles.row}><View style={styles.vastRowIcon}><Ionicons name="flash-outline" size={18} color={colors.primary} /></View><View style={styles.rowCopy}><Text numberOfLines={1} style={styles.rowTitle}>Vast.ai 即时算力</Text><Text style={styles.rowMeta}>{order.orderNumber} · {creditAmount(order.amountCardHours)} 卡时</Text></View><Text style={styles.rowAction}>{vastStatusLabels[order.status]}</Text></View>; }
function Empty({ icon, title, text, action, onPress }: Readonly<{ icon: 'lock-closed-outline' | 'cloud-offline-outline' | 'cube-outline'; title: string; text: string; action: string; onPress: () => void }>) { return <View style={styles.empty}><View style={styles.emptyIcon}><Ionicons name={icon} size={27} color={colors.primary} /></View><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.emptyText}>{text}</Text><Pressable onPress={onPress} style={styles.primary}><Text style={styles.primaryText}>{action}</Text></Pressable></View>; }

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 16, paddingBottom: 36 }, heading: { minHeight: 56, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, title: { color: colors.ink, fontSize: 25, fontWeight: '900' }, subtitle: { color: colors.muted, fontSize: 9, marginTop: 5 }, textAction: { color: colors.primary, fontSize: 11, fontWeight: '900' },
  segment: { flexDirection: 'row', padding: 3, marginVertical: 10, borderRadius: 10, backgroundColor: '#E9EDF3' }, segmentItem: { flex: 1, minHeight: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }, segmentActive: { backgroundColor: colors.surface }, segmentText: { color: colors.muted, fontSize: 11, fontWeight: '700' }, segmentTextActive: { color: colors.ink, fontWeight: '900' },
  wallet: { minHeight: 78, padding: 14, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, walletLabel: { color: colors.muted, fontSize: 9 }, walletValue: { color: colors.ink, fontSize: 21, fontWeight: '900', marginTop: 5 }, metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }, metric: { width: '48%', minHeight: 72, padding: 12, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, metricValue: { color: colors.ink, fontSize: 19, fontWeight: '900' }, metricLabel: { color: colors.muted, fontSize: 9, marginTop: 6 },
  sectionTitle: { color: colors.ink, fontSize: 16, fontWeight: '900', marginTop: 20, marginBottom: 9 }, sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, statuses: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, status: { width: '23%', minHeight: 58, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, statusCount: { color: colors.ink, fontSize: 15, fontWeight: '900' }, statusLabel: { color: colors.muted, fontSize: 8, marginTop: 4 },
  filterGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 8 }, filterChip: { minHeight: 32, paddingHorizontal: 10, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, filterChipActive: { backgroundColor: colors.primarySoft, borderColor: '#B7CEF4' }, filterChipText: { color: colors.muted, fontSize: 9, fontWeight: '700' }, filterChipTextActive: { color: colors.primary, fontWeight: '900' }, filteredEmpty: { minHeight: 64, marginBottom: 8, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, filteredEmptyText: { color: colors.muted, fontSize: 9 },
  row: { minHeight: 68, paddingHorizontal: 12, marginBottom: 8, borderRadius: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, rowIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, vastRowIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, rowCopy: { flex: 1, marginHorizontal: 10 }, rowTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' }, rowMeta: { color: colors.muted, fontSize: 9, marginTop: 4 }, rowAction: { color: colors.primary, fontSize: 9, fontWeight: '900' }, readWarning: { color: colors.amber, fontSize: 9, marginBottom: 10 }, inlineAction: { minHeight: 48, marginTop: 10, paddingHorizontal: 13, borderRadius: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.primarySoft }, inlineActionText: { color: colors.primary, fontSize: 11, fontWeight: '900' },
  loading: { padding: 30, alignItems: 'center' }, loadingText: { color: colors.muted, fontSize: 10, marginTop: 10 }, empty: { padding: 24, marginTop: 10, alignItems: 'center', borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, emptyIcon: { width: 58, height: 58, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, emptyTitle: { color: colors.ink, fontSize: 17, fontWeight: '900', marginTop: 13 }, emptyText: { color: colors.muted, fontSize: 10, lineHeight: 16, textAlign: 'center', marginTop: 6 }, primary: { minHeight: 44, marginTop: 14, paddingHorizontal: 18, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 11, fontWeight: '900' },
});
