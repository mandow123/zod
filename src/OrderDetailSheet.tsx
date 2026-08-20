import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import {
  approveAftercareRefund, approveCloudPayDeliveryRefund,
  cancelCloudPayOrder, confirmCloudPayOrder, contestAftercareRefund, escalateAftercareRefund,
  escalateCloudPayDeliveryDispute, loadAftercareRefund,
  loadCloudPayDeliveryIssue, loadCloudPaySupplierSettlement, requestAftercareRefund,
  startCloudPayDeliveryRework, loadCloudPayOrder,
  type AftercareRefund, type CloudPayFulfillmentIssue, type CloudPayFulfillmentResponse,
  type CloudPayOrder, type OrderDeliveryIssue, type SupplierSettlement,
} from './api';
import { ApiError } from './api-client';
import { ComputeFulfillmentCard } from './ComputeFulfillmentCard';
import { parseCreditMicros, remainingCreditAmount } from './credit-display';
import { isAmbiguousMutationFailure, providerOrderActionAccepted } from './mutation-recovery';
import { orderStatusLabel } from './OrderCard';
import { colors } from './theme';
import { StagingManualDeliverySlot } from './StagingManualDeliverySlot';
import { StagingOrderActionsSlot } from './StagingOrderActionsSlot';
import { initialStagingOrderSlotRefresh, nextStagingOrderSlotRefresh,
  type StagingOrderSlotOrigin } from './staging-order-slot-sync';
import { creditAmount } from './format';

type OrderActionResponse = Readonly<{ order: CloudPayOrder }>;

export function OrderDetailSheet({ order, source, onClose, onChanged }: Readonly<{
  order: CloudPayOrder | null;
  source: 'formal' | 'staging';
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}>) {
  const [currentOrder, setCurrentOrder] = useState<CloudPayOrder | null>(order);
  const [issue, setIssue] = useState<OrderDeliveryIssue | null>(null);
  const [aftercare, setAftercare] = useState<AftercareRefund | null>(null);
  const [settlement, setSettlement] = useState<SupplierSettlement | null>(null);
  const [computeSnapshot, setComputeSnapshot] = useState<CloudPayFulfillmentResponse | null>(null);
  const [computeIssue, setComputeIssue] = useState<CloudPayFulfillmentIssue | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [aftercareDescription, setAftercareDescription] = useState('');
  const [aftercareCredits, setAftercareCredits] = useState('');
  const [providerResponse, setProviderResponse] = useState('');
  const [stagingStatusLabel, setStagingStatusLabel] = useState<string | null>(null);
  const [stagingSlotRefresh, setStagingSlotRefresh] = useState(initialStagingOrderSlotRefresh);
  const actionRequests = useRef(new Map<string, string>());
  const updateStagingOrder = useCallback((latest: CloudPayOrder, statusLabel: string) => {
    setCurrentOrder(latest); setStagingStatusLabel(statusLabel);
  }, []);
  const stagingSlotChanged = useCallback(async (origin: StagingOrderSlotOrigin, orderId: string) => {
    setStagingSlotRefresh((current) => nextStagingOrderSlotRefresh(current, orderId, origin));
    await onChanged();
  }, [onChanged]);

  const actionRequestId = (signature: string) => {
    const existing = actionRequests.current.get(signature);
    if (existing) return existing;
    const created = `order-action-${Crypto.randomUUID()}`;
    actionRequests.current.set(signature, created);
    return created;
  };

  const loadRelated = useCallback(async (target: CloudPayOrder) => {
    setLoading(true); setError(null);
    try {
      if (target.status === 'disputed') {
        try { setIssue((await loadCloudPayDeliveryIssue(target.id)).issue); }
        catch (reason) { if (reason instanceof ApiError && reason.status === 404) setIssue(null); else throw reason; }
      } else setIssue(null);
      const computeOrder = target.aftercarePolicy.model === 'metering_issue_before_acceptance';
      if (!computeOrder && ['accepted', 'refunded', 'closed'].includes(target.status)) {
        try { setAftercare((await loadAftercareRefund(target.id)).aftercareRefund); }
        catch (reason) { if (reason instanceof ApiError && reason.status === 404) setAftercare(null); else throw reason; }
      } else setAftercare(null);
      if (!computeOrder && target.side === 'provider' && target.status === 'closed') {
        try { setSettlement((await loadCloudPaySupplierSettlement(target.id)).settlement); }
        catch (reason) { if (reason instanceof ApiError && reason.status === 404) setSettlement(null); else throw reason; }
      } else setSettlement(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '订单详情暂时无法读取。');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    setCurrentOrder(order);
    setStagingStatusLabel(null);
    setComputeSnapshot(null); setComputeIssue(null);
    setError(null); setNotice(null);
    if (order && source === 'staging') {
      setIssue(null); setAftercare(null); setSettlement(null);
      return undefined;
    }
    if (order) {
      let live = true;
      void loadCloudPayOrder(order.id).then((latest) => {
        if (!live) return;
        setCurrentOrder(latest);
        return loadRelated(latest);
      }).catch((reason) => {
        if (!live) return;
        setError(reason instanceof Error ? reason.message : '订单详情暂时无法读取。');
      });
      return () => { live = false; };
    }
    else { setIssue(null); setAftercare(null); setSettlement(null); }
    return undefined;
  }, [loadRelated, order, source]);

  const run = async (
    task: () => Promise<OrderActionResponse>,
    recovery?: Readonly<{ signature: string; action: 'confirm' | 'start_delivery'; notice: string }>,
  ) => {
    const before = currentOrder;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await task();
      if (recovery) actionRequests.current.delete(recovery.signature);
      setCurrentOrder(result.order);
      await onChanged();
      await loadRelated(result.order);
      setAftercareDescription(''); setAftercareCredits(''); setProviderResponse('');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '操作没有完成，请重试。';
      if (!before) setError(message);
      else if (recovery && isAmbiguousMutationFailure(reason)) {
        try {
          const latest = await loadCloudPayOrder(before.id);
          setCurrentOrder(latest);
          await loadRelated(latest);
          await onChanged();
          if (providerOrderActionAccepted(recovery.action, before, latest)) {
            actionRequests.current.delete(recovery.signature);
            setError(null);
            setNotice(recovery.notice);
          } else {
            setError('网络中断，暂时没能确认操作结果。请恢复网络后再点一次，系统不会重复处理。');
          }
        } catch {
          setError('网络中断，暂时没能确认操作结果。请恢复网络后再点一次，系统不会重复处理。');
        }
      }
      else {
        try {
          const latest = await loadCloudPayOrder(before.id);
          setCurrentOrder(latest);
          await loadRelated(latest);
          await onChanged();
          const changed = latest.status !== before.status
            || latest.updatedAt !== before.updatedAt
            || latest.actions.join(',') !== before.actions.join(',');
          if (changed) {
            setError(null);
            setNotice('订单已同步到最新进度，请按当前步骤继续。');
          } else setError(message);
        } catch { setError(message); }
      }
    }
    finally { setBusy(false); }
  };

  const close = () => onClose();

  if (!currentOrder) return null;
  const isComputeOrder = currentOrder.aftercarePolicy.model === 'metering_issue_before_acceptance';
  const canRequestAftercare = !isComputeOrder && currentOrder.side === 'buyer' && currentOrder.status === 'accepted' && !aftercare
    && Boolean(currentOrder.settlementAvailableAt && new Date(currentOrder.settlementAvailableAt) > new Date());
  const requestedAftercareMicros = parseCreditMicros(aftercareCredits);
  const invalidAftercareCredits = aftercareCredits.trim().length > 0 && requestedAftercareMicros === null;
  const totalOrderMicros = parseCreditMicros(currentOrder.totalCredits);
  const aftercareReady = aftercareDescription.trim().length >= 10 && requestedAftercareMicros !== null
    && totalOrderMicros !== null && requestedAftercareMicros <= totalOrderMicros;
  const computeProviderCredits = computeIssue?.status === 'resolved' && computeIssue.settlement
    ? computeIssue.settlement.providerCredits
    : computeSnapshot?.usage?.acceptedAt ? computeSnapshot.usage.consumedCredits : null;
  const providerSettlementBase = computeProviderCredits ?? currentOrder.totalCredits;
  const providerSettlementCredits = aftercare?.status === 'succeeded'
    ? remainingCreditAmount(providerSettlementBase, aftercare.creditAmount) : providerSettlementBase;
  const acceptanceTimelineLabel = computeSnapshot?.fulfillment?.acceptanceMode === 'system' ? '系统按计量完成'
    : computeSnapshot?.fulfillment?.acceptanceMode === 'operator' ? '平台核对完成' : '买方验收';
  const confirmationTimelineLabel = isComputeOrder ? '资源已锁定' : '提供方接单';
  const hasVisibleOrderAction = currentOrder.actions.some((action) => [
    ...(isComputeOrder ? [] : ['confirm_order']), 'cancel_order',
  ].includes(action));

  const confirm = (
    title: string,
    message: string,
    actionLabel: string,
    task: () => Promise<OrderActionResponse>,
    recovery?: Readonly<{ signature: string; action: 'confirm' | 'start_delivery'; notice: string }>,
  ) => {
    Alert.alert(title, message, [
      { text: '再想一下', style: 'cancel' },
      { text: actionLabel, style: actionLabel.includes('退款') || actionLabel.includes('取消') ? 'destructive' : 'default',
        onPress: () => void run(task, recovery) },
    ]);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerCopy}><Text style={styles.eyebrow}>{currentOrder.side === 'provider' ? '提供订单' : '购买订单'}</Text><Text numberOfLines={1} style={styles.title}>{currentOrder.title}</Text></View>
            <Pressable onPress={close} style={styles.close}><Ionicons name="close" size={23} color={colors.ink} /></Pressable>
          </View>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.content}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.summary}>
              <View style={styles.summaryTop}><Text style={styles.status}>{source === 'staging'
                ? stagingStatusLabel ?? '正在读取测试状态'
                : orderStatusLabel(currentOrder.status, currentOrder.side)}</Text><Text style={styles.number}>{currentOrder.orderNumber}</Text></View>
              <Text style={styles.credits}>{creditAmount(currentOrder.totalCredits)} <Text style={styles.unit}>KAI 卡时</Text></Text>
              <Text style={styles.meta}>{trim(currentOrder.quantity)} {currentOrder.capacityUnit} · {currentOrder.productCode ?? '算力资源'} · {currentOrder.region ?? '区域待确认'}</Text>
            </View>

            {source === 'formal' ? <ComputeFulfillmentCard order={currentOrder} onChanged={onChanged}
              onSnapshot={setComputeSnapshot} onIssueChanged={setComputeIssue} /> : null}
            <StagingOrderActionsSlot enabled={source === 'staging'} orderId={currentOrder.id}
              onOrderUpdated={updateStagingOrder} refreshSignal={stagingSlotRefresh}
              onChanged={() => stagingSlotChanged('order-action', currentOrder.id)} />
            <StagingManualDeliverySlot enabled={source === 'staging'} orderId={currentOrder.id}
              refreshSignal={stagingSlotRefresh}
              onChanged={() => stagingSlotChanged('manual-delivery', currentOrder.id)} />

            {source === 'formal' ? <><Text style={styles.sectionTitle}>进度</Text>
            <View style={styles.timeline}>
              <Timeline label="订单创建" value={formatTime(currentOrder.createdAt)} done />
              <Timeline label={confirmationTimelineLabel} value={formatTime(currentOrder.confirmedAt)} done={Boolean(currentOrder.confirmedAt)} />
              <Timeline label="算力开通" value={formatTime(currentOrder.deliveryReadyAt)} done={Boolean(currentOrder.deliveryReadyAt)} />
              <Timeline label={acceptanceTimelineLabel} value={formatTime(currentOrder.acceptedAt)} done={Boolean(currentOrder.acceptedAt)} last />
            </View></> : null}

            {loading ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}
            {notice ? <View style={styles.notice}><Ionicons name="checkmark-circle-outline" size={18} color={colors.green} /><Text style={styles.noticeText}>{notice}</Text></View> : null}
            {error ? <View style={styles.error}><Ionicons name="alert-circle-outline" size={18} color={colors.red} /><Text style={styles.errorText}>{error}</Text></View> : null}

            {hasVisibleOrderAction ? <View style={styles.actionCard}>
              <Text style={styles.sectionTitle}>现在要做</Text>
              {!isComputeOrder && currentOrder.actions.includes('confirm_order') ? <PrimaryButton label="确认接单" busy={busy}
                onPress={() => {
                  const signature = `confirm:${currentOrder.id}`;
                  confirm('确认接单', `确认后将为买方保留 ${trim(currentOrder.quantity)} ${currentOrder.capacityUnit}，订单进入履约。`, '确认接单',
                    () => confirmCloudPayOrder(currentOrder.id, actionRequestId(signature)),
                    { signature, action: 'confirm', notice: '订单已经确认，可以开始交付。' });
                }} /> : null}
              {currentOrder.actions.includes('cancel_order') ? <PrimaryButton label="取消订单" busy={busy} tone="danger"
                onPress={() => confirm('取消订单', '提供方尚未接单。取消后，预留卡时和资源数量会立即退回。', '取消订单', () => cancelCloudPayOrder(currentOrder.id))} /> : null}
            </View> : null}

            {!isComputeOrder && currentOrder.side === 'provider' && currentOrder.status === 'accepted' && currentOrder.settlementAvailableAt ? (
              <View style={styles.settlementCard}>
                <View style={styles.settlementHeading}>
                  <View><Text style={styles.settlementEyebrow}>{aftercare && ['pending', 'escalated'].includes(aftercare.status) ? '结算已暂停' : '待结算卡时'}</Text><Text style={styles.settlementAmount}>{creditAmount(providerSettlementCredits)}</Text></View>
                  <Ionicons name={aftercare && ['pending', 'escalated'].includes(aftercare.status) ? 'pause-circle-outline' : 'time-outline'} size={28} color={colors.amber} />
                </View>
                <Text style={styles.settlementTitle}>{aftercare && ['pending', 'escalated'].includes(aftercare.status)
                  ? '售后申请正在处理'
                  : `${formatFullTime(currentOrder.settlementAvailableAt)} 转为可用卡时`}</Text>
                <Text style={styles.settlementText}>{aftercare && ['pending', 'escalated'].includes(aftercare.status)
                  ? '卡时仍保留在待结算账户；售后处理完成后按结果继续。'
                  : aftercare?.status === 'succeeded'
                    ? `已补偿买方 ${creditAmount(aftercare.creditAmount)} 卡时，剩余卡时按原日期到账。`
                    : '买方验收后的 7 天为售后期。期间没有补偿或争议，系统会自动到账。'}</Text>
              </View>
            ) : null}

            {!isComputeOrder && currentOrder.side === 'provider' && currentOrder.status === 'closed' && settlement ? (
              <View style={styles.settledCard}>
                <View><Text style={styles.settledEyebrow}>已转入可用卡时</Text><Text style={styles.settledAmount}>{creditAmount(settlement.creditAmount)}</Text></View>
                <View style={styles.settledMeta}><Ionicons name="checkmark-circle" size={19} color={colors.green} /><Text style={styles.settledText}>{formatFullTime(settlement.settledAt)} 到账</Text></View>
              </View>
            ) : null}

            {issue ? <View style={styles.detailCard}>
              <View style={styles.cardHeading}><Text style={styles.sectionTitle}>交付问题</Text><Text style={styles.attempt}>{issue.requestedResolution === 'rework' ? '要求重新交付' : '申请全额退款'}</Text></View>
              <Text style={styles.reason}>{issue.description}</Text>
              {issue.actions.includes('start_rework') ? <PrimaryButton label="开始重新交付" busy={busy} onPress={() => void run(() => startCloudPayDeliveryRework(currentOrder.id))} /> : null}
              {issue.actions.includes('approve_refund') ? <PrimaryButton label="同意全额退款" busy={busy} tone="danger"
                onPress={() => confirm('同意全额退款', `将退回买方 ${creditAmount(currentOrder.totalCredits)} KAI 卡时，并恢复本单预留资源数量。`, '确认退款', () => approveCloudPayDeliveryRefund(currentOrder.id))} /> : null}
              {issue.actions.includes('escalate_dispute') ? <SecondaryButton label="交平台处理" busy={busy}
                onPress={() => void run(() => escalateCloudPayDeliveryDispute(currentOrder.id))} /> : null}
              {issue.status === 'escalated' ? <Text style={styles.waitText}>平台正在核对买方说明和交付记录，处理结果会同步到订单与消息。</Text> : null}
            </View> : null}

            {canRequestAftercare ? <View style={styles.detailCard}>
              <Text style={styles.sectionTitle}>申请卡时补偿</Text>
              <Text style={styles.help}>按实际受影响的服务量填写，可申请部分或全部卡时。提交后会暂停结算。</Text>
              <Field label="补偿卡时" value={aftercareCredits} onChange={setAftercareCredits} placeholder={`最多 ${creditAmount(currentOrder.totalCredits)}`} keyboardType="decimal-pad" />
              {invalidAftercareCredits ? <Text style={styles.fieldError}>卡时必须大于 0，且最多保留两位小数</Text> : null}
              {requestedAftercareMicros !== null && totalOrderMicros !== null && requestedAftercareMicros > totalOrderMicros ? <Text style={styles.fieldError}>不能超过本单 {creditAmount(currentOrder.totalCredits)} 卡时</Text> : null}
              <Field label="问题说明" value={aftercareDescription} onChange={setAftercareDescription} placeholder="写清实际问题、发现时间和影响" multiline />
              <PrimaryButton label="提交补偿申请" busy={busy} tone="danger" disabled={!aftercareReady}
                onPress={() => confirm('提交补偿申请', `申请退回 ${creditAmount(aftercareCredits)} KAI 卡时，提供方待结算金额会先暂停。`, '确认提交', () => requestAftercareRefund(currentOrder.id, aftercareDescription.trim(), aftercareCredits.trim()))} />
            </View> : null}

            {aftercare ? <View style={styles.detailCard}>
              <View style={styles.cardHeading}><View><Text style={styles.sectionTitle}>验收后售后</Text><Text style={styles.aftercareMeta}>{formatTime(aftercare.requestedAt)} 提交</Text></View><AftercarePill status={aftercare.status} /></View>
              <Text style={styles.reasonLabel}>买方说明</Text><Text style={styles.reason}>{aftercare.description}</Text>
              <View style={styles.refundAmount}><Text style={styles.refundLabel}>申请退回</Text><Text style={styles.refundValue}>{creditAmount(aftercare.creditAmount)} KAI 卡时</Text></View>
              {aftercare.providerResponse ? <><Text style={styles.reasonLabel}>提供方说明</Text><Text style={styles.reason}>{aftercare.providerResponse}</Text></> : null}
              {aftercare.decisionReason ? <><Text style={styles.reasonLabel}>平台处理结果</Text><Text style={styles.reason}>{aftercare.decisionReason}</Text></> : null}
              {aftercare.status === 'pending' && currentOrder.side === 'buyer' && aftercare.actions.length === 0 ? <Text style={styles.waitText}>提供方处理中；{formatTime(aftercare.escalationAvailableAt)} 后仍未处理，可交平台。</Text> : null}
              {aftercare.actions.includes('approve_refund') ? <PrimaryButton label="同意补偿" busy={busy} tone="danger" onPress={() => confirm('同意补偿', `将从待结算账户退回买方 ${creditAmount(aftercare.creditAmount)} KAI 卡时，剩余卡时按原日期结算。`, '确认补偿', () => approveAftercareRefund(currentOrder.id))} /> : null}
              {aftercare.actions.includes('contest_refund') ? <View>
                <Field label="提供方说明" value={providerResponse} onChange={setProviderResponse} placeholder="写明不同意退款的依据" multiline />
                <SecondaryButton label="提出异议并交平台" busy={busy} disabled={providerResponse.trim().length < 10} onPress={() => void run(() => contestAftercareRefund(currentOrder.id, providerResponse.trim()))} />
              </View> : null}
              {aftercare.actions.includes('escalate_refund') ? <PrimaryButton label="交平台处理" busy={busy} onPress={() => void run(() => escalateAftercareRefund(currentOrder.id))} /> : null}
            </View> : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Field({ label, value, onChange, placeholder, multiline = false, secure = false, keyboardType = 'default' }: Readonly<{
  label: string; value: string; onChange: (value: string) => void; placeholder: string; multiline?: boolean; secure?: boolean;
  keyboardType?: 'default' | 'decimal-pad';
}>) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={colors.subtle} multiline={multiline} secureTextEntry={secure} keyboardType={keyboardType} autoCapitalize="none" maxLength={2000} style={[styles.input, multiline && styles.multiline]} /></View>;
}
function Timeline({ label, value, done, last = false }: Readonly<{ label: string; value: string; done: boolean; last?: boolean }>) { return <View style={styles.timelineRow}><View style={styles.rail}><View style={[styles.dot, done && styles.dotDone]} />{!last ? <View style={[styles.line, done && styles.lineDone]} /> : null}</View><View style={styles.timelineCopy}><Text style={[styles.timelineLabel, done && styles.timelineLabelDone]}>{label}</Text><Text style={styles.timelineValue}>{value}</Text></View></View>; }
function AftercarePill({ status }: Readonly<{ status: AftercareRefund['status'] }>) { const map = { pending: '待提供方处理', escalated: '平台处理中', succeeded: '已补偿', rejected: '未支持补偿' } as const; return <View style={[styles.pill, status === 'escalated' && styles.pillWarn, status === 'succeeded' && styles.pillSuccess, status === 'rejected' && styles.pillMuted]}><Text style={[styles.pillText, status === 'escalated' && styles.pillTextWarn, status === 'succeeded' && styles.pillTextSuccess, status === 'rejected' && styles.pillTextMuted]}>{map[status]}</Text></View>; }
function PrimaryButton({ label, onPress, busy, disabled = false, tone = 'primary' }: Readonly<{ label: string; onPress: () => void; busy: boolean; disabled?: boolean; tone?: 'primary' | 'danger' }>) { return <Pressable disabled={busy || disabled} onPress={onPress} style={[styles.primary, tone === 'danger' && styles.danger, (busy || disabled) && styles.disabled]}>{busy ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>{label}</Text>}</Pressable>; }
function SecondaryButton({ label, onPress, busy, disabled = false }: Readonly<{ label: string; onPress: () => void; busy: boolean; disabled?: boolean }>) { return <Pressable disabled={busy || disabled} onPress={onPress} style={[styles.secondary, (busy || disabled) && styles.disabled]}><Text style={styles.secondaryText}>{label}</Text></Pressable>; }
function Choice({ active, label, onPress }: Readonly<{ active: boolean; label: string; onPress: () => void }>) { return <Pressable onPress={onPress} style={[styles.choice, active && styles.choiceActive]}><Ionicons name={active ? 'radio-button-on' : 'radio-button-off'} size={17} color={active ? colors.primary : colors.subtle} /><Text style={[styles.choiceText, active && styles.choiceTextActive]}>{label}</Text></Pressable>; }
function formatTime(value: string | null) { if (!value) return '待完成'; const date = new Date(value); return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }
function formatFullTime(value: string) { const date = new Date(value); return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }
function trim(value: string) { return value.replace(/\.0+$/u, '').replace(/(\.\d*?)0+$/u, '$1'); }

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(18,35,58,0.36)' }, sheet: { height: '94%', borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: colors.canvas, overflow: 'hidden' }, handle: { width: 42, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 9, backgroundColor: '#D6DEE8' },
  header: { minHeight: 75, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, headerCopy: { flex: 1, marginRight: 12 }, eyebrow: { color: colors.primary, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 }, title: { color: colors.ink, fontSize: 21, fontWeight: '900', marginTop: 3 }, close: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  scroll: { flex: 1 }, content: { padding: 17, paddingBottom: 24 }, actionFooter: { paddingHorizontal: 17, paddingTop: 2, paddingBottom: 14, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.surface }, summary: { padding: 18, borderWidth: 1, borderColor: '#D5E5FA', borderRadius: 23, backgroundColor: colors.surface }, summaryTop: { flexDirection: 'row', justifyContent: 'space-between' }, status: { color: colors.primary, fontSize: 11, fontWeight: '900' }, number: { color: colors.muted, fontSize: 9 }, credits: { color: colors.primaryDark, fontSize: 31, fontWeight: '900', marginTop: 17 }, unit: { fontSize: 12, color: colors.primary }, meta: { color: colors.muted, fontSize: 10, marginTop: 6 },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: '900', marginTop: 3 }, timeline: { marginTop: 12, padding: 15, borderRadius: 20, backgroundColor: colors.surface }, timelineRow: { minHeight: 61, flexDirection: 'row' }, rail: { width: 22, alignItems: 'center' }, dot: { width: 12, height: 12, borderRadius: 6, marginTop: 4, backgroundColor: '#D5DED8' }, dotDone: { backgroundColor: colors.green }, line: { position: 'absolute', top: 16, bottom: -4, width: 2, backgroundColor: colors.line }, lineDone: { backgroundColor: '#A9D5B4' }, timelineCopy: { flex: 1, marginLeft: 9 }, timelineLabel: { color: colors.muted, fontSize: 12, fontWeight: '800' }, timelineLabelDone: { color: colors.ink }, timelineValue: { color: colors.subtle, fontSize: 9, marginTop: 4 },
  loader: { marginVertical: 20 }, notice: { flexDirection: 'row', gap: 8, padding: 12, marginTop: 14, borderRadius: 14, backgroundColor: colors.greenSoft }, noticeText: { flex: 1, color: colors.greenDark, fontSize: 11, lineHeight: 17 }, error: { flexDirection: 'row', gap: 8, padding: 12, marginTop: 14, borderRadius: 14, backgroundColor: '#FDECEC' }, errorText: { flex: 1, color: colors.red, fontSize: 11, lineHeight: 17 }, actionCard: { padding: 16, marginTop: 15, borderRadius: 22, backgroundColor: colors.primarySoft }, detailCard: { padding: 16, marginTop: 15, borderWidth: 1, borderColor: colors.line, borderRadius: 22, backgroundColor: colors.surface },
  help: { color: colors.muted, fontSize: 11, lineHeight: 18, marginTop: 8 }, field: { marginTop: 13 }, fieldLabel: { color: colors.ink, fontSize: 10, fontWeight: '800', marginBottom: 6 }, fieldError: { color: colors.red, fontSize: 9, marginTop: 6 }, input: { minHeight: 48, paddingHorizontal: 13, borderWidth: 1, borderColor: colors.line, borderRadius: 15, color: colors.ink, backgroundColor: colors.surface }, multiline: { minHeight: 88, paddingTop: 12, textAlignVertical: 'top' }, draftNote: { color: colors.muted, fontSize: 9, lineHeight: 15, marginTop: 10 }, primary: { minHeight: 50, marginTop: 13, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, danger: { backgroundColor: '#B73A35' }, primaryText: { color: colors.surface, fontSize: 13, fontWeight: '900' }, disabled: { opacity: 0.48 }, secondary: { minHeight: 48, marginTop: 11, borderWidth: 1, borderColor: colors.primary, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }, secondaryText: { color: colors.primary, fontSize: 12, fontWeight: '900' },
  choiceRow: { flexDirection: 'row', gap: 9, marginTop: 12 }, choice: { flex: 1, minHeight: 46, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderColor: colors.line, borderRadius: 14, backgroundColor: colors.surface }, choiceActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft }, choiceText: { color: colors.muted, fontSize: 11, fontWeight: '800' }, choiceTextActive: { color: colors.primaryDark }, issueForm: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.line },
  cardHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }, attempt: { color: colors.amber, fontSize: 9, fontWeight: '900', marginTop: 6 }, detailRow: { flexDirection: 'row', gap: 15, marginTop: 13 }, detailKey: { width: 72, color: colors.muted, fontSize: 10 }, detailValue: { flex: 1, color: colors.ink, fontSize: 11, lineHeight: 17, fontWeight: '700', textAlign: 'right' }, reasonLabel: { color: colors.primary, fontSize: 9, fontWeight: '900', marginTop: 16 }, reason: { color: colors.ink, fontSize: 12, lineHeight: 19, marginTop: 8 },
  settlementCard: { padding: 17, marginTop: 15, borderRadius: 22, backgroundColor: colors.primarySoft }, settlementHeading: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, settlementEyebrow: { color: colors.amber, fontSize: 10, fontWeight: '900' }, settlementAmount: { color: colors.ink, fontSize: 27, fontWeight: '900', marginTop: 4 }, settlementTitle: { color: colors.ink, fontSize: 13, fontWeight: '900', marginTop: 14 }, settlementText: { color: colors.muted, fontSize: 10, lineHeight: 17, marginTop: 6 }, settledCard: { padding: 17, marginTop: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 22, backgroundColor: colors.greenSoft }, settledEyebrow: { color: colors.green, fontSize: 10, fontWeight: '900' }, settledAmount: { color: colors.greenDark, fontSize: 27, fontWeight: '900', marginTop: 4 }, settledMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 }, settledText: { color: colors.greenDark, fontSize: 10, fontWeight: '800' },
  aftercareMeta: { color: colors.muted, fontSize: 9, marginTop: 4 }, pill: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.primarySoft }, pillWarn: { backgroundColor: colors.primarySoft }, pillSuccess: { backgroundColor: colors.greenSoft }, pillMuted: { backgroundColor: colors.canvas }, pillText: { color: colors.primaryDark, fontSize: 9, fontWeight: '900' }, pillTextWarn: { color: colors.amber }, pillTextSuccess: { color: colors.greenDark }, pillTextMuted: { color: colors.muted }, refundAmount: { flexDirection: 'row', justifyContent: 'space-between', padding: 12, marginTop: 14, borderRadius: 14, backgroundColor: colors.primarySoft }, refundLabel: { color: colors.muted, fontSize: 10 }, refundValue: { color: colors.primaryDark, fontSize: 12, fontWeight: '900' }, waitText: { color: colors.amber, fontSize: 10, lineHeight: 16, marginTop: 14 },
});
