import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { ApiError } from './api-client';
import { creditAmount } from './format';
import { colors } from './theme';
import { createVastOrder, createVastQuote, newVastOrderKey, type VastOffer, type VastOrder, type VastQuote } from './vast-commerce';

const durations = [1, 8, 24, 72] as const;

export function VastPurchaseSheet({ offer, visible, onClose, onOrdered }: Readonly<{
  offer: VastOffer | null;
  visible: boolean;
  onClose: () => void;
  onOrdered: (order: VastOrder) => void;
}>) {
  const [durationHours, setDurationHours] = useState<number>(8);
  const [quote, setQuote] = useState<VastQuote | null>(null);
  const [order, setOrder] = useState<VastOrder | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState(newVastOrderKey);
  const [unknownSubmission, setUnknownSubmission] = useState(false);
  const [quoteVersion, setQuoteVersion] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now);

  useEffect(() => {
    if (!visible || !offer) return;
    let active = true;
    setLoading(true); setError(null); setQuote(null); setOrder(null);
    void createVastQuote(offer.offerId, durationHours).then((value) => {
      if (!active) return;
      setQuote(value); setRequestKey(newVastOrderKey()); setUnknownSubmission(false);
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : '报价暂时无法确认。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [durationHours, offer, quoteVersion, visible]);

  useEffect(() => {
    if (!visible) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [visible]);

  const expired = quote ? new Date(quote.expiresAt).getTime() <= nowMs : true;
  const quoteTime = useMemo(() => quote ? new Date(quote.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null, [quote]);
  const submit = async () => {
    if (!quote || expired || submitting) return;
    setSubmitting(true); setError(null);
    try {
      const next = await createVastOrder(quote.quoteId, requestKey);
      setOrder(next); setUnknownSubmission(false); onOrdered(next);
    } catch (reason) {
      if (reason instanceof ApiError && ['VAST_QUOTE_EXPIRED', 'VAST_QUOTE_PRICE_CHANGED', 'VAST_OFFER_UNAVAILABLE'].includes(reason.code)) setQuote(null);
      if (reason instanceof ApiError && (reason.status === 0 || reason.code === 'VAST_RECONCILIATION_PENDING')) setUnknownSubmission(true);
      setError(reason instanceof Error ? reason.message : '订单暂时无法确认，请勿重复提交。');
    }
    finally { setSubmitting(false); }
  };
  if (!offer) return null;

  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <View style={styles.backdrop}><View style={styles.sheet}>
      <View style={styles.handle} /><View style={styles.header}><View><Text style={styles.eyebrow}>Vast.ai 合作资源</Text><Text style={styles.title}>确认即时算力</Text></View><Pressable onPress={onClose} style={styles.close}><Ionicons name="close" size={22} color={colors.ink} /></Pressable></View>
      <View style={styles.resource}><View style={styles.gpuIcon}><Ionicons name="flash-outline" size={22} color={colors.primary} /></View><View style={styles.resourceCopy}><Text style={styles.resourceTitle}>{offer.gpu.count} × {offer.gpu.name}</Text><Text style={styles.resourceMeta}>{offer.gpu.memoryGb} GB 显存 / 卡 · {offer.region}</Text></View><View><Text style={styles.rate}>{creditAmount(offer.pricing.cardHoursPerHour)}</Text><Text style={styles.rateUnit}>卡时 / 小时</Text></View></View>
      <Text style={styles.sectionLabel}>使用时长</Text><View style={styles.durations}>{durations.map((hours) => <Pressable key={hours} disabled={submitting} onPress={() => setDurationHours(hours)} style={[styles.duration, durationHours === hours && styles.durationActive]}><Text style={[styles.durationText, durationHours === hours && styles.durationTextActive]}>{hours} 小时</Text></Pressable>)}</View>
      <View style={styles.quoteCard}>{loading ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.hint}>正在重新确认库存与卡时价格…</Text></View> : quote ? <><View style={styles.quoteRow}><Text style={styles.quoteLabel}>本次预留</Text><Text style={styles.total}>{creditAmount(quote.pricing.totalCardHours)} 卡时</Text></View><View style={styles.quoteRow}><Text style={styles.hint}>{creditAmount(quote.pricing.cardHoursPerHour)} 卡时 / 小时 × {quote.durationHours} 小时</Text><Text style={styles.hint}>{quoteTime} 前有效</Text></View></> : <Text style={styles.hint}>尚未取得有效报价。</Text>}</View>
      {error ? <View style={styles.error}><Ionicons name="alert-circle-outline" size={18} color={colors.amber} /><Text style={styles.errorText}>{error}</Text></View> : null}
      {order ? <View style={styles.result}><Ionicons name="checkmark-circle" size={24} color={colors.green} /><View style={styles.resultCopy}><Text style={styles.resultTitle}>{order.status === 'pending_reconciliation' ? '订单正在核对' : '实例已进入部署'}</Text><Text style={styles.resultText}>{order.status === 'pending_reconciliation' ? '提交结果尚未完全确认，平台不会重复创建实例。' : '可在“我的资产”跟踪部署和运行状态。'}</Text></View></View> : null}
      <View style={styles.notice}><Ionicons name="shield-checkmark-outline" size={17} color={colors.muted} /><Text style={styles.noticeText}>平台会在提交前再次核对报价。资源已被租用或价格上涨时，不会按旧报价扣卡时。</Text></View>
      {order ? <Pressable onPress={onClose} style={styles.primary}><Text style={styles.primaryText}>完成</Text></Pressable>
        : unknownSubmission && quote ? <Pressable disabled={submitting} onPress={() => void submit()} style={styles.primary}>{submitting ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>核对订单状态</Text>}</Pressable>
        : expired && quote ? <Pressable disabled={loading || submitting} onPress={() => setQuoteVersion((value) => value + 1)} style={styles.primary}><Text style={styles.primaryText}>报价已失效，重新确认</Text></Pressable>
        : !quote && error ? <Pressable disabled={loading || submitting} onPress={() => setQuoteVersion((value) => value + 1)} style={styles.primary}><Text style={styles.primaryText}>重新确认报价</Text></Pressable>
        : <Pressable disabled={!quote || loading || submitting} onPress={() => void submit()} style={[styles.primary, (!quote || loading || submitting) && styles.primaryDisabled]}>{submitting ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>{unknownSubmission ? '核对订单状态' : quote ? `确认并预留 ${creditAmount(quote.pricing.totalCardHours)} 卡时` : '等待有效报价'}</Text>}</Pressable>}
    </View></View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(18,35,58,0.38)' }, sheet: { padding: 18, paddingBottom: 28, borderTopLeftRadius: 18, borderTopRightRadius: 18, backgroundColor: colors.canvas }, handle: { width: 42, height: 5, alignSelf: 'center', borderRadius: 3, backgroundColor: '#D6DEE8' }, header: { minHeight: 72, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, eyebrow: { color: colors.primary, fontSize: 10, fontWeight: '900' }, title: { color: colors.ink, fontSize: 21, fontWeight: '900', marginTop: 4 }, close: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  resource: { padding: 14, flexDirection: 'row', alignItems: 'center', borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, gpuIcon: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, resourceCopy: { flex: 1, marginLeft: 11 }, resourceTitle: { color: colors.ink, fontSize: 14, fontWeight: '900' }, resourceMeta: { color: colors.muted, fontSize: 9, marginTop: 4 }, rate: { color: colors.ink, fontSize: 15, fontWeight: '900', textAlign: 'right' }, rateUnit: { color: colors.muted, fontSize: 8, marginTop: 3, textAlign: 'right' },
  sectionLabel: { color: colors.ink, fontSize: 12, fontWeight: '900', marginTop: 16, marginBottom: 9 }, durations: { flexDirection: 'row', gap: 7 }, duration: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, durationActive: { backgroundColor: colors.primarySoft, borderColor: '#AFC9ED' }, durationText: { color: colors.muted, fontSize: 10, fontWeight: '800' }, durationTextActive: { color: colors.primary },
  quoteCard: { minHeight: 74, padding: 14, marginTop: 12, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, justifyContent: 'center' }, loading: { flexDirection: 'row', alignItems: 'center', gap: 9 }, quoteRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, quoteLabel: { color: colors.muted, fontSize: 10 }, total: { color: colors.ink, fontSize: 17, fontWeight: '900' }, hint: { color: colors.muted, fontSize: 9, marginTop: 7 }, error: { flexDirection: 'row', gap: 8, padding: 11, marginTop: 10, borderRadius: 10, backgroundColor: colors.amberSoft }, errorText: { flex: 1, color: colors.ink, fontSize: 9, lineHeight: 15 }, result: { flexDirection: 'row', gap: 10, padding: 13, marginTop: 10, borderRadius: 11, backgroundColor: colors.greenSoft }, resultCopy: { flex: 1 }, resultTitle: { color: colors.ink, fontSize: 11, fontWeight: '900' }, resultText: { color: colors.muted, fontSize: 9, lineHeight: 15, marginTop: 3 }, notice: { flexDirection: 'row', gap: 8, marginTop: 13 }, noticeText: { flex: 1, color: colors.muted, fontSize: 9, lineHeight: 15 }, primary: { minHeight: 50, marginTop: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryDisabled: { opacity: 0.45 }, primaryText: { color: colors.surface, fontSize: 12, fontWeight: '900' },
});
