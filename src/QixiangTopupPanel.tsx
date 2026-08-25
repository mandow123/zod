import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, Linking, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { loadLegalBootstrap } from './api';
import {
  createOrReplayQixiangTopup, createQixiangBrowserReturnCoordinator,
  listQixiangTopupsWhenEnabled, loadQixiangTopupWhenEnabled,
  observeQixiangBrowserReturn, recoverQixiangTopup, recheckQixiangTopupByUser,
} from './qixiang-topup-flow.ts';
import { qixiangSubjectFingerprint } from './qixiang-topup-persistence';
import { qixiangTopupRuntime } from './qixiang-topup-runtime';
import {
  assertQixiangCheckoutUrl, qixiangAmount, qixiangAmountInputCents, type QixiangCheckout,
  type QixiangCreationPolicy, type QixiangReadinessGateInput, type QixiangTopup,
  type QixiangTopupCapability,
} from './qixiang-topups.ts';
import { colors, ledgerActionButton, ledgerActionText } from './theme';

type Props = Readonly<{
  visible: boolean;
  capability: QixiangTopupCapability;
  userId: string | null;
  subjectId: string | null;
  onChanged: () => void | Promise<void>;
  onOpenSupport: () => void;
}>;

const statusCopy: Readonly<Record<QixiangTopup['status'], Readonly<{
  title: string; detail: string; icon: keyof typeof Ionicons.glyphMap;
}>>> = {
  created: { title: '等待支付', detail: '支付单已创建，卡时尚未到账。', icon: 'card-outline' },
  pending: { title: '支付待确认', detail: '七相支付正在处理，卡时尚未到账。', icon: 'time-outline' },
  verifying: { title: '服务端核对中', detail: '服务端正在核对支付结果，卡时尚未到账。', icon: 'shield-checkmark-outline' },
  succeeded: { title: '到账成功', detail: '服务端已确认支付并完成卡时入账。', icon: 'checkmark-circle-outline' },
  failed: { title: '支付未完成', detail: '服务端确认本次支付失败，没有增加卡时。', icon: 'alert-circle-outline' },
  expired: { title: '收银台已过期', detail: '该支付单仍保留，以服务端后续状态为准。', icon: 'time-outline' },
  manual_review: { title: '人工核对中', detail: '核对完成前不会增加卡时。', icon: 'people-outline' },
};

const TOPUP_PACKAGES = [
  { amountCents: 5_000, label: '轻量' },
  { amountCents: 10_000, label: '常用' },
  { amountCents: 30_000, label: '进阶' },
  { amountCents: 50_000, label: '畅用' },
  { amountCents: 100_000, label: '大额' },
] as const;

function gateFor(capability: QixiangTopupCapability): QixiangReadinessGateInput {
  return { authenticated: true, readiness: {
    profile: { id: 'full_commerce', routePolicy: 'full-commerce-v1' },
    release: { ready: true }, capabilities: { qixiangTopups: capability },
  } };
}

function dateTime(value: string) {
  const date = new Date(value);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function errorMessage(reason: unknown) {
  if (reason instanceof Error && reason.message === 'QIXIANG_PENDING_SUBJECT_MISMATCH') {
    return '检测到其他主体未完成的支付记录。为保护账户，当前主体不能读取、重放或清除该记录。';
  }
  if (reason instanceof Error && reason.message.includes('QIXIANG_PENDING')) {
    return '本机支付恢复记录无法安全确认。记录已原样保留，请联系客服处理后再试。';
  }
  return reason instanceof Error && !reason.message.startsWith('QIXIANG_')
    ? reason.message : '支付服务暂时无法读取，请稍后重试。';
}

export function QixiangTopupPanel({
  visible, capability, userId, subjectId, onChanged, onOpenSupport,
}: Props) {
  const minimum = capability.minAmountCents ?? 1;
  const maximum = capability.maxAmountCents ?? minimum;
  const initialAmount = qixiangAmount(Math.min(maximum, Math.max(minimum, 10_000)));
  const packages = useMemo(() => capability.canaryOnly ? [] : TOPUP_PACKAGES.filter(
    (item) => item.amountCents >= minimum && item.amountCents <= maximum,
  ), [capability.canaryOnly, maximum, minimum]);
  const gate = useMemo(() => gateFor(capability), [capability]);
  const contextKey = `${userId ?? ''}\u0000${subjectId ?? ''}`;
  const [amountInput, setAmountInput] = useState(initialAmount);
  const [operatorName, setOperatorName] = useState<string | null>(null);
  const [items, setItems] = useState<readonly QixiangTopup[]>([]);
  const [creation, setCreation] = useState<QixiangCreationPolicy | null>(null);
  const [selected, setSelected] = useState<QixiangTopup | null>(null);
  const [checkout, setCheckout] = useState<QixiangCheckout | null>(null);
  const [pendingTopupId, setPendingTopupId] = useState<string | null>(null);
  const [unresolvedCreate, setUnresolvedCreate] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fingerprintRef = useRef<string | null>(null);
  const contextKeyRef = useRef(contextKey);
  const bootstrapGenerationRef = useRef(0);
  const browserAttemptRef = useRef<number | null>(null);
  const browserReturnCoordinatorRef = useRef(createQixiangBrowserReturnCoordinator());
  const appWasAwayRef = useRef(false);
  const returnCheckRef = useRef(false);
  contextKeyRef.current = contextKey;

  const publishDetail = useCallback(async (
    result: Readonly<{ topup: QixiangTopup; checkout: QixiangCheckout | null; pending?: { topupId: string | null } | null }>,
  ) => {
    if (contextKeyRef.current !== contextKey) return;
    setSelected(result.topup); setCheckout(result.checkout);
    setItems((current) => [result.topup, ...current.filter((item) => item.id !== result.topup.id)]);
    if (result.pending !== undefined) setPendingTopupId(result.pending?.topupId ?? null);
    if (result.topup.status === 'succeeded' || result.topup.status === 'failed') browserAttemptRef.current = null;
    if (result.topup.status === 'succeeded') {
      try { await onChanged(); } catch { /* The decoded server status remains authoritative. */ }
    }
  }, [contextKey, onChanged]);

  const bootstrap = useCallback(async () => {
    if (!visible) return;
    const generation = bootstrapGenerationRef.current + 1;
    bootstrapGenerationRef.current = generation;
    fingerprintRef.current = null;
    browserAttemptRef.current = null;
    setItems([]); setCreation(null); setSelected(null); setCheckout(null);
    setPendingTopupId(null); setUnresolvedCreate(false); setConfirming(false);
    setLoading(true); setBlocked(false); setError(null); setOperatorName(null);
    try {
      if (!userId || !subjectId) throw new Error('当前交易主体还不能安全确认。');
      const fingerprint = await qixiangSubjectFingerprint(userId, subjectId);
      if (bootstrapGenerationRef.current !== generation || contextKeyRef.current !== contextKey) return;
      fingerprintRef.current = fingerprint;
      const recovered = await recoverQixiangTopup(gate, fingerprint, qixiangTopupRuntime);
      if (bootstrapGenerationRef.current !== generation || contextKeyRef.current !== contextKey) return;
      if (recovered.kind === 'create_unresolved') {
        setUnresolvedCreate(true); setPendingTopupId(null);
        setAmountInput(qixiangAmount(recovered.pending.amountCents));
      } else if (recovered.kind === 'loaded') {
        setUnresolvedCreate(false);
        await publishDetail(recovered);
      } else {
        setUnresolvedCreate(false); setPendingTopupId(null);
      }
      const legal = await loadLegalBootstrap();
      if (bootstrapGenerationRef.current !== generation || contextKeyRef.current !== contextKey) return;
      setOperatorName(legal.operator.legalEntityName);
      const page = await listQixiangTopupsWhenEnabled(gate, null, qixiangTopupRuntime);
      if (bootstrapGenerationRef.current !== generation || contextKeyRef.current !== contextKey) return;
      setItems(page.items); setCreation(page.creation);
      if(page.creation.canaryOnly&&page.creation.requiredAmountCents===501)setAmountInput(qixiangAmount(501));
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      if (reason instanceof Error && (reason.message.includes('QIXIANG_PENDING')
        || reason.message === '当前交易主体还不能安全确认。')) setBlocked(true);
    } finally {
      if (bootstrapGenerationRef.current === generation && contextKeyRef.current === contextKey) setLoading(false);
    }
  }, [contextKey, gate, publishDetail, subjectId, userId, visible]);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  const observeReturn = useCallback(async (attempt = browserAttemptRef.current) => {
    const fingerprint = fingerprintRef.current;
    if (!fingerprint) return;
    const action = async () => {
      if (returnCheckRef.current) return;
      returnCheckRef.current = true; setBusy(true); setError(null);
      try {
        const result = attempt !== null
          ? await observeQixiangBrowserReturn(gate, fingerprint, qixiangTopupRuntime)
          : await recoverQixiangTopup(gate, fingerprint, qixiangTopupRuntime);
        if (result.kind === 'loaded') await publishDetail(result);
        else if (result.kind === 'create_unresolved') setUnresolvedCreate(true);
      } catch (reason) { setError(errorMessage(reason)); throw reason; }
      finally { returnCheckRef.current = false; setBusy(false); }
    };
    if (attempt !== null) {
      try { await browserReturnCoordinatorRef.current.observe(attempt, action); } catch { /* error is shown by action */ }
      return;
    }
    try { await action(); } catch { /* error is shown by action */ }
  }, [gate, publishDetail]);

  useEffect(() => {
    if (!visible) return undefined;
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'inactive' || state === 'background') appWasAwayRef.current = true;
      if (state === 'active' && appWasAwayRef.current) {
        appWasAwayRef.current = false; void observeReturn();
      }
    });
    const linking = Linking.addEventListener('url', () => {
      if (browserAttemptRef.current !== null) void observeReturn();
    });
    return () => { appState.remove(); linking.remove(); };
  }, [observeReturn, visible]);

  const openCheckout = useCallback(async (nextCheckout: QixiangCheckout) => {
    const safeUrl = assertQixiangCheckoutUrl(nextCheckout.url);
    const attempt = browserReturnCoordinatorRef.current.begin();
    browserAttemptRef.current = attempt; appWasAwayRef.current = false; setError(null);
    try {
      await WebBrowser.openBrowserAsync(safeUrl, { createTask: false, showTitle: true });
      await observeReturn(attempt);
    } catch { setError('系统浏览器暂时无法打开。支付状态仍以服务端记录为准。'); }
  }, [observeReturn]);

  const create = useCallback(async () => {
    if (!operatorName || !fingerprintRef.current || busy || blocked) return;
    let amountCents: number;
    try { amountCents = qixiangAmountInputCents(amountInput, minimum, maximum); }
    catch { setError(`请输入 ${qixiangAmount(minimum)}–${qixiangAmount(maximum)} 元，保留两位小数。`); return; }
    setBusy(true); setError(null);
    try {
      const result = await createOrReplayQixiangTopup(
        gate, fingerprintRef.current, amountCents, qixiangTopupRuntime,
      );
      setUnresolvedCreate(false); setConfirming(false);
      await publishDetail(result);
      if (result.checkout) await openCheckout(result.checkout);
    } catch (reason) {
      setUnresolvedCreate(true);
      setError(reason instanceof Error && reason.message.includes('NETWORK')
        ? '创建结果暂时不明。记录已安全保留，点击继续会复用同一请求，不会新建第二笔。'
        : errorMessage(reason));
    } finally { setBusy(false); }
  }, [amountInput, blocked, busy, gate, maximum, minimum, openCheckout, operatorName, publishDetail]);

  const selectTopup = useCallback(async (topup: QixiangTopup) => {
    setBusy(true); setError(null);
    try {
      const result = await loadQixiangTopupWhenEnabled(gate, topup.id, qixiangTopupRuntime);
      await publishDetail(result);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }, [gate, publishDetail]);

  const recheck = useCallback(async () => {
    if (!selected || !fingerprintRef.current || unresolvedCreate
      || (pendingTopupId !== null && pendingTopupId !== selected.id) || busy) return;
    setBusy(true); setError(null);
    try {
      const rechecked = await recheckQixiangTopupByUser(
        gate, fingerprintRef.current, selected, qixiangTopupRuntime,
      );
      await publishDetail({ ...rechecked, checkout: null });
      const result = await loadQixiangTopupWhenEnabled(gate, selected.id, qixiangTopupRuntime);
      await publishDetail(result);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }, [busy, gate, pendingTopupId, publishDetail, selected, unresolvedCreate]);

  if (loading && items.length === 0 && !selected) return <ActivityIndicator style={styles.loader} color={colors.primary} />;

  if (selected) {
    const presentation = statusCopy[selected.status];
    const canRecheck = selected.allowedActions.includes('recheck') && !unresolvedCreate
      && (pendingTopupId === null || pendingTopupId === selected.id);
    return <View style={styles.section}>
      <Pressable onPress={() => { setSelected(null); setCheckout(null); setError(null); }} style={styles.back}>
        <Ionicons name="arrow-back" size={18} color={colors.primary} /><Text style={styles.backText}>返回卡时</Text>
      </Pressable>
      <View style={[styles.statusIcon, selected.status === 'succeeded' && styles.statusSuccess]}>
        <Ionicons name={presentation.icon} size={29} color={selected.status === 'succeeded' ? colors.green : colors.primary} />
      </View>
      <Text style={styles.statusTitle}>{presentation.title}</Text><Text style={styles.statusDetail}>{presentation.detail}</Text>
      <View style={styles.summaryCard}>
        <Summary label="实付" value={`¥ ${selected.payment.amount}`} />
        <Summary label="卡时" value={`${selected.credit.amount} KAI 卡时`} />
        <Summary label="通道" value="七相支付（支付宝）" />
        <Text style={styles.meta}>创建于 {dateTime(selected.createdAt)}</Text>
      </View>
      {error ? <Notice text={error} /> : null}
      {checkout ? <Pressable disabled={busy} onPress={() => void openCheckout(checkout)} style={[styles.primary, busy && styles.disabled]}><Text style={styles.primaryText}>打开七相支付</Text></Pressable> : null}
      {canRecheck ? <Pressable disabled={busy} onPress={() => void recheck()} style={[styles.primary, busy && styles.disabled]}>{busy ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.primaryText}>重新核对</Text>}</Pressable> : null}
      <Pressable onPress={onOpenSupport} style={styles.secondary}><Text style={styles.secondaryText}>联系客服</Text></Pressable>
      <Text style={styles.disclosure}>返回 App、关闭浏览器或收到链接都不代表支付成功；页面只读取服务端支付状态。</Text>
    </View>;
  }

  if (confirming || unresolvedCreate) {
    let amountCents: number | null = null;
    try { amountCents = qixiangAmountInputCents(amountInput, minimum, maximum); } catch { /* rendered below */ }
    return <View style={styles.section}>
      {!unresolvedCreate ? <Pressable disabled={busy} onPress={() => setConfirming(false)} style={styles.back}><Ionicons name="arrow-back" size={18} color={colors.primary} /><Text style={styles.backText}>返回卡时</Text></Pressable> : null}
      <Text style={styles.eyebrow}>七相支付</Text><Text style={styles.title}>{unresolvedCreate ? '继续未完成的支付' : '确认支付'}</Text>
      <View style={styles.summaryCard}>
        <Summary label="运营主体" value={operatorName ?? '主体信息暂时无法读取'} />
        <Summary label="实付" value={`¥ ${amountInput}`} />
        <Summary label="预计卡时" value={amountCents ? `${qixiangAmount(Math.floor((amountCents * 1000) / 1002))} KAI 卡时` : '—'} />
        <Summary label="支付通道" value="七相支付（支付宝）" />
      </View>
      <View style={styles.rules}>
        <Text style={styles.rule}>换算快照：实付金额按 1.002 向下取整到两位</Text>
        <Text style={styles.rule}>到账卡时有效期 364 天；不可转让，不可提现或兑换现金</Text>
        <Text style={styles.rule}>退款以服务端支付状态和适用规则为准；需要协助请联系客服</Text>
      </View>
      {error ? <Notice text={error} /> : null}
      <Pressable disabled={busy || !operatorName || amountCents === null} onPress={() => void create()} style={[styles.primary, (busy || !operatorName || amountCents === null) && styles.disabled]}>{busy ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.primaryText}>{unresolvedCreate ? '继续原支付请求' : '确认并前往支付宝'}</Text>}</Pressable>
      <Pressable onPress={onOpenSupport} style={styles.secondary}><Text style={styles.secondaryText}>退款与客服说明</Text></Pressable>
    </View>;
  }

  return <View style={styles.section}>
    <Text style={styles.sectionTitle}>充值卡时</Text><Text style={styles.help}>支付通道：七相支付（支付宝）</Text>
    {packages.length > 0 ? <><Text style={styles.fieldLabel}>充值套餐</Text><View style={styles.packageGrid}>{packages.map((item) => {
      const selectedPackage = amountInput === qixiangAmount(item.amountCents);
      return <Pressable key={item.amountCents} accessibilityRole="button" accessibilityState={{ selected: selectedPackage }}
        accessibilityLabel={`${item.label}套餐 ${qixiangAmount(item.amountCents)}元`}
        onPress={() => { setAmountInput(qixiangAmount(item.amountCents)); setError(null); }}
        style={[styles.packageCard, selectedPackage && styles.packageCardSelected]}>
        <Text style={[styles.packageLabel, selectedPackage && styles.packageLabelSelected]}>{item.label}</Text>
        <Text style={[styles.packageAmount, selectedPackage && styles.packageAmountSelected]}>¥{qixiangAmount(item.amountCents)}</Text>
      </Pressable>;
    })}</View></> : null}
    <Text style={styles.fieldLabel}>{capability.canaryOnly ? '验收金额' : '自定义金额（元）'}</Text>
    <View style={styles.amountField}><TextInput accessibilityLabel="实付金额" value={amountInput}
      onChangeText={(value) => { setAmountInput(value); setError(null); }} keyboardType="decimal-pad"
      editable={!capability.canaryOnly}
      placeholder={`${qixiangAmount(minimum)}–${qixiangAmount(maximum)}`} placeholderTextColor={colors.subtle}
      style={styles.amountInput} /><Text style={styles.currency}>元</Text></View>
    {capability.canaryOnly?<Text style={styles.operator}>生产验收阶段仅允许固定 ¥5.01，金额不可修改。</Text>:null}
    <View style={styles.quoteCard}><Text style={styles.quoteLabel}>预计获得</Text><Text style={styles.quoteValue}>{(() => { try { return `${qixiangAmount(Math.floor((qixiangAmountInputCents(amountInput, minimum, maximum) * 1000) / 1002))} KAI 卡时`; } catch { return '—'; } })()}</Text><Text style={styles.meta}>按 1.002 向下取整到两位 · 有效期 364 天</Text></View>
    {operatorName ? <Text style={styles.operator}>运营主体：{operatorName}</Text> : null}
    {error ? <Notice text={error} /> : null}
    <Pressable disabled={blocked || !operatorName || creation?.allowed !== true} onPress={() => setConfirming(true)} style={[styles.primary, (blocked || !operatorName || creation?.allowed !== true) && styles.disabled]}><Text style={styles.primaryText}>使用七相支付</Text></Pressable>
    {creation?.allowed === false ? <Text style={styles.disclosure}>服务端当前不允许创建新支付；已有记录仍可查看和恢复。</Text> : null}
    <View style={styles.historyHeader}><Text style={styles.sectionTitle}>支付记录</Text><Pressable accessibilityLabel="刷新支付记录" onPress={() => void bootstrap()}><Ionicons name="refresh" size={19} color={colors.primary} /></Pressable></View>
    {items.length === 0 ? <View style={styles.empty}><Text style={styles.emptyText}>还没有支付记录</Text></View> : items.map((item) => <Pressable key={item.id} onPress={() => void selectTopup(item)} style={styles.record}><View style={styles.recordIcon}><Ionicons name={statusCopy[item.status].icon} size={20} color={colors.primary} /></View><View style={styles.recordCopy}><Text style={styles.recordTitle}>{item.credit.amount} KAI 卡时</Text><Text style={styles.meta}>{dateTime(item.createdAt)} · {statusCopy[item.status].title}</Text></View><Ionicons name="chevron-forward" size={17} color={colors.subtle} /></Pressable>)}
  </View>;
}

function Summary({ label, value }: Readonly<{ label: string; value: string }>) {
  return <View style={styles.summaryRow}><Text style={styles.summaryLabel}>{label}</Text><Text style={styles.summaryValue}>{value}</Text></View>;
}

function Notice({ text }: Readonly<{ text: string }>) {
  return <View style={styles.notice}><Ionicons name="information-circle-outline" size={18} color={colors.primary} /><Text style={styles.noticeText}>{text}</Text></View>;
}

const styles = StyleSheet.create({
  section: { gap: 12 }, loader: { marginVertical: 28 }, eyebrow: { color: colors.primary, fontSize: 10, fontWeight: '900', letterSpacing: 1 }, title: { color: colors.ink, fontSize: 22, fontWeight: '900' }, sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '900' }, help: { color: colors.muted, fontSize: 10, marginTop: -6 }, fieldLabel: { color: colors.ink, fontSize: 10, fontWeight: '800', marginTop: 3 }, packageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, packageCard: { width: '31%', minWidth: 88, minHeight: 64, paddingHorizontal: 10, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }, packageCardSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft }, packageLabel: { color: colors.muted, fontSize: 9, fontWeight: '800' }, packageLabelSelected: { color: colors.primary }, packageAmount: { color: colors.ink, fontSize: 14, fontWeight: '900', marginTop: 4 }, packageAmountSelected: { color: colors.primaryDark }, amountField: { minHeight: 56, paddingHorizontal: 14, borderWidth: 1, borderColor: '#B7CEF4', borderRadius: 12, backgroundColor: colors.surface, flexDirection: 'row', alignItems: 'center' }, amountInput: { flex: 1, color: colors.ink, fontSize: 23, fontWeight: '900' }, currency: { color: colors.muted, fontSize: 11 }, quoteCard: { padding: 15, borderRadius: 13, backgroundColor: colors.primarySoft, borderWidth: 1, borderColor: '#D5E5FA' }, quoteLabel: { color: colors.muted, fontSize: 9 }, quoteValue: { color: colors.primaryDark, fontSize: 20, fontWeight: '900', marginTop: 5 }, operator: { color: colors.muted, fontSize: 9, lineHeight: 14 }, primary: { minHeight: 48, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', ...ledgerActionButton }, primaryText: { ...ledgerActionText, fontSize: 12, fontWeight: '900' }, secondary: { minHeight: 44, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: '#B7CEF4' }, secondaryText: { color: colors.primary, fontSize: 11, fontWeight: '900' }, disabled: { opacity: 0.45 }, summaryCard: { padding: 15, gap: 11, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }, summaryRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 }, summaryLabel: { color: colors.muted, fontSize: 10 }, summaryValue: { flex: 1, color: colors.ink, fontSize: 11, fontWeight: '800', textAlign: 'right' }, rules: { padding: 13, gap: 6, borderRadius: 12, backgroundColor: colors.primarySoft }, rule: { color: colors.muted, fontSize: 9, lineHeight: 15 }, notice: { padding: 12, flexDirection: 'row', gap: 8, borderRadius: 11, backgroundColor: colors.primarySoft }, noticeText: { flex: 1, color: colors.muted, fontSize: 9, lineHeight: 14 }, disclosure: { color: colors.muted, fontSize: 9, lineHeight: 15, textAlign: 'center' }, back: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start' }, backText: { color: colors.primary, fontSize: 11, fontWeight: '800' }, statusIcon: { width: 58, height: 58, borderRadius: 19, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', backgroundColor: colors.primarySoft }, statusSuccess: { backgroundColor: colors.greenSoft }, statusTitle: { color: colors.ink, fontSize: 22, fontWeight: '900', textAlign: 'center' }, statusDetail: { color: colors.muted, fontSize: 10, lineHeight: 16, textAlign: 'center' }, meta: { color: colors.muted, fontSize: 9, lineHeight: 14 }, historyHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 5 }, empty: { padding: 20, borderRadius: 12, alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, emptyText: { color: colors.muted, fontSize: 10 }, record: { minHeight: 65, paddingHorizontal: 12, borderRadius: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, recordIcon: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, recordCopy: { flex: 1, marginHorizontal: 10 }, recordTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' },
});
