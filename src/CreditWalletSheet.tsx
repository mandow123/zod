import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  listCreditTopups, loadCreditTopup,
  type CreditBalance, type CreditTopup,
} from './api';
import { colors } from './theme';
import { distributionPolicy } from './distribution';
import { creditAmount, cnyPrice } from './format';
import { topupQuote } from './topup-checkout';
import { LOCAL_E2E_DEMO_ENABLED } from './api-client';

const topupWalletEnabled = distributionPolicy.nativeTopups || LOCAL_E2E_DEMO_ENABLED;

const statusPresentation: Record<CreditTopup['status'], Readonly<{ label: string; detail: string; icon: keyof typeof Ionicons.glyphMap }>> = {
  created: { label: '准备收银台', detail: '支付订单已经创建，等待真实收银台继续处理。', icon: 'card-outline' },
  pending: { label: '处理中', detail: '支付结果正在由服务端确认，请勿重复支付。', icon: 'time-outline' },
  succeeded: { label: '到账成功', detail: '服务端已经确认入账，卡时余额已更新。', icon: 'checkmark-circle-outline' },
  failed: { label: '未完成', detail: '本次支付未完成，没有增加卡时。', icon: 'alert-circle-outline' },
  expired: { label: '未完成', detail: '收银台已失效，没有增加卡时。', icon: 'alert-circle-outline' },
  cancelled: { label: '已取消', detail: '订单已取消，没有增加卡时。', icon: 'close-circle-outline' },
  manual_review: { label: '人工核对', detail: '订单正在人工核对，核对完成前不会增加卡时。', icon: 'shield-checkmark-outline' },
};

function dateTime(value: string) { const date = new Date(value); return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }
function topupProviderLabel(provider: CreditTopup['provider']) { return provider === 'alipay' ? '支付宝' : '微信支付'; }

export function CreditWalletSheet({ visible, balance, onClose, onChanged, onOpenSupport }: Readonly<{
  visible: boolean;
  balance: CreditBalance | null;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  onOpenSupport: () => void;
}>) {
  const [topups, setTopups] = useState<CreditTopup[]>([]);
  const [amountInput, setAmountInput] = useState('100.00');
  const [selectedTopup, setSelectedTopup] = useState<CreditTopup | null>(null);
  const [loading, setLoading] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await listCreditTopups();
      setTopups(next);
      setSelectedTopup((current) => current ? next.find((item) => item.id === current.id) ?? current : null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '充值记录暂时无法读取。');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (visible && topupWalletEnabled) void refresh(); }, [refresh, visible]);
  useEffect(() => {
    if (!visible || !topupWalletEnabled) return undefined;
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') void refresh(); });
    return () => subscription.remove();
  }, [refresh, visible]);

  const quote = useMemo(() => topupQuote(amountInput), [amountInput]);

  const querySelected = async () => {
    if (!selectedTopup) return;
    setQuerying(true); setError(null);
    try {
      const latest = await loadCreditTopup(selectedTopup.id);
      setSelectedTopup(latest);
      setTopups((current) => [latest, ...current.filter((item) => item.id !== latest.id)]);
      if (latest.status === 'succeeded') await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '暂时无法查询这笔充值。');
    } finally { setQuerying(false); }
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

        {topupWalletEnabled ? selectedTopup ? <TopupStatusPanel
          topup={selectedTopup}
          querying={querying}
          error={error}
          onBack={() => { setSelectedTopup(null); setError(null); }}
          onQuery={() => void querySelected()}
          onSupport={onOpenSupport}
        /> : <>
          <Text style={styles.sectionTitle}>充值卡时</Text>
          <Text style={styles.sectionHelp}>输入本次实付金额，服务端确认支付结果后卡时才会入账。</Text>

          <View style={styles.rateCard}>
            <View style={styles.rateIcon}><Ionicons name="swap-horizontal" size={20} color={colors.primary} /></View>
            <View style={styles.rateCopy}><Text style={styles.rateLabel}>固定汇率</Text><Text style={styles.rateValue}>1 卡时 = 1.002 元</Text></View>
            <Text style={styles.rateLock}>不可编辑</Text>
          </View>

          <Text style={styles.fieldLabel}>实付金额（元）</Text>
          <View style={[styles.amountField, quote.error && styles.amountFieldError]}>
            <TextInput
              accessibilityLabel="实付金额"
              value={amountInput}
              onChangeText={(value) => { setAmountInput(value); setError(null); }}
              keyboardType="decimal-pad"
              placeholder="1.00–100000.00"
              placeholderTextColor={colors.subtle}
              style={styles.amountInput}
            />
            <Text style={styles.currency}>元</Text>
          </View>
          {quote.error ? <Text style={styles.validation}>{quote.error}</Text> : null}

          <View style={styles.quoteCard}>
            <Text style={styles.quoteLabel}>预计到账</Text>
            <Text style={styles.quoteValue}>{quote.cardHours ?? '—'} <Text style={styles.quoteUnit}>KAI 卡时</Text></Text>
            <Text style={styles.quoteHelp}>预估结果仅供收银确认，最终以服务端报价与支付确认结果为准。</Text>
          </View>

          <Text style={styles.fieldLabel}>支付方式</Text>
          <View style={styles.providerCard}>
            <View style={styles.providerIcon}><Ionicons name="card-outline" size={21} color={colors.primary} /></View>
            <View style={styles.providerCopy}><Text style={styles.providerTitle}>快线支付</Text><Text style={styles.providerHint}>支付通道接入中</Text></View>
            <View style={styles.providerTag}><Text style={styles.providerTagText}>暂未开放</Text></View>
          </View>

          <Pressable accessibilityRole="button" accessibilityState={{ disabled: true }} disabled style={[styles.primary, styles.disabled]}>
            <Text style={styles.primaryText}>支付通道接入中</Text>
          </Pressable>
          <Text style={styles.safety}>通道接通前不会生成支付单、跳转收银台或模拟到账。</Text>

          <View style={styles.historyHeader}><Text style={styles.sectionTitle}>充值记录</Text><Pressable accessibilityLabel="刷新充值记录" onPress={() => void refresh()}><Ionicons name="refresh" size={19} color={colors.primary} /></Pressable></View>
          {loading && topups.length === 0 ? <ActivityIndicator style={styles.loader} color={colors.primary} /> : null}
          {error ? <View style={styles.notice}><Ionicons name="information-circle-outline" size={18} color={colors.amber} /><Text style={styles.noticeText}>{error}</Text></View> : null}
          {topups.length === 0 && !loading ? <View style={styles.empty}><Text style={styles.emptyText}>还没有充值记录</Text></View> : topups.map((topup) => <Pressable key={topup.id} onPress={() => { setSelectedTopup(topup); setError(null); }} style={styles.record}>
            <View style={styles.recordIcon}><Ionicons name={statusPresentation[topup.status].icon} size={22} color={colors.primary} /></View>
            <View style={styles.recordCopy}><Text style={styles.recordTitle}>{creditAmount(topup.creditAmount)} 卡时</Text><Text style={styles.recordMeta}>{dateTime(topup.createdAt)} · {statusPresentation[topup.status].label}</Text></View>
            <Ionicons name="chevron-forward" size={18} color={colors.subtle} />
          </Pressable>)}
        </> : <View style={styles.managedAccount}>
          <View style={styles.managedIcon}><Ionicons name="business-outline" size={23} color={colors.primary} /></View>
          <View style={styles.managedCopy}><Text style={styles.managedTitle}>账户余额</Text><Text style={styles.managedText}>此版本用于查看余额和管理已有服务，不提供充值或新增购买。</Text></View>
        </View>}
      </ScrollView>
    </View></View>
  </Modal>;
}

function BalanceFact({ label, value }: Readonly<{ label: string; value: string }>) { return <View><Text style={styles.factLabel}>{label}</Text><Text style={styles.factValue}>{value}</Text></View>; }

function TopupStatusPanel({ topup, querying, error, onBack, onQuery, onSupport }: Readonly<{
  topup: CreditTopup;
  querying: boolean;
  error: string | null;
  onBack: () => void;
  onQuery: () => void;
  onSupport: () => void;
}>) {
  const presentation = statusPresentation[topup.status];
  const successful = topup.status === 'succeeded';
  return <View style={styles.statusSection}>
    <View style={[styles.statusIcon, successful && styles.statusIconSuccess]}><Ionicons name={presentation.icon} size={30} color={successful ? colors.green : colors.primary} /></View>
    <Text style={styles.statusTitle}>{presentation.label}</Text>
    <Text style={styles.statusDetail}>{topup.recovery?.message ?? presentation.detail}</Text>
    <View style={styles.statusAmount}>
      <Text style={styles.statusAmountLabel}>本次卡时</Text><Text style={styles.statusAmountValue}>{creditAmount(topup.creditAmount)} KAI 卡时</Text>
      <View style={styles.statusDivider} />
      <Text style={styles.statusMeta}>实付 {cnyPrice(topup.amountCny)} 元 · {topupProviderLabel(topup.provider)}</Text>
      <Text style={styles.statusMeta}>创建于 {dateTime(topup.createdAt)}</Text>
    </View>
    {error ? <View style={styles.notice}><Ionicons name="information-circle-outline" size={18} color={colors.amber} /><Text style={styles.noticeText}>{error}</Text></View> : null}
    <Pressable disabled={querying} onPress={onQuery} style={[styles.primary, querying && styles.disabled]}>{querying ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>重新查询</Text>}</Pressable>
    <View style={styles.secondaryActions}>
      <Pressable onPress={onBack} style={styles.secondary}><Text style={styles.secondaryText}>返回卡时</Text></Pressable>
      <Pressable onPress={onSupport} style={styles.secondary}><Text style={styles.secondaryText}>联系客服</Text></Pressable>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.42)' }, sheet: { height: '94%', borderTopLeftRadius: 30, borderTopRightRadius: 30, overflow: 'hidden', backgroundColor: colors.canvas }, handle: { width: 42, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 9, backgroundColor: '#D0D5DD' },
  header: { minHeight: 76, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, eyebrow: { color: colors.primary, fontSize: 9, fontWeight: '900', letterSpacing: 1.4 }, title: { color: colors.ink, fontSize: 25, fontWeight: '900', marginTop: 3 }, close: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  content: { padding: 17, paddingBottom: 40 }, balanceCard: { padding: 20, borderRadius: 24, borderWidth: 1, borderColor: '#D5E5FA', backgroundColor: colors.surface }, balanceLabel: { color: colors.muted, fontSize: 10 }, balanceValue: { color: colors.primaryDark, fontSize: 39, fontWeight: '900', letterSpacing: -1, marginTop: 5 }, balanceUnit: { color: colors.primary, fontSize: 11, marginTop: 1 }, balanceDivider: { height: 1, backgroundColor: colors.line, marginVertical: 17 }, balanceFacts: { flexDirection: 'row', gap: 60 }, factLabel: { color: colors.muted, fontSize: 9 }, factValue: { color: colors.ink, fontSize: 17, fontWeight: '900', marginTop: 4 },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: '900', marginTop: 23 }, sectionHelp: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 5 }, notice: { flexDirection: 'row', gap: 8, padding: 11, marginTop: 12, borderRadius: 14, backgroundColor: colors.amberSoft }, noticeText: { flex: 1, color: colors.ink, fontSize: 10, lineHeight: 16 },
  primary: { minHeight: 53, marginTop: 13, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 13, fontWeight: '900' }, disabled: { opacity: 0.45 }, safety: { color: colors.muted, fontSize: 9, lineHeight: 15, textAlign: 'center', marginTop: 10 },
  managedAccount: { minHeight: 88, marginTop: 18, padding: 15, borderRadius: 18, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primarySoft }, managedIcon: { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, managedCopy: { flex: 1, marginLeft: 12 }, managedTitle: { color: colors.primaryDark, fontSize: 14, fontWeight: '900' }, managedText: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 4 },
  historyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, loader: { marginTop: 20 }, empty: { padding: 22, marginTop: 12, borderRadius: 17, alignItems: 'center', backgroundColor: colors.surface }, emptyText: { color: colors.muted, fontSize: 11 }, record: { minHeight: 72, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.line }, recordIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, recordCopy: { flex: 1, marginLeft: 11 }, recordTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' }, recordMeta: { color: colors.muted, fontSize: 9, marginTop: 5 },
  rateCard: { minHeight: 70, marginTop: 14, padding: 14, flexDirection: 'row', alignItems: 'center', borderRadius: 18, borderWidth: 1, borderColor: '#D5E5FA', backgroundColor: colors.surface }, rateIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, rateCopy: { flex: 1, marginLeft: 11 }, rateLabel: { color: colors.muted, fontSize: 9 }, rateValue: { color: colors.ink, fontSize: 16, fontWeight: '900', marginTop: 4 }, rateLock: { color: colors.subtle, fontSize: 9 },
  fieldLabel: { color: colors.ink, fontSize: 12, fontWeight: '800', marginTop: 18, marginBottom: 8 }, amountField: { minHeight: 62, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', borderRadius: 18, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }, amountFieldError: { borderColor: colors.red }, currency: { color: colors.muted, fontSize: 14, fontWeight: '800' }, amountInput: { flex: 1, color: colors.ink, fontSize: 26, fontWeight: '900', paddingVertical: 13 }, validation: { color: colors.red, fontSize: 9, lineHeight: 15, marginTop: 6 },
  quoteCard: { marginTop: 12, padding: 16, borderRadius: 18, backgroundColor: colors.primarySoft }, quoteLabel: { color: colors.muted, fontSize: 9 }, quoteValue: { color: colors.primaryDark, fontSize: 25, fontWeight: '900', marginTop: 5 }, quoteUnit: { fontSize: 11, fontWeight: '800' }, quoteHelp: { color: colors.muted, fontSize: 9, lineHeight: 15, marginTop: 8 },
  providerCard: { minHeight: 70, padding: 14, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.line, borderRadius: 18, backgroundColor: colors.surface }, providerIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, providerCopy: { flex: 1, marginLeft: 11 }, providerTitle: { color: colors.ink, fontSize: 14, fontWeight: '900' }, providerHint: { color: colors.muted, fontSize: 9, marginTop: 4 }, providerTag: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 10, backgroundColor: colors.amberSoft }, providerTagText: { color: colors.amber, fontSize: 8, fontWeight: '800' },
  statusSection: { marginTop: 20, alignItems: 'center' }, statusIcon: { width: 64, height: 64, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, statusIconSuccess: { backgroundColor: colors.greenSoft }, statusTitle: { color: colors.ink, fontSize: 23, fontWeight: '900', marginTop: 14 }, statusDetail: { color: colors.muted, fontSize: 11, lineHeight: 18, textAlign: 'center', marginTop: 7, paddingHorizontal: 20 }, statusAmount: { alignSelf: 'stretch', padding: 17, marginTop: 18, borderRadius: 19, backgroundColor: colors.surface }, statusAmountLabel: { color: colors.muted, fontSize: 9 }, statusAmountValue: { color: colors.ink, fontSize: 20, fontWeight: '900', marginTop: 5 }, statusDivider: { height: 1, backgroundColor: colors.line, marginVertical: 13 }, statusMeta: { color: colors.muted, fontSize: 9, lineHeight: 17 }, secondaryActions: { alignSelf: 'stretch', flexDirection: 'row', gap: 9, marginTop: 9 }, secondary: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line, borderRadius: 15, backgroundColor: colors.surface }, secondaryText: { color: colors.ink, fontSize: 11, fontWeight: '800' },
});
