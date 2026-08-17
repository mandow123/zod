import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import {
  checkListingWindow, listSupplierListings, listSupplierOffers, loadSupplierWorkspace, publishCreditListing,
  type ComputeResource, type ListingWindowAvailability, type OfferTemplate,
} from './publishing';
import { isAmbiguousMutationFailure, listingPublicationAccepted, unknownSubmissionMessage } from './mutation-recovery';
import { colors } from './theme';
import { creditAmount } from './format';
import { resourceIsDeliverable, resourceNodeCopy, type ResourceNodeUiState } from './resource-delivery-readiness';

type StartChoice = 'now' | 'tomorrow' | 'scheduled';
type DurationDays = 7 | 30 | 90;

function scaled(value: string) {
  const normalized = value.trim().replace(/^0+(?=\d)/u, '');
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u.test(normalized)) return null;
  const [whole = '0', fraction = ''] = normalized.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

function displayQuantity(value: bigint) {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/u, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function startDate(choice: StartChoice, scheduledStart: string | null = null) {
  if (choice === 'now') return new Date(Date.now() + 15_000);
  if (choice === 'scheduled' && scheduledStart) return new Date(scheduledStart);
  const value = new Date();
  value.setDate(value.getDate() + 1);
  value.setHours(0, 0, 0, 0);
  return value;
}

function dateLabel(value: Date) {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}年${value.getMonth() + 1}月${value.getDate()}日 ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

export function ListingPublishSheet({ visible, offerId, onClose, onPublished }: Readonly<{
  visible: boolean;
  offerId: string | null;
  onClose: () => void;
  onPublished: () => void | Promise<void>;
}>) {
  const [offer, setOffer] = useState<OfferTemplate | null>(null);
  const [resource, setResource] = useState<ComputeResource | null>(null);
  const [quantity, setQuantity] = useState('');
  const [start, setStart] = useState<StartChoice>('now');
  const [scheduledStart, setScheduledStart] = useState<string | null>(null);
  const [days, setDays] = useState<DurationDays>(7);
  const [availability, setAvailability] = useState<ListingWindowAvailability | null>(null);
  const [checkingWindow, setCheckingWindow] = useState(false);
  const [windowError, setWindowError] = useState<string | null>(null);
  const [availabilityReload, setAvailabilityReload] = useState(0);
  const [loadRevision, setLoadRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<{ signature: string; id: string } | null>(null);
  const publishInFlightRef = useRef(false);

  useEffect(() => {
    if (!visible || !offerId) return;
    let active = true;
    setLoading(true); setError(null); setOffer(null); setResource(null); setStart('now'); setScheduledStart(null); setDays(7);
    setAvailability(null); setWindowError(null); requestRef.current = null; publishInFlightRef.current = false;
    void Promise.all([listSupplierOffers(), loadSupplierWorkspace()]).then(([offers, workspace]) => {
      if (!active) return;
      const nextOffer = offers.find((item) => item.id === offerId) ?? null;
      if (!nextOffer) throw new Error('没有找到这份上架方案。');
      if (nextOffer.status !== 'approved') throw new Error('双审通过后才能发布可售容量。');
      if (!nextOffer.approvedUnitCredits) throw new Error('这份方案还没有审核单价，暂时不能挂牌。');
      const nextResource = workspace.resources.find((item) => item.id === nextOffer.resourceId) ?? null;
      if (!nextResource) throw new Error('没有找到对应的资源。');
      setOffer(nextOffer); setResource(nextResource); setQuantity(displayQuantity(scaled(nextResource.capacityTotal) ?? 0n));
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : '读取挂牌信息失败。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadRevision, offerId, visible]);

  const window = useMemo(() => {
    const startsAt = startDate(start, scheduledStart);
    return { startsAt, expiresAt: new Date(startsAt.getTime() + days * 86_400_000) };
  }, [days, scheduledStart, start]);

  const durationFits = (value: DurationDays) => {
    if (!offer?.auditValidUntil) return false;
    const startsAt = startDate(start, scheduledStart);
    return startsAt.getTime() + value * 86_400_000 <= new Date(offer.auditValidUntil).getTime();
  };

  useEffect(() => {
    if (!offer || durationFits(days)) return;
    const next = ([7, 30, 90] as const).find((value) => durationFits(value));
    if (next) setDays(next);
  }, [days, offer, start]);

  useEffect(() => {
    if (!visible || !offer || !resource || !resourceIsDeliverable(resource.deliveryReadiness) || !durationFits(days)) return;
    let active = true;
    setCheckingWindow(true); setWindowError(null); setAvailability(null);
    const input = start === 'now'
      ? { startMode: 'immediate' as const, durationDays: days }
      : { startMode: 'scheduled' as const, startsAt: window.startsAt.toISOString(), expiresAt: window.expiresAt.toISOString() };
    void checkListingWindow(offer.id, input)
      .then((result) => { if (active) setAvailability(result); })
      .catch(() => { if (active) setWindowError('这段时间暂时没确认成功，请重试。'); })
      .finally(() => { if (active) setCheckingWindow(false); });
    return () => { active = false; };
  }, [availabilityReload, days, offer, resource, scheduledStart, start, visible, window.expiresAt, window.startsAt]);

  const selectRatio = (numerator: bigint, denominator: bigint) => {
    if (!resource) return;
    const total = scaled(resource.capacityTotal);
    if (!total) return;
    setQuantity(displayQuantity((total * numerator) / denominator));
    setError(null); requestRef.current = null;
  };

  const publish = async () => {
    if (!offer || !resource || publishInFlightRef.current) return;
    if (!resourceIsDeliverable(resource.deliveryReadiness)) {
      setError('节点当前不可交付，恢复并通过在线检查后才能挂牌。');
      return;
    }
    if (!offer.approvedUnitCredits) { setError('这份方案还没有审核单价，暂时不能挂牌。'); return; }
    const value = scaled(quantity); const total = scaled(resource.capacityTotal); const minimum = scaled(offer.minimumQuantity);
    if (!value || value <= 0n) { setError('请输入大于零的可售数量。'); return; }
    if (minimum && value < minimum) { setError(`可售数量不能低于 ${displayQuantity(minimum)} ${offer.nativeUnit}。`); return; }
    if (total && value > total) { setError(`最多可发布 ${displayQuantity(total)} ${resource.capacityUnit}。`); return; }
    const submitStartsAt = startDate(start, scheduledStart);
    const submitExpiresAt = new Date(submitStartsAt.getTime() + days * 86_400_000);
    const auditLimit = offer.auditValidUntil ? new Date(offer.auditValidUntil) : null;
    if (!auditLimit || submitExpiresAt > auditLimit) { setError('所选结束时间超过审核有效期，请缩短上架天数。'); return; }
    const normalizedQuantity = displayQuantity(value);
    const input = start === 'now'
      ? { offerId: offer.id, capacityTotal: normalizedQuantity, startMode: 'immediate' as const, durationDays: days }
      : { offerId: offer.id, capacityTotal: normalizedQuantity, startMode: 'scheduled' as const, startsAt: submitStartsAt.toISOString(), expiresAt: submitExpiresAt.toISOString() };
    const signature = JSON.stringify(input);
    if (!requestRef.current || requestRef.current.signature !== signature) requestRef.current = { signature, id: `listing-publish-${Crypto.randomUUID()}` };
    publishInFlightRef.current = true;
    setSubmitting(true); setError(null);
    const finishPublished = () => {
      requestRef.current = null;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
      // The listing mutation is already authoritative at this point. A later
      // snapshot/cache refresh must never turn that confirmed write back into
      // an unknown submission or leave the provider able to submit it again.
      void Promise.resolve().then(onPublished).catch(() => {
        Alert.alert('挂牌已成功', '最新状态暂时没有同步，请稍后在上架进度下拉刷新。');
      });
    };
    try {
      const latest = await checkListingWindow(offer.id, start === 'now'
        ? { startMode: 'immediate', durationDays: days }
        : { startMode: 'scheduled', startsAt: submitStartsAt.toISOString(), expiresAt: submitExpiresAt.toISOString() });
      setAvailability(latest);
      if (latest.status === 'window_conflict') {
        setError('这段时间刚刚有了新的挂牌，请换到下一段可用时间。');
        return;
      }
      await publishCreditListing(input, requestRef.current.id);
      finishPublished();
    } catch (reason) {
      if (isAmbiguousMutationFailure(reason)) {
        try {
          if (listingPublicationAccepted(offer.id, await listSupplierListings())) {
            finishPublished();
            return;
          }
        } catch { /* Keep the original unknown result and the same idempotency key. */ }
        setError(unknownSubmissionMessage);
      } else setError(reason instanceof Error ? reason.message : '挂牌没有完成，请重试。');
    } finally { publishInFlightRef.current = false; setSubmitting(false); }
  };

  const closeSafely = () => {
    if (publishInFlightRef.current) return;
    onClose();
  };

  const approvedPrice = offer?.approvedUnitCredits ?? null;
  const node = resourceNodeCopy(resource?.deliveryReadiness);
  const deliverable = resourceIsDeliverable(resource?.deliveryReadiness);
  const initialLoadFailed = !loading && Boolean(error) && (!offer || !resource || !approvedPrice);

  return <Modal visible={visible} animationType="slide" transparent onRequestClose={closeSafely}>
    <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <View><Text style={styles.eyebrow}>最后一步</Text><Text style={styles.title}>发布可售容量</Text></View>
          <Pressable disabled={submitting} onPress={closeSafely} style={[styles.close, submitting && styles.disabled]}><Ionicons name="close" size={23} color={colors.ink} /></Pressable>
        </View>
        {loading ? <View style={styles.center}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>正在读取双审结果…</Text></View> : null}
        {!loading ? <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} showsVerticalScrollIndicator={false}>
          {error ? <View style={styles.errorBox}><Ionicons name="alert-circle-outline" size={18} color={colors.red} /><Text style={styles.errorText}>{error}</Text></View> : null}
          {initialLoadFailed ? <Pressable accessibilityRole="button" accessibilityLabel="重新读取挂牌信息" onPress={() => setLoadRevision((value) => value + 1)} style={styles.loadRetryButton}><Ionicons name="refresh-outline" size={17} color={colors.surface} /><Text style={styles.loadRetryText}>重新读取</Text></Pressable> : null}
          {offer && resource && approvedPrice ? <>
            <View style={styles.approvedCard}>
              <View style={styles.approvedTop}><View><Text style={styles.approvedLabel}>双审通过</Text><Text style={styles.offerTitle}>{offer.title}</Text></View><Ionicons name="shield-checkmark" size={30} color={colors.green} /></View>
              <Text style={styles.price}>{creditAmount(approvedPrice)} <Text style={styles.priceUnit}>KAI 卡时 / {offer.nativeUnit}</Text></Text>
              <Text style={styles.conversion}>最终挂牌单价由平台价格审核锁定</Text>
            </View>

            <View style={[styles.nodeCard, node.state === 'ready' && styles.nodeReady, node.state === 'offline' && styles.nodeOffline, node.state === 'revoked' && styles.nodeRevoked]}>
              <View style={[styles.nodeDot, nodeDotStyle[node.state]]} />
              <View style={styles.nodeCopy}><Text style={styles.nodeTitle}>节点 · {node.label}</Text><Text style={styles.nodeText}>{node.detail}</Text></View>
            </View>

            <Text style={styles.fieldLabel}>本次可售数量</Text>
            <View style={styles.quantityRow}><TextInput value={quantity} onChangeText={(value) => { setQuantity(value.replace(/[^0-9.]/gu, '')); setError(null); requestRef.current = null; }} keyboardType="decimal-pad" style={styles.quantityInput} /><Text style={styles.quantityUnit}>{resource.capacityUnit}</Text></View>
            <Text style={styles.fieldHint}>资料核验容量 {displayQuantity(scaled(resource.capacityTotal) ?? 0n)} {resource.capacityUnit} · 最低 {displayQuantity(scaled(offer.minimumQuantity) ?? 0n)}</Text>
            <View style={styles.chips}>
              {[[1n, 4n, '25%'], [1n, 2n, '50%'], [1n, 1n, '全部']] .map(([numerator, denominator, label]) => <Pressable key={String(label)} onPress={() => selectRatio(numerator as bigint, denominator as bigint)} style={styles.chip}><Text style={styles.chipText}>{String(label)}</Text></Pressable>)}
            </View>

            <Text style={styles.fieldLabel}>开始时间</Text>
            <View style={styles.options}>
              {([{ key: 'now', label: '立即', meta: '发布后生效' }, { key: 'tomorrow', label: '明天', meta: '00:00 生效' }] as const).map((item) => <Pressable key={item.key} onPress={() => { setStart(item.key); setScheduledStart(null); setError(null); requestRef.current = null; }} style={[styles.option, start === item.key && styles.optionActive]}><Text style={[styles.optionLabel, start === item.key && styles.optionLabelActive]}>{item.label}</Text><Text style={[styles.optionMeta, start === item.key && styles.optionMetaActive]}>{item.meta}</Text></Pressable>)}
              {start === 'scheduled' && scheduledStart ? <View style={[styles.option, styles.optionActive]}><Text style={[styles.optionLabel, styles.optionLabelActive]}>接着上架</Text><Text style={[styles.optionMeta, styles.optionMetaActive]}>{dateLabel(new Date(scheduledStart))}</Text></View> : null}
            </View>

            <Text style={styles.fieldLabel}>持续时间</Text>
            <View style={styles.options}>
              {([7, 30, 90] as const).map((value) => { const fits = durationFits(value); return <Pressable key={value} disabled={!fits} onPress={() => { setDays(value); setError(null); requestRef.current = null; }} style={[styles.duration, days === value && styles.durationActive, !fits && styles.durationDisabled]}><Text style={[styles.durationText, days === value && styles.durationTextActive, !fits && styles.durationTextDisabled]}>{value} 天</Text></Pressable>; })}
            </View>

            {deliverable ? <WindowAvailability
              availability={availability}
              checking={checkingWindow}
              error={windowError}
              days={days}
              onRetry={() => setAvailabilityReload((value) => value + 1)}
              onUseNext={(value) => { setScheduledStart(value); setStart('scheduled'); setError(null); requestRef.current = null; }}
            /> : <View style={[styles.windowCard, styles.windowBlocked]}><Ionicons name="lock-closed-outline" size={19} color={colors.amber} /><Text style={styles.windowText}>节点恢复可交付后，才会检查可售时段。</Text></View>}

            <View style={styles.summary}>
              <SummaryRow label="可售" value={`${displayQuantity(scaled(quantity) ?? 0n)} ${resource.capacityUnit}`} />
              <SummaryRow label="时段" value={start === 'now' ? `确认后立即生效 · 持续 ${days} 天` : `${dateLabel(window.startsAt)} — ${dateLabel(window.expiresAt)}`} />
              <SummaryRow label="单价" value={`${creditAmount(approvedPrice)} KAI 卡时`} />
            </View>
            <Text style={styles.auditLimit}>审核有效至 {offer.auditValidUntil ? dateLabel(new Date(offer.auditValidUntil)) : '—'}</Text>
            <Pressable disabled={!deliverable || submitting || checkingWindow || availability?.status !== 'available'} onPress={() => void publish()} style={[styles.primary, (!deliverable || submitting || checkingWindow || availability?.status !== 'available') && styles.disabled]}>{submitting ? <><ActivityIndicator color={colors.surface} /><Text style={styles.primaryText}>正在确认挂牌…</Text></> : <><Text style={styles.primaryText}>{!deliverable ? '节点可交付后再挂牌' : checkingWindow ? '正在确认时段' : availability?.status === 'window_conflict' ? '请先更换时间' : '确认挂牌'}</Text><Ionicons name={deliverable ? 'arrow-forward' : 'lock-closed-outline'} size={18} color={colors.surface} /></>}</Pressable>
          </> : null}
        </ScrollView> : null}
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

function WindowAvailability({ availability, checking, error, days, onRetry, onUseNext }: Readonly<{
  availability: ListingWindowAvailability | null;
  checking: boolean;
  error: string | null;
  days: DurationDays;
  onRetry: () => void;
  onUseNext: (value: string) => void;
}>) {
  if (checking) return <View style={styles.windowCard}><ActivityIndicator size="small" color={colors.primary} /><Text style={styles.windowText}>正在确认这段时间…</Text></View>;
  if (error) return <View style={[styles.windowCard, styles.windowError]}><Ionicons name="cloud-offline-outline" size={19} color={colors.red} /><Text style={styles.windowText}>{error}</Text><Pressable onPress={onRetry}><Text style={styles.retryText}>重试</Text></Pressable></View>;
  if (availability?.status === 'available') return <View style={[styles.windowCard, styles.windowAvailable]}><Ionicons name="checkmark-circle" size={20} color={colors.green} /><View style={styles.windowCopy}><Text style={styles.windowTitle}>这个时段可以上架</Text><Text style={styles.windowCaption}>可发布 {displayQuantity(scaled(availability.capacityTotal) ?? 0n)} {availability.capacityUnit}</Text></View></View>;
  if (availability?.status === 'window_conflict') return <View style={[styles.windowCard, styles.windowConflict]}>
    <Ionicons name="calendar-outline" size={20} color="#9A6400" />
    <View style={styles.windowCopy}><Text style={styles.windowTitle}>这段时间已有挂牌</Text><Text style={styles.windowCaption}>{availability.blockingExpiresAt ? `占用至 ${dateLabel(new Date(availability.blockingExpiresAt))}` : '请更换开始时间'}</Text>
      {availability.nextAvailableAt ? <Pressable onPress={() => onUseNext(availability.nextAvailableAt!)} style={styles.nextButton}><Text style={styles.nextButtonText}>从 {dateLabel(new Date(availability.nextAvailableAt))} 接着上架</Text><Ionicons name="arrow-forward" size={14} color="#7A5000" /></Pressable>
        : <Text style={styles.noWindowText}>审核有效期内没有完整的 {days} 天空档。</Text>}
    </View>
  </View>;
  return null;
}

function SummaryRow({ label, value }: Readonly<{ label: string; value: string }>) {
  return <View style={styles.summaryRow}><Text style={styles.summaryLabel}>{label}</Text><Text style={styles.summaryValue}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.42)' }, sheet: { height: '94%', borderTopLeftRadius: 30, borderTopRightRadius: 30, overflow: 'hidden', backgroundColor: colors.canvas }, handle: { width: 42, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 9, backgroundColor: '#D0D5DD' },
  header: { minHeight: 74, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, eyebrow: { color: colors.primary, fontSize: 9, fontWeight: '900', letterSpacing: 1.5 }, title: { color: colors.ink, fontSize: 25, fontWeight: '900', marginTop: 3 }, close: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, center: { flex: 1, alignItems: 'center', justifyContent: 'center' }, loadingText: { color: colors.muted, fontSize: 12, marginTop: 10 }, content: { padding: 17, paddingBottom: 40 },
  errorBox: { padding: 12, marginBottom: 14, borderRadius: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#FDECEC' }, errorText: { flex: 1, color: colors.red, fontSize: 11, lineHeight: 17 }, approvedCard: { minHeight: 155, padding: 17, marginBottom: 22, borderRadius: 23, borderWidth: 1, borderColor: '#D5E5FA', backgroundColor: colors.surface }, approvedTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, approvedLabel: { color: colors.green, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 }, offerTitle: { color: colors.ink, fontSize: 18, fontWeight: '900', marginTop: 5 }, price: { color: colors.primaryDark, fontSize: 27, fontWeight: '900', marginTop: 20 }, priceUnit: { color: colors.primary, fontSize: 11 }, conversion: { color: colors.muted, fontSize: 9, marginTop: 7 },
  loadRetryButton: { minHeight: 50, marginBottom: 17, borderRadius: 16, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, loadRetryText: { color: colors.surface, fontSize: 12, fontWeight: '900' },
  nodeCard: { marginTop: -10, marginBottom: 18, padding: 13, borderRadius: 17, flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: colors.amberSoft }, nodeReady: { backgroundColor: colors.greenSoft }, nodeOffline: { backgroundColor: '#FFF1F1' }, nodeRevoked: { backgroundColor: '#F4F4F5' }, nodeDot: { width: 9, height: 9, marginTop: 4, borderRadius: 5 }, nodeCopy: { flex: 1 }, nodeTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' }, nodeText: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 4 },
  fieldLabel: { color: colors.ink, fontSize: 13, fontWeight: '900', marginBottom: 8, marginTop: 3 }, quantityRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, borderWidth: 1, borderColor: colors.line, borderRadius: 17, backgroundColor: colors.surface }, quantityInput: { flex: 1, color: colors.ink, fontSize: 22, fontWeight: '900' }, quantityUnit: { color: colors.muted, fontSize: 12, fontWeight: '800' }, fieldHint: { color: colors.muted, fontSize: 10, marginTop: 7 }, chips: { flexDirection: 'row', gap: 8, marginTop: 10, marginBottom: 22 }, chip: { minWidth: 66, paddingHorizontal: 13, paddingVertical: 9, alignItems: 'center', borderRadius: 999, backgroundColor: colors.primarySoft }, chipText: { color: colors.primary, fontSize: 11, fontWeight: '900' },
  options: { flexDirection: 'row', gap: 9, marginBottom: 22 }, option: { flex: 1, minHeight: 67, padding: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 17, backgroundColor: colors.surface }, optionActive: { borderColor: colors.primary, backgroundColor: colors.primary }, optionLabel: { color: colors.ink, fontSize: 14, fontWeight: '900' }, optionLabelActive: { color: colors.surface }, optionMeta: { color: colors.muted, fontSize: 9, marginTop: 5 }, optionMetaActive: { color: '#DCE9FC' }, duration: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line, borderRadius: 15, backgroundColor: colors.surface }, durationActive: { borderColor: colors.primary, backgroundColor: colors.primary }, durationDisabled: { opacity: 0.42 }, durationText: { color: colors.ink, fontSize: 12, fontWeight: '900' }, durationTextActive: { color: colors.surface }, durationTextDisabled: { color: colors.subtle },
  windowCard: { minHeight: 64, marginBottom: 17, padding: 13, borderRadius: 17, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surface }, windowAvailable: { backgroundColor: colors.greenSoft }, windowConflict: { alignItems: 'flex-start', backgroundColor: '#FFF3D7' }, windowError: { backgroundColor: '#FDECEC' }, windowBlocked: { backgroundColor: colors.amberSoft }, windowCopy: { flex: 1 }, windowTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' }, windowText: { flex: 1, color: colors.ink, fontSize: 11, fontWeight: '800' }, windowCaption: { color: colors.muted, fontSize: 10, lineHeight: 15, marginTop: 3 }, retryText: { color: colors.red, fontSize: 11, fontWeight: '900' }, nextButton: { minHeight: 37, marginTop: 9, paddingHorizontal: 11, borderRadius: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FFE4A8' }, nextButtonText: { flex: 1, color: '#7A5000', fontSize: 10, fontWeight: '900' }, noWindowText: { color: '#7A5000', fontSize: 10, marginTop: 8 },
  summary: { paddingHorizontal: 15, paddingVertical: 5, borderRadius: 20, backgroundColor: colors.surface }, summaryRow: { minHeight: 49, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line }, summaryLabel: { color: colors.muted, fontSize: 10 }, summaryValue: { maxWidth: '74%', color: colors.ink, fontSize: 11, fontWeight: '900', textAlign: 'right' }, auditLimit: { color: colors.muted, fontSize: 9, textAlign: 'center', marginTop: 12 }, primary: { minHeight: 55, marginTop: 15, borderRadius: 17, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 14, fontWeight: '900' }, disabled: { opacity: 0.55 },
});

const nodeDotStyle: Record<ResourceNodeUiState, Readonly<{ backgroundColor: string }>> = {
  unbound: { backgroundColor: colors.amber }, checking: { backgroundColor: colors.blue },
  ready: { backgroundColor: colors.green }, offline: { backgroundColor: colors.red }, revoked: { backgroundColor: colors.red },
};
