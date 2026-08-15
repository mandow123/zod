import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  createCreditTopup, listCreditTopups, loadCreditTopup,
  type CreditBalance, type CreditTopup,
} from './api';
import { launchNativeTopup } from './native-payments';
import { colors } from './theme';
import { distributionPolicy } from './distribution';
import { creditAmount } from './format';

const amounts = [100, 500, 1000, 5000] as const;
const statusLabel: Record<CreditTopup['status'], string> = {
  created: '准备中', pending: '确认中', succeeded: '已到账', failed: '未完成', expired: '已失效',
  cancelled: '已取消', manual_review: '核对中',
};

function creditForYuan(yuan: number) { return creditAmount((yuan / 1.002).toFixed(6)); }
function dateTime(value: string) { const date = new Date(value); return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }

export function CreditWalletSheet({ visible, balance, alipayReady, wechatReady, onClose, onChanged }: Readonly<{
  visible: boolean;
  balance: CreditBalance | null;
  alipayReady: boolean;
  wechatReady: boolean;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}>) {
  const [topups, setTopups] = useState<CreditTopup[]>([]);
  const [selectedAmount, setSelectedAmount] = useState<(typeof amounts)[number]>(500);
  const [provider, setProvider] = useState<'alipay' | 'wechat'>(alipayReady ? 'alipay' : 'wechat');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeTopupId = useRef<string | null>(null);
  const request = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    if (alipayReady) setProvider('alipay');
    else if (wechatReady) setProvider('wechat');
  }, [alipayReady, wechatReady]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await listCreditTopups();
      setTopups(next);
      const active = activeTopupId.current ? next.find((item) => item.id === activeTopupId.current) : null;
      if (active && active.status === 'succeeded') {
        activeTopupId.current = null;
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        await onChanged();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '充值记录暂时无法读取。');
    } finally { setLoading(false); }
  }, [onChanged]);

  useEffect(() => { if (visible && distributionPolicy.nativeTopups) void refresh(); }, [refresh, visible]);
  useEffect(() => {
    if (!visible) return undefined;
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') void refresh(); });
    return () => subscription.remove();
  }, [refresh, visible]);

  const providerReady = provider === 'alipay' ? alipayReady : wechatReady;
  const expectedCredits = useMemo(() => creditForYuan(selectedAmount), [selectedAmount]);

  const launch = async (topup: CreditTopup) => {
    if (!topup.checkoutPayload) throw new Error('收银台信息已失效，请重新发起充值。');
    activeTopupId.current = topup.id;
    await launchNativeTopup(topup.provider, topup.checkoutPayload);
    setError('支付渠道结果正在确认，卡时到账后会自动更新。');
    await refresh();
  };

  const start = async () => {
    if (!providerReady) { setError(`${provider === 'alipay' ? '支付宝' : '微信支付'}尚未接通。`); return; }
    const signature = `${selectedAmount}:${provider}`;
    if (!request.current || request.current.signature !== signature) {
      request.current = { signature, key: `credit-topup:${Crypto.randomUUID()}` };
    }
    setBusy(true); setError(null);
    try {
      const topup = await createCreditTopup(selectedAmount * 100, provider, request.current.key);
      setTopups((current) => [topup, ...current.filter((item) => item.id !== topup.id)]);
      await launch(topup);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '充值没有发起成功，请重试。');
    } finally { setBusy(false); }
  };

  const resume = async (topup: CreditTopup) => {
    setBusy(true); setError(null);
    try { await launch(await loadCreditTopup(topup.id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '暂时无法继续这笔充值。'); }
    finally { setBusy(false); }
  };

  return <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
    <View style={styles.backdrop}><View style={styles.sheet}>
      <View style={styles.handle} />
      <View style={styles.header}><View><Text style={styles.eyebrow}>KAI 卡时</Text><Text style={styles.title}>卡时账户</Text></View><Pressable onPress={onClose} style={styles.close}><Ionicons name="close" size={23} color={colors.ink} /></Pressable></View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.balanceCard}>
          <Text style={styles.balanceLabel}>可用卡时</Text>
          <Text style={styles.balanceValue}>{balance ? creditAmount(balance.available) : '—'}</Text>
          <Text style={styles.balanceUnit}>KAI 卡时</Text>
          <View style={styles.balanceDivider} />
          <View style={styles.balanceFacts}><BalanceFact label="订单预留" value={balance ? creditAmount(balance.reserved) : '—'} /><BalanceFact label="待结算" value={balance ? creditAmount(balance.supplierReceivable) : '—'} /></View>
        </View>

        {distributionPolicy.nativeTopups ? <>
          <Text style={styles.sectionTitle}>充值卡时</Text>
          <Text style={styles.sectionHelp}>人民币只用于购买 KAI 卡时；购买算力时仅使用卡时。</Text>
          <View style={styles.amountGrid}>{amounts.map((amount) => <Pressable key={amount} onPress={() => { setSelectedAmount(amount); setError(null); request.current = null; }} style={[styles.amount, selectedAmount === amount && styles.amountActive]}><Text style={[styles.amountText, selectedAmount === amount && styles.amountTextActive]}>¥{amount}</Text><Text style={[styles.amountCredit, selectedAmount === amount && styles.amountCreditActive]}>约 {creditForYuan(amount)} 卡时</Text></Pressable>)}</View>

          <View style={styles.providers}>
            <ProviderChoice label="支付宝" icon="logo-alipay" active={provider === 'alipay'} enabled={alipayReady} onPress={() => { setProvider('alipay'); request.current = null; }} />
            <ProviderChoice label="微信支付" icon="logo-wechat" active={provider === 'wechat'} enabled={wechatReady} onPress={() => { setProvider('wechat'); request.current = null; }} />
          </View>

          <View style={styles.conversion}><Text style={styles.conversionLabel}>本次预计到账</Text><Text style={styles.conversionValue}>{expectedCredits} KAI 卡时</Text><Text style={styles.conversionRule}>固定换算：1 KAI 卡时 = ¥1.002</Text></View>
          {error ? <View style={styles.notice}><Ionicons name="information-circle-outline" size={18} color={colors.amber} /><Text style={styles.noticeText}>{error}</Text></View> : null}
          <Pressable disabled={busy || !providerReady} onPress={() => void start()} style={[styles.primary, (busy || !providerReady) && styles.disabled]}>{busy ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>{providerReady ? `支付 ¥${selectedAmount} 购买卡时` : '充值通道尚未接通'}</Text>}</Pressable>
          <Text style={styles.safety}>支付完成不等于立即入账。后端确认支付渠道结果后，卡时才会增加。</Text>

          <View style={styles.historyHeader}><Text style={styles.sectionTitle}>充值记录</Text><Pressable onPress={() => void refresh()}><Ionicons name="refresh" size={19} color={colors.primary} /></Pressable></View>
          {loading && topups.length === 0 ? <ActivityIndicator style={styles.loader} color={colors.primary} /> : null}
          {topups.length === 0 && !loading ? <View style={styles.empty}><Text style={styles.emptyText}>还没有充值记录</Text></View> : topups.map((topup) => <View key={topup.id} style={styles.record}>
            <View style={styles.recordIcon}><Ionicons name={topup.provider === 'alipay' ? 'logo-alipay' : 'logo-wechat'} size={22} color={colors.primary} /></View>
            <View style={styles.recordCopy}><Text style={styles.recordTitle}>¥{topup.amountCny} · {creditAmount(topup.creditAmount)} 卡时</Text><Text style={styles.recordMeta}>{dateTime(topup.createdAt)} · {statusLabel[topup.status]}</Text></View>
            {topup.status === 'pending' && new Date(topup.expiresAt).getTime() > Date.now() ? <Pressable disabled={busy} onPress={() => void resume(topup)} style={styles.resume}><Text style={styles.resumeText}>继续</Text></Pressable> : null}
          </View>)}
        </> : <View style={styles.managedAccount}>
          <View style={styles.managedIcon}><Ionicons name="business-outline" size={23} color={colors.primary} /></View>
          <View style={styles.managedCopy}><Text style={styles.managedTitle}>账户余额</Text><Text style={styles.managedText}>此版本用于查看余额和管理已有服务，不提供充值或新增购买。</Text></View>
        </View>}
      </ScrollView>
    </View></View>
  </Modal>;
}

function BalanceFact({ label, value }: Readonly<{ label: string; value: string }>) { return <View><Text style={styles.factLabel}>{label}</Text><Text style={styles.factValue}>{value}</Text></View>; }
function ProviderChoice({ label, icon, active, enabled, onPress }: Readonly<{ label: string; icon: 'logo-alipay' | 'logo-wechat'; active: boolean; enabled: boolean; onPress: () => void }>) { return <Pressable disabled={!enabled} onPress={onPress} style={[styles.provider, active && styles.providerActive, !enabled && styles.providerDisabled]}><Ionicons name={icon} size={22} color={active ? colors.primary : colors.muted} /><Text style={[styles.providerText, active && styles.providerTextActive]}>{label}</Text>{!enabled ? <Text style={styles.unavailable}>未接通</Text> : null}</Pressable>; }

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.42)' }, sheet: { height: '94%', borderTopLeftRadius: 30, borderTopRightRadius: 30, overflow: 'hidden', backgroundColor: colors.canvas }, handle: { width: 42, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 9, backgroundColor: '#D0D5DD' },
  header: { minHeight: 76, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, eyebrow: { color: colors.primary, fontSize: 9, fontWeight: '900', letterSpacing: 1.4 }, title: { color: colors.ink, fontSize: 25, fontWeight: '900', marginTop: 3 }, close: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  content: { padding: 17, paddingBottom: 40 }, balanceCard: { padding: 20, borderRadius: 24, borderWidth: 1, borderColor: '#D5E5FA', backgroundColor: colors.surface }, balanceLabel: { color: colors.muted, fontSize: 10 }, balanceValue: { color: colors.primaryDark, fontSize: 39, fontWeight: '900', letterSpacing: -1, marginTop: 5 }, balanceUnit: { color: colors.primary, fontSize: 11, marginTop: 1 }, balanceDivider: { height: 1, backgroundColor: colors.line, marginVertical: 17 }, balanceFacts: { flexDirection: 'row', gap: 60 }, factLabel: { color: colors.muted, fontSize: 9 }, factValue: { color: colors.ink, fontSize: 17, fontWeight: '900', marginTop: 4 },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: '900', marginTop: 23 }, sectionHelp: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 5 }, amountGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 13 }, amount: { width: '48.5%', minHeight: 70, padding: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 16, backgroundColor: colors.surface }, amountActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft }, amountText: { color: colors.ink, fontSize: 17, fontWeight: '900' }, amountTextActive: { color: colors.primaryDark }, amountCredit: { color: colors.muted, fontSize: 9, marginTop: 6 }, amountCreditActive: { color: colors.primary },
  providers: { flexDirection: 'row', gap: 9, marginTop: 13 }, provider: { flex: 1, minHeight: 54, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: colors.line, borderRadius: 16, backgroundColor: colors.surface }, providerActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft }, providerDisabled: { opacity: 0.52 }, providerText: { flex: 1, color: colors.muted, fontSize: 11, fontWeight: '800' }, providerTextActive: { color: colors.primaryDark }, unavailable: { color: colors.subtle, fontSize: 8 },
  conversion: { padding: 15, marginTop: 13, borderRadius: 17, backgroundColor: colors.surface }, conversionLabel: { color: colors.muted, fontSize: 9 }, conversionValue: { color: colors.primaryDark, fontSize: 18, fontWeight: '900', marginTop: 5 }, conversionRule: { color: colors.subtle, fontSize: 9, marginTop: 5 }, notice: { flexDirection: 'row', gap: 8, padding: 11, marginTop: 12, borderRadius: 14, backgroundColor: colors.amberSoft }, noticeText: { flex: 1, color: colors.ink, fontSize: 10, lineHeight: 16 },
  primary: { minHeight: 53, marginTop: 13, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 13, fontWeight: '900' }, disabled: { opacity: 0.45 }, safety: { color: colors.muted, fontSize: 9, lineHeight: 15, textAlign: 'center', marginTop: 10 },
  managedAccount: { minHeight: 88, marginTop: 18, padding: 15, borderRadius: 18, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primarySoft }, managedIcon: { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, managedCopy: { flex: 1, marginLeft: 12 }, managedTitle: { color: colors.primaryDark, fontSize: 14, fontWeight: '900' }, managedText: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 4 },
  historyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, loader: { marginTop: 20 }, empty: { padding: 22, marginTop: 12, borderRadius: 17, alignItems: 'center', backgroundColor: colors.surface }, emptyText: { color: colors.muted, fontSize: 11 }, record: { minHeight: 72, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.line }, recordIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, recordCopy: { flex: 1, marginLeft: 11 }, recordTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' }, recordMeta: { color: colors.muted, fontSize: 9, marginTop: 5 }, resume: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 11, backgroundColor: colors.primarySoft }, resumeText: { color: colors.primary, fontSize: 10, fontWeight: '900' },
});
