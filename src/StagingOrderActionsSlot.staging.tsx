import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { CloudPayOrder } from './api';
import { ApiError } from './api-client';
import {
  replayPendingStagingOrderAction, type PendingStagingOrderAction, type StagingOrderMutationAction,
} from './staging-order-action-recovery-core';
import {
  clearConfirmedStagingOrderAction, loadPendingStagingOrderAction, savePendingStagingOrderAction,
} from './staging-order-action-recovery';
import { acquireStagingOrderMutation } from './staging-order-mutation-lock';
import { shouldReloadStagingOrderSlot, type StagingOrderSlotRefresh } from './staging-order-slot-sync';
import { stagingOrderActions, stagingOrderStatus } from './staging-presentation';
import { loadStagingPrincipalFingerprint } from './staging-principal';
import {
  acceptStagingOrder, cancelStagingOrder, disputeStagingOrder, loadStagingAccessPreview, loadStagingOrder,
  requestStagingOrderStop, type StagingAccessPreview, type StagingOrder, type StagingOrderAction,
} from './staging-sandbox-api';
import { stagingOrderForOriginalScreen } from './staging-order-view';
import { colors } from './theme';
import { creditAmount } from './format';

type Dispute = NonNullable<PendingStagingOrderAction['dispute']>;
const disputeCategories: ReadonlyArray<Readonly<{ value: Dispute['category']; label: string }>> = [
  { value: 'access', label: '访问问题' }, { value: 'metering', label: '计量问题' },
  { value: 'disconnect', label: '连接中断' }, { value: 'other', label: '其他问题' },
];

async function executePending(pending: PendingStagingOrderAction) {
  const versionRef = { id: pending.orderId, version: pending.expectedVersion };
  if (pending.action === 'cancel') return (await cancelStagingOrder(versionRef, pending.idempotencyKey)).order;
  if (pending.action === 'request_stop') return requestStagingOrderStop(versionRef, pending.idempotencyKey);
  if (pending.action === 'accept') return (await acceptStagingOrder(versionRef, pending.idempotencyKey)).order;
  if (!pending.dispute) throw new Error('待确认争议资料不完整。');
  return disputeStagingOrder(versionRef, pending.dispute.category, pending.dispute.description,
    pending.idempotencyKey);
}

async function actionSignature(action: StagingOrderMutationAction, order: StagingOrder, dispute: Dispute | null) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify({
    action, orderId: order.id, expectedVersion: order.version, dispute,
  }));
}

const mutationAllowedAction: Readonly<Record<StagingOrderMutationAction, StagingOrderAction>> = {
  cancel: 'cancel', request_stop: 'request_stop', accept: 'accept', open_dispute: 'open_dispute',
};

export function StagingOrderActionsSlot({ enabled, orderId, onOrderUpdated, onChanged, refreshSignal }: Readonly<{
  enabled: boolean;
  orderId: string;
  onOrderUpdated: (order: CloudPayOrder, statusLabel: string) => void;
  onChanged: () => Promise<void> | void;
  refreshSignal: StagingOrderSlotRefresh;
}>) {
  const [order, setOrder] = useState<StagingOrder | null>(null);
  const [preview, setPreview] = useState<StagingAccessPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mutationBlocked, setMutationBlocked] = useState<string | null>(null);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeCategory, setDisputeCategory] = useState<Dispute['category']>('access');
  const [disputeDescription, setDisputeDescription] = useState('');
  const observedRefreshRevision = useRef(0);

  const applyOrder = useCallback((latest: StagingOrder) => {
    setOrder(latest);
    onOrderUpdated(stagingOrderForOriginalScreen(latest), stagingOrderStatus(latest));
    return latest;
  }, [onOrderUpdated]);

  const reload = useCallback(async (preserveNotice = false) => {
    if (!enabled) return;
    setLoading(true); setError(null); if (!preserveNotice) setNotice(null);
    setMutationBlocked(null); setPreview(null);
    let recoveryError: string | null = null;
    let recovering: PendingStagingOrderAction | null = null;
    try {
      const pending = await loadPendingStagingOrderAction();
      if (pending?.orderId === orderId) {
        recovering = pending;
        const fingerprint = await loadStagingPrincipalFingerprint();
        const recovered = await replayPendingStagingOrderAction(pending, fingerprint, executePending,
          clearConfirmedStagingOrderAction);
        applyOrder(recovered);
        setNotice('上一次履约操作已确认，订单已更新。');
      } else if (pending) {
        recoveryError = '另一笔测试订单的履约结果仍待确认，确认前不能发起新操作。';
      }
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409 && recovering) {
        try {
          await clearConfirmedStagingOrderAction(recovering.idempotencyKey);
          setNotice('服务端已拒绝过期版本的操作，订单已重新读取。');
        } catch (cleanupReason) {
          recoveryError = cleanupReason instanceof Error ? cleanupReason.message : '过期履约操作无法安全清理。';
        }
      } else recoveryError = reason instanceof Error ? reason.message : '上一次履约操作结果尚未确认。';
    }
    try { applyOrder(await loadStagingOrder(orderId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '测试订单详情暂时无法读取。'); }
    setMutationBlocked(recoveryError);
    setLoading(false);
  }, [applyOrder, enabled, orderId]);

  useEffect(() => {
    if (enabled) void reload();
    else {
      setOrder(null); setPreview(null); setError(null); setNotice(null); setMutationBlocked(null);
      setDisputeOpen(false); setDisputeDescription('');
    }
  }, [enabled, reload]);

  useEffect(() => {
    if (!enabled || !shouldReloadStagingOrderSlot(refreshSignal, observedRefreshRevision.current, orderId)) return;
    observedRefreshRevision.current = refreshSignal.revision;
    void reload(refreshSignal.origin === 'order-action');
  }, [enabled, orderId, refreshSignal, reload]);

  const mutate = async (action: StagingOrderMutationAction, dispute: Dispute | null, successNotice: string) => {
    if (!enabled || busy || mutationBlocked) return;
    const releaseMutation = acquireStagingOrderMutation(orderId);
    if (!releaseMutation) {
      setError('该订单另一项操作正在确认，请等待结果。');
      return;
    }
    let submittedPending: PendingStagingOrderAction | null = null;
    setBusy(true); setError(null); setNotice(null); setPreview(null);
    try {
      const latest = applyOrder(await loadStagingOrder(orderId));
      if (!latest.allowedActions.includes(mutationAllowedAction[action])) {
        throw new Error('服务端已更新订单，当前不允许该操作。');
      }
      const signature = await actionSignature(action, latest, dispute);
      const existing = await loadPendingStagingOrderAction();
      const pending = existing ?? await savePendingStagingOrderAction({
        signature, action, orderId: latest.id, expectedVersion: latest.version,
        idempotencyKey: `staging-order-action:${Crypto.randomUUID()}`, dispute,
      });
      submittedPending = pending;
      if (pending.signature !== signature) {
        throw new Error('上一项测试履约操作仍待确认，不能覆盖。');
      }
      const fingerprint = await loadStagingPrincipalFingerprint();
      const updated = await replayPendingStagingOrderAction(pending, fingerprint, executePending,
        clearConfirmedStagingOrderAction);
      applyOrder(updated); setMutationBlocked(null); setNotice(successNotice);
      setDisputeOpen(false); setDisputeDescription('');
      await onChanged();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '操作结果尚未确认。';
      setError(message);
      if (reason instanceof ApiError && reason.status === 409 && submittedPending) {
        try {
          await clearConfirmedStagingOrderAction(submittedPending.idempotencyKey);
          applyOrder(await loadStagingOrder(orderId));
          setMutationBlocked(null);
          setNotice('服务端已拒绝过期版本的操作，订单已重新读取。');
          return;
        } catch (cleanupReason) {
          setMutationBlocked(cleanupReason instanceof Error ? cleanupReason.message : message);
          return;
        }
      }
      try {
        const pending = await loadPendingStagingOrderAction();
        if (pending) setMutationBlocked('操作结果待确认，请恢复网络后重新确认；系统不会重复执行。');
      } catch (pendingReason) {
        setMutationBlocked(pendingReason instanceof Error ? pendingReason.message : message);
      }
    } finally { releaseMutation(); setBusy(false); }
  };

  const openAccessPreview = async () => {
    if (!enabled || busy) return;
    setBusy(true); setError(null); setNotice(null); setPreview(null);
    try {
      const latest = applyOrder(await loadStagingOrder(orderId));
      if (!latest.allowedActions.includes('access_preview')) {
        throw new Error('服务端已更新订单，当前不允许查看访问预览。');
      }
      setPreview(await loadStagingAccessPreview(latest.id));
    } catch (reason) { setError(reason instanceof Error ? reason.message : '访问预览暂时无法读取。'); }
    finally { setBusy(false); }
  };

  if (!enabled) return null;
  if (!order && loading) return <ActivityIndicator color={colors.primary} style={styles.loader} />;
  if (!order) return <View style={styles.errorCard}><Text style={styles.errorText}>{error ?? '测试订单暂时无法读取。'}</Text>
    <Pressable onPress={() => void reload()} style={styles.inlineAction}><Text style={styles.inlineActionText}>重新读取</Text></Pressable></View>;

  const allowedActions = stagingOrderActions(order);
  const disputeReady = disputeDescription.trim().length >= 20 && disputeDescription.trim().length <= 500;
  return <View style={styles.root}>
    <View style={styles.heading}><View style={styles.headingCopy}><Text style={styles.eyebrow}>测试环境履约</Text>
      <Text style={styles.title}>{stagingOrderStatus(order)}</Text><Text style={styles.version}>服务端版本 {order.version}</Text></View>
      <Pressable disabled={loading || busy} onPress={() => void reload()} accessibilityLabel="重新读取测试订单详情">
        {loading ? <ActivityIndicator color={colors.primary} /> : <Ionicons name="refresh" size={19} color={colors.primary} />}
      </Pressable></View>

    {order.metering ? <View style={styles.metering}><Metric label="已预留" value={order.metering.reservedCredits} />
      <Metric label="已消耗" value={order.metering.consumedCredits} />
      <Metric label="可退回" value={order.metering.refundableCredits} /></View> : null}
    {notice ? <Text style={styles.notice}>{notice}</Text> : null}
    {mutationBlocked ? <View style={styles.warning}><Text style={styles.warningText}>{mutationBlocked}</Text>
      <Pressable disabled={loading || busy} onPress={() => void reload()}><Text style={styles.warningAction}>重新确认</Text></Pressable></View> : null}
    {error ? <Text style={styles.errorText}>{error}</Text> : null}

    {allowedActions.includes('access_preview') ? <SecondaryButton label="查看访问预览" disabled={busy}
      onPress={() => void openAccessPreview()} /> : null}
    {preview ? <View style={styles.preview}><Text style={styles.previewTitle}>{preview.headline}</Text>
      {preview.terminalScript.map((line, index) => <Text key={`${index}:${line}`} style={styles.terminalLine}>{line}</Text>)}
      <Text style={styles.previewSafety}>仅显示不可连接的测试终端结果，不提供复制或连接功能。</Text></View> : null}

    {allowedActions.includes('request_stop') ? <PrimaryButton label="停止测试资源" disabled={busy || Boolean(mutationBlocked)} onPress={() => Alert.alert(
      '停止测试资源', '服务端将记录当前版本并开始停止，完成后进入验收。', [
        { text: '再想一下', style: 'cancel' }, { text: '确认停止', style: 'destructive', onPress: () => void mutate(
          'request_stop', null, '停止请求已由服务端确认。') },
      ])} /> : null}
    {allowedActions.includes('accept') ? <PrimaryButton label="确认验收" disabled={busy || Boolean(mutationBlocked)} onPress={() => Alert.alert(
      '确认验收', '确认后将按服务端计量结果结算，未消耗的测试卡时会退回。', [
        { text: '再想一下', style: 'cancel' }, { text: '确认验收', onPress: () => void mutate(
          'accept', null, '验收已由服务端确认。') },
      ])} /> : null}
    {allowedActions.includes('cancel') ? <PrimaryButton label="取消测试订单" danger disabled={busy || Boolean(mutationBlocked)} onPress={() => Alert.alert(
      '取消测试订单', '取消成功后，服务端会退回本单已预留的测试卡时。', [
        { text: '再想一下', style: 'cancel' }, { text: '确认取消', style: 'destructive', onPress: () => void mutate(
          'cancel', null, '订单已取消，预留测试卡时已退回。') },
      ])} /> : null}

    {allowedActions.includes('open_dispute') ? <View style={styles.dispute}>
      <Pressable disabled={busy || Boolean(mutationBlocked)} onPress={() => setDisputeOpen((value) => !value)} style={styles.disputeToggle}>
        <Text style={styles.disputeToggleText}>{disputeOpen ? '收起争议说明' : '提交履约争议'}</Text>
        <Ionicons name={disputeOpen ? 'chevron-up' : 'chevron-down'} size={17} color={colors.primary} />
      </Pressable>
      {disputeOpen ? <View><View style={styles.categoryRow}>{disputeCategories.map((item) => <Pressable key={item.value}
        onPress={() => setDisputeCategory(item.value)} style={[styles.category, disputeCategory === item.value && styles.categoryActive]}>
        <Text style={[styles.categoryText, disputeCategory === item.value && styles.categoryTextActive]}>{item.label}</Text>
      </Pressable>)}</View>
      <TextInput value={disputeDescription} onChangeText={setDisputeDescription} multiline maxLength={500}
        placeholder="说明发生时间、影响和需要核对的计量或访问问题"
        placeholderTextColor={colors.subtle} style={styles.input} />
      <PrimaryButton label="提交争议" disabled={busy || Boolean(mutationBlocked) || !disputeReady} danger onPress={() => void mutate(
        'open_dispute', { category: disputeCategory, description: disputeDescription.trim() },
        '争议已由服务端记录。')} /></View> : null}
    </View> : null}
  </View>;
}

function Metric({ label, value }: Readonly<{ label: string; value: string }>) {
  return <View style={styles.metric}><Text style={styles.metricLabel}>{label}</Text>
    <Text style={styles.metricValue}>{creditAmount(value)}</Text></View>;
}
function PrimaryButton({ label, onPress, disabled, danger = false }: Readonly<{
  label: string; onPress: () => void; disabled: boolean; danger?: boolean;
}>) {
  return <Pressable disabled={disabled} onPress={onPress}
    style={[styles.primary, danger && styles.danger, disabled && styles.disabled]}>
    <Text style={styles.primaryText}>{label}</Text></Pressable>;
}
function SecondaryButton({ label, onPress, disabled }: Readonly<{
  label: string; onPress: () => void; disabled: boolean;
}>) {
  return <Pressable disabled={disabled} onPress={onPress} style={[styles.secondary, disabled && styles.disabled]}>
    <Text style={styles.secondaryText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  root: { marginTop: 14, padding: 15, borderRadius: 20, backgroundColor: colors.primarySoft },
  loader: { marginVertical: 18 }, heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headingCopy: { flex: 1 }, eyebrow: { color: colors.primary, fontSize: 9, fontWeight: '900' },
  title: { color: colors.ink, fontSize: 17, fontWeight: '900', marginTop: 4 },
  version: { color: colors.muted, fontSize: 8, marginTop: 4 },
  metering: { marginTop: 13, flexDirection: 'row', gap: 7 }, metric: { flex: 1, padding: 10, borderRadius: 12, backgroundColor: colors.surface },
  metricLabel: { color: colors.muted, fontSize: 8 }, metricValue: { color: colors.primaryDark, fontSize: 14, fontWeight: '900', marginTop: 4 },
  notice: { color: colors.greenDark, fontSize: 10, lineHeight: 16, marginTop: 12 },
  warning: { marginTop: 12, padding: 11, borderRadius: 12, backgroundColor: colors.primarySoft },
  warningText: { color: colors.amber, fontSize: 9, lineHeight: 15 }, warningAction: { color: colors.primary, fontSize: 10, fontWeight: '900', marginTop: 7 },
  errorCard: { marginTop: 14, padding: 14, borderRadius: 16, backgroundColor: '#FDECEC' }, errorText: { color: colors.red, fontSize: 9, lineHeight: 15, marginTop: 10 },
  inlineAction: { marginTop: 9 }, inlineActionText: { color: colors.primary, fontSize: 10, fontWeight: '900' },
  primary: { minHeight: 48, marginTop: 11, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  danger: { backgroundColor: '#B73A35' }, primaryText: { color: colors.surface, fontSize: 12, fontWeight: '900' }, disabled: { opacity: 0.45 },
  secondary: { minHeight: 46, marginTop: 11, borderWidth: 1, borderColor: colors.primary, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  secondaryText: { color: colors.primary, fontSize: 11, fontWeight: '900' },
  preview: { marginTop: 11, padding: 12, borderRadius: 12, backgroundColor: '#17243A' }, previewTitle: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  terminalLine: { color: '#B7F7CF', fontSize: 9, lineHeight: 15, marginTop: 5 }, previewSafety: { color: '#C8D3E2', fontSize: 8, lineHeight: 13, marginTop: 9 },
  dispute: { marginTop: 11, paddingTop: 11, borderTopWidth: 1, borderTopColor: '#B7CEF4' },
  disputeToggle: { minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, disputeToggleText: { color: colors.primary, fontSize: 11, fontWeight: '900' },
  categoryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 7 }, category: { minHeight: 35, paddingHorizontal: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line, borderRadius: 10, backgroundColor: colors.surface },
  categoryActive: { borderColor: colors.primary, backgroundColor: '#E6F0FF' }, categoryText: { color: colors.muted, fontSize: 9, fontWeight: '800' }, categoryTextActive: { color: colors.primaryDark },
  input: { minHeight: 92, marginTop: 10, padding: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 13, color: colors.ink, backgroundColor: colors.surface, textAlignVertical: 'top' },
});
