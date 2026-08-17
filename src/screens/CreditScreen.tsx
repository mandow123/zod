import { Ionicons } from '@expo/vector-icons';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CloudPaySnapshot } from '../api';
import { creditAmount } from '../format';
import { colors } from '../theme';

type Props = Readonly<{
  snapshot: CloudPaySnapshot;
  refreshing: boolean;
  onRefresh: () => void;
  onLogin: () => void;
  onOpenWallet: () => void;
  onOpenPayout: () => void;
}>;

const payoutLabels = {
  submitted: '已提交', reviewing: '审核中', paying: '付款中', succeeded: '已到账', failed: '付款失败',
  rejected: '已退回', cancelled: '已取消',
} as const;

export function CreditScreen({ snapshot, refreshing, onRefresh, onLogin, onOpenWallet, onOpenPayout }: Props) {
  const balance = snapshot.creditBalance;
  const supplierQualified = snapshot.payoutProfile?.status === 'active';
  return <View style={styles.root}><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}
    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
    <View style={styles.heading}><View><Text style={styles.title}>KAI 卡时</Text><Text style={styles.subtitle}>充值到账后，以卡时购买算力和设备</Text></View><View style={styles.unit}><Text style={styles.unitText}>1 卡时 = ¥1.002</Text></View></View>

    {!snapshot.authenticated ? <View style={styles.empty}><View style={styles.emptyIcon}><Ionicons name="wallet-outline" size={28} color={colors.primary} /></View><Text style={styles.emptyTitle}>登录后查看卡时账户</Text><Text style={styles.emptyText}>余额、订单预留、供应收益和兑付记录都按交易主体隔离。</Text><Pressable onPress={onLogin} style={styles.primary}><Text style={styles.primaryText}>安全登录</Text></Pressable></View> : <>
      {snapshot.commerceError ? <View style={styles.warning}><Ionicons name="cloud-offline-outline" size={18} color={colors.amber} /><View style={styles.warningCopy}><Text style={styles.warningTitle}>部分账户数据暂未同步</Text><Text style={styles.warningText}>页面不会把其他主体的旧数据当作当前余额，请下拉重试。</Text></View></View> : null}
      <View style={styles.balanceCard}><Text style={styles.balanceLabel}>当前可用</Text><Text style={styles.balanceValue}>{balance ? creditAmount(balance.available, true) : '—'}</Text><Text style={styles.balanceUnit}>KAI 卡时</Text><View style={styles.actions}><Pressable onPress={onOpenWallet} style={styles.primary}><Text style={styles.primaryText}>充值卡时</Text></Pressable>{snapshot.payoutProfile?.status === 'active' ? <Pressable onPress={onOpenPayout} style={styles.secondary}><Text style={styles.secondaryText}>供应收益兑付</Text></Pressable> : null}</View></View>

      <Text style={styles.sectionTitle}>账户分布</Text>
      <View style={styles.grid}>
        <Metric label="订单预留" value={balance ? creditAmount(balance.reserved) : '—'} detail="订单确认前暂时锁定" />
        <Metric label="账户合计" value={balance ? creditAmount(balance.total) : '—'} detail="可用与各状态卡时合计" />
        {supplierQualified ? <><Metric label="待结算" value={balance ? creditAmount(balance.supplierReceivable) : '—'} detail="交付完成后进入结算" /><Metric label="可兑付" value={balance ? creditAmount(balance.redeemableSupplierEarnings) : '—'} detail="可申请公司付款" /><Metric label="兑付冻结" value={balance ? creditAmount(balance.payoutFrozen) : '—'} detail="付款处理中" /></> : null}
      </View>

      {supplierQualified ? <><View style={styles.sectionHeading}><Text style={styles.sectionTitle}>兑付明细</Text><Text style={styles.count}>{snapshot.payouts.length} 笔</Text></View>
      {snapshot.payouts.length ? snapshot.payouts.map((payout) => <View key={payout.id} style={styles.row}><View style={styles.rowIcon}><Ionicons name="cash-outline" size={19} color={colors.ink} /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{creditAmount(payout.creditAmount)} 卡时</Text><Text style={styles.rowMeta}>{payout.payoutNumber} · 预计 ¥{payout.amountCny}</Text></View><Text style={styles.rowState}>{payoutLabels[payout.status]}</Text></View>) : <View style={styles.noRows}><Text style={styles.noRowsText}>当前主体还没有兑付记录</Text></View>}</> : null}
    </>}
  </ScrollView></View>;
}

function Metric({ label, value, detail }: Readonly<{ label: string; value: string; detail: string }>) {
  return <View style={styles.metric}><Text style={styles.metricLabel}>{label}</Text><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricDetail}>{detail}</Text></View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 16, paddingBottom: 36 },
  heading: { minHeight: 62, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, title: { color: colors.ink, fontSize: 25, fontWeight: '900' }, subtitle: { color: colors.muted, fontSize: 10, marginTop: 5 }, unit: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.primarySoft }, unitText: { color: colors.primaryDark, fontSize: 9, fontWeight: '800' },
  balanceCard: { padding: 18, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, balanceLabel: { color: colors.muted, fontSize: 10 }, balanceValue: { color: colors.ink, fontSize: 34, fontWeight: '900', marginTop: 8 }, balanceUnit: { color: colors.muted, fontSize: 10, marginTop: 3 }, actions: { flexDirection: 'row', gap: 9, marginTop: 18 },
  primary: { minHeight: 44, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 12, fontWeight: '900' }, secondary: { minHeight: 44, paddingHorizontal: 14, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#B7CEF4', backgroundColor: colors.surface }, secondaryText: { color: colors.primary, fontSize: 11, fontWeight: '900' },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '900', marginTop: 20, marginBottom: 10 }, grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, metric: { width: '48%', minHeight: 96, padding: 13, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, metricLabel: { color: colors.muted, fontSize: 9 }, metricValue: { color: colors.ink, fontSize: 19, fontWeight: '900', marginTop: 7 }, metricDetail: { color: colors.subtle, fontSize: 8, lineHeight: 13, marginTop: 6 }, sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, count: { color: colors.muted, fontSize: 9, marginTop: 10 },
  row: { minHeight: 68, paddingHorizontal: 12, marginBottom: 8, borderRadius: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, rowIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, rowCopy: { flex: 1, marginHorizontal: 10 }, rowTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' }, rowMeta: { color: colors.muted, fontSize: 9, marginTop: 4 }, rowState: { color: colors.primary, fontSize: 9, fontWeight: '800' }, noRows: { padding: 18, alignItems: 'center', borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, noRowsText: { color: colors.muted, fontSize: 10 },
  warning: { padding: 12, marginBottom: 10, borderRadius: 12, flexDirection: 'row', gap: 9, backgroundColor: colors.amberSoft }, warningCopy: { flex: 1 }, warningTitle: { color: colors.ink, fontSize: 11, fontWeight: '900' }, warningText: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 3 },
  empty: { padding: 26, marginTop: 20, alignItems: 'center', borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, emptyIcon: { width: 58, height: 58, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, emptyTitle: { color: colors.ink, fontSize: 18, fontWeight: '900', marginTop: 14 }, emptyText: { color: colors.muted, fontSize: 10, lineHeight: 16, textAlign: 'center', marginTop: 6 },
});
