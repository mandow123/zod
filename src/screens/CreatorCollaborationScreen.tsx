import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CloudPaySnapshot } from '../api';
import {
  createCreatorReferralLink,
  loadCreatorCommissionSummary,
  transferCreatorCommission,
  type CreatorCommission,
  type CreatorCommissionStatus,
  type CreatorCommissionSummary,
  type CreatorReferralLink,
  type CreatorRewardEvent,
} from '../creator-commissions';
import { creditAmount } from '../format';
import { colors } from '../theme';

type Props = Readonly<{
  snapshot: CloudPaySnapshot;
  onLogin: () => void;
  onTransferred: (event: CreatorRewardEvent) => void;
}>;

const statusLabels: Record<CreatorCommissionStatus, string> = {
  attributed: '订单跟踪中', refund_observation: '退款观察期', pending: '待结算', available: '可转入',
  reversed: '已冲正', transferred: '已转入',
};

export function CreatorCollaborationScreen({ snapshot, onLogin, onTransferred }: Props) {
  const [summary, setSummary] = useState<CreatorCommissionSummary | null>(null);
  const [referralLink, setReferralLink] = useState<CreatorReferralLink | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<'link' | 'transfer' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestKeys = useRef<Record<'link' | 'transfer', string | null>>({ link: null, transfer: null });

  const load = useCallback(async () => {
    if (!snapshot.authenticated) { setSummary(null); return; }
    setLoading(true); setNotice(null);
    try { setSummary(await loadCreatorCommissionSummary()); }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : '返佣记录暂时无法读取。'); }
    finally { setLoading(false); }
  }, [snapshot.authenticated, snapshot.currentSubjectId]);

  useEffect(() => { void load(); }, [load]);

  const createLink = async () => {
    if (!snapshot.authenticated) { onLogin(); return; }
    requestKeys.current.link ??= `creator-link:${Crypto.randomUUID()}`;
    setBusy('link'); setNotice(null);
    try {
      const link = await createCreatorReferralLink(requestKeys.current.link);
      setReferralLink(link); requestKeys.current.link = null;
      await Clipboard.setStringAsync(link.url);
      setNotice('推广链接已复制。订单完成并通过退款观察期后，返佣才可转入。');
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : '推广链接创建失败。'); }
    finally { setBusy(null); }
  };

  const transfer = async () => {
    if (!snapshot.authenticated) { onLogin(); return; }
    requestKeys.current.transfer ??= `creator-transfer:${Crypto.randomUUID()}`;
    setBusy('transfer'); setNotice(null);
    try {
      const result = await transferCreatorCommission(requestKeys.current.transfer);
      requestKeys.current.transfer = null;
      onTransferred(result.rewardEvent);
      await load();
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : '返佣暂时无法转入。'); }
    finally { setBusy(null); }
  };

  const available = summary ? creditAmount(summary.balances.availableCardHours) : '0.00';
  return <View style={styles.root}><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}
    refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={colors.primary} />}>
    <View style={styles.heading}><Text style={styles.eyebrow}>合作与收益</Text><Text style={styles.title}>达人合作</Text><Text style={styles.subtitle}>分享专属链接，真实订单完成并通过观察期后获得卡时返佣。</Text></View>

    {!snapshot.authenticated ? <Empty title="登录后开始合作" text="推广关系、订单和返佣按账号独立记录。" action="安全登录" onPress={onLogin} /> : <>
      <View style={styles.balanceCard}><View><Text style={styles.balanceLabel}>可转入返佣</Text><Text style={styles.balanceValue}>{available}</Text><Text style={styles.balanceUnit}>KAI 卡时</Text></View><Pressable disabled={busy === 'transfer' || available === '0.00'} onPress={() => void transfer()} style={[styles.transfer, (busy === 'transfer' || available === '0.00') && styles.disabled]}>{busy === 'transfer' ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.transferText}>转入 KAI 卡时</Text>}</Pressable></View>
      <View style={styles.metrics}><Metric label="退款观察中" value={summary ? creditAmount(summary.balances.pendingCardHours) : '—'} /><Metric label="累计已转入" value={summary ? creditAmount(summary.balances.transferredCardHours) : '—'} /></View>

      <Text style={styles.sectionTitle}>推广工具</Text>
      <View style={styles.toolCard}><View style={styles.toolIcon}><Ionicons name="link-outline" size={22} color={colors.primary} /></View><View style={styles.toolCopy}><Text style={styles.toolTitle}>专属推广链接</Text><Text style={styles.toolText}>{referralLink ? `${referralLink.code} · 已复制` : '创建后自动复制，可用于你自己的内容与直播间。'}</Text></View><Pressable disabled={busy === 'link'} onPress={() => void createLink()} style={styles.toolAction}>{busy === 'link' ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={styles.toolActionText}>{referralLink ? '重新创建' : '创建'}</Text>}</Pressable></View>
      {notice ? <View style={styles.notice}><Ionicons name="information-circle-outline" size={18} color={colors.amber} /><Text style={styles.noticeText}>{notice}</Text></View> : null}

      <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>返佣记录</Text><Text style={styles.sectionCaption}>仅展示服务端真实订单</Text></View>
      {summary?.commissions.length ? summary.commissions.map((item) => <CommissionRow key={item.id} item={item} />)
        : !loading ? <View style={styles.emptyRecords}><Ionicons name="receipt-outline" size={24} color={colors.muted} /><Text style={styles.emptyRecordsTitle}>还没有返佣记录</Text><Text style={styles.emptyRecordsText}>通过专属链接产生的合格订单会显示在这里。</Text></View> : null}
      <View style={styles.rules}><Text style={styles.rulesTitle}>结算规则</Text><Text style={styles.rulesText}>返佣使用独立账本。订单退款或撤销会在可转入前冲正；只有服务端确认可用的返佣才能转入 KAI 卡时。</Text></View>
    </>}
  </ScrollView></View>;
}

function Metric({ label, value }: Readonly<{ label: string; value: string }>) { return <View style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricLabel}>{label} · 卡时</Text></View>; }
function CommissionRow({ item }: Readonly<{ item: CreatorCommission }>) { return <View style={styles.row}><View style={styles.rowIcon}><Ionicons name="sparkles-outline" size={18} color={colors.primary} /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{statusLabels[item.status]}</Text><Text style={styles.rowMeta}>{item.orderKind === 'device_order' ? '设备订单' : item.orderKind === 'vast_order' ? '即时算力订单' : '算力订单'} · {new Date(item.updatedAt).toLocaleDateString('zh-CN')}</Text></View><Text style={styles.rowValue}>{creditAmount(item.commissionCardHours)} 卡时</Text></View>; }
function Empty({ title, text, action, onPress }: Readonly<{ title: string; text: string; action: string; onPress: () => void }>) { return <View style={styles.empty}><View style={styles.emptyIcon}><Ionicons name="people-outline" size={28} color={colors.primary} /></View><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.emptyText}>{text}</Text><Pressable onPress={onPress} style={styles.primary}><Text style={styles.primaryText}>{action}</Text></Pressable></View>; }

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 16, paddingBottom: 36 }, heading: { padding: 18, borderRadius: 14, backgroundColor: '#EEF3F8', borderWidth: 1, borderColor: '#DEE6EE' }, eyebrow: { color: colors.primary, fontSize: 10, fontWeight: '900', letterSpacing: 1 }, title: { color: colors.ink, fontSize: 26, fontWeight: '900', marginTop: 7 }, subtitle: { color: colors.muted, fontSize: 11, lineHeight: 18, marginTop: 7 },
  balanceCard: { minHeight: 112, padding: 17, marginTop: 12, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, balanceLabel: { color: colors.muted, fontSize: 9 }, balanceValue: { color: colors.ink, fontSize: 30, fontWeight: '900', marginTop: 5 }, balanceUnit: { color: colors.muted, fontSize: 9, marginTop: 2 }, transfer: { minHeight: 42, paddingHorizontal: 13, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, transferText: { color: colors.surface, fontSize: 10, fontWeight: '900' }, disabled: { opacity: 0.45 }, metrics: { flexDirection: 'row', gap: 8, marginTop: 8 }, metric: { flex: 1, minHeight: 72, padding: 13, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, metricValue: { color: colors.ink, fontSize: 17, fontWeight: '900' }, metricLabel: { color: colors.muted, fontSize: 8, marginTop: 6 },
  sectionHeading: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }, sectionTitle: { color: colors.ink, fontSize: 16, fontWeight: '900', marginTop: 20, marginBottom: 9 }, sectionCaption: { color: colors.muted, fontSize: 8, marginBottom: 10 }, toolCard: { minHeight: 74, padding: 12, borderRadius: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, toolIcon: { width: 40, height: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, toolCopy: { flex: 1, marginLeft: 10 }, toolTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' }, toolText: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 4 }, toolAction: { minWidth: 52, minHeight: 36, alignItems: 'center', justifyContent: 'center' }, toolActionText: { color: colors.primary, fontSize: 10, fontWeight: '900' },
  notice: { flexDirection: 'row', gap: 8, padding: 11, marginTop: 9, borderRadius: 10, backgroundColor: colors.amberSoft }, noticeText: { flex: 1, color: colors.ink, fontSize: 9, lineHeight: 15 }, row: { minHeight: 66, paddingHorizontal: 12, marginBottom: 8, borderRadius: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, rowIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, rowCopy: { flex: 1, marginLeft: 10 }, rowTitle: { color: colors.ink, fontSize: 11, fontWeight: '900' }, rowMeta: { color: colors.muted, fontSize: 8, marginTop: 4 }, rowValue: { color: colors.ink, fontSize: 11, fontWeight: '900' }, emptyRecords: { padding: 22, alignItems: 'center', borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, emptyRecordsTitle: { color: colors.ink, fontSize: 13, fontWeight: '900', marginTop: 9 }, emptyRecordsText: { color: colors.muted, fontSize: 9, marginTop: 5 }, rules: { padding: 14, marginTop: 13, borderRadius: 12, backgroundColor: '#EEF3F8' }, rulesTitle: { color: colors.ink, fontSize: 11, fontWeight: '900' }, rulesText: { color: colors.muted, fontSize: 9, lineHeight: 16, marginTop: 5 },
  empty: { padding: 28, marginTop: 12, alignItems: 'center', borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, emptyIcon: { width: 58, height: 58, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, emptyTitle: { color: colors.ink, fontSize: 17, fontWeight: '900', marginTop: 13 }, emptyText: { color: colors.muted, fontSize: 10, marginTop: 6 }, primary: { minHeight: 44, marginTop: 14, paddingHorizontal: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 11, fontWeight: '900' },
});
