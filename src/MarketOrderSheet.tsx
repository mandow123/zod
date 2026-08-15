import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { ApiError } from './api-client';
import { createCloudPayOrder, type CloudPayOrder, type CreditBalance, type MarketCreditListing } from './api';
import { colors } from './theme';
import { distributionPolicy } from './distribution';
import { creditAmount } from './format';
import { gpuHourMeaning, isDedicatedGpuHour } from './compute-product';
import { isAmbiguousMutationFailure } from './mutation-recovery';

const SCALE = 1_000_000n;

function scaled(value: string) {
  const normalized = value.trim().replace(/^0+(?=\d)/u, '');
  if (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/u.test(normalized)) return null;
  const [whole = '0', fraction = ''] = normalized.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
}

function decimal(value: bigint) {
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(6, '0').replace(/0+$/u, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function totalMicros(quantity: bigint, unitCredits: bigint) {
  return (quantity * unitCredits + SCALE - 1n) / SCALE;
}

export function MarketOrderSheet({ listing, balance, authenticated, onClose, onLogin, onNeedCredits, onCreated }: Readonly<{
  listing: MarketCreditListing | null;
  balance: CreditBalance | null;
  authenticated: boolean;
  onClose: () => void;
  onLogin: () => void;
  onNeedCredits: () => void;
  onCreated: (order: CloudPayOrder) => void | Promise<void>;
}>) {
  const [quantity, setQuantity] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    if (!listing) return;
    setQuantity(decimal(scaled(listing.minimumQuantity) ?? 0n));
    setError(null); setBusy(false); request.current = null;
  }, [listing]);

  const amounts = useMemo(() => {
    const selected = scaled(quantity);
    const minimum = listing ? scaled(listing.minimumQuantity) : null;
    const available = listing ? scaled(listing.capacityAvailable) : null;
    const unit = listing ? scaled(listing.unitCredits) : null;
    const wallet = balance ? scaled(balance.available) : null;
    const total = selected && unit ? totalMicros(selected, unit) : null;
    return { selected, minimum, available, total, wallet };
  }, [balance, listing, quantity]);

  if (!listing) return null;
  const physicalProduct = listing.productKind === 'hardware_device';
  const invalidQuantity = !amounts.selected || !amounts.minimum || !amounts.available
    || amounts.selected < amounts.minimum || amounts.selected > amounts.available;
  const insufficient = Boolean(authenticated && amounts.total && amounts.wallet !== null && amounts.total > amounts.wallet);

  const submit = async () => {
    if (!distributionPolicy.newOrders) { setError('此版本不提供新增购买。'); return; }
    if (!physicalProduct && !isDedicatedGpuHour(listing)) { setError('这项资源还没有接入自动交付，暂时不能购买。'); return; }
    if (!authenticated) { onLogin(); return; }
    if (invalidQuantity || !amounts.selected || !amounts.total) {
      setError(`购买数量需在 ${decimal(amounts.minimum ?? 0n)} 至 ${decimal(amounts.available ?? 0n)} ${listing.capacityUnit} 之间。`);
      return;
    }
    if (!balance) { setError('卡时余额暂时没有读取成功，请稍后重试。'); return; }
    if (insufficient) { onNeedCredits(); return; }
    const normalized = decimal(amounts.selected);
    const signature = `${listing.id}:${normalized}`;
    if (!request.current || request.current.signature !== signature) {
      request.current = { signature, key: `market-order:${Crypto.randomUUID()}` };
    }
    setBusy(true); setError(null);
    try {
      const order = await createCloudPayOrder(listing.id, normalized, request.current.key);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
      await onCreated(order);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'KAI_CREDIT_INSUFFICIENT') {
        setError('可用卡时不足。这次没有生成订单，也没有预留资源。');
      } else if (isAmbiguousMutationFailure(reason)) {
        setError('网络中断，订单结果正在确认。请保持当前数量再点一次，系统会核对同一笔请求，不会重复下单。');
      } else {
        setError(reason instanceof Error ? reason.message : '订单没有提交成功，请重试。');
      }
    } finally { setBusy(false); }
  };

  const confirm = () => {
    if (!authenticated) { onLogin(); return; }
    if (invalidQuantity || insufficient || !amounts.total) { void submit(); return; }
    const duration = decimal(amounts.selected ?? 0n);
    Alert.alert(physicalProduct ? '确认采购' : '确认购买', physicalProduct
      ? `采购 ${duration} ${listing.capacityUnit}，预计使用 ${creditAmount(decimal(amounts.total))} KAI 卡时。库存、价格与交付以服务端最终确认为准。`
      : `${gpuHourMeaning(duration)}。本次预留 ${creditAmount(decimal(amounts.total))} KAI 卡时；实例健康并取得连接信息后才开始计费。`, [
      { text: '再看看', style: 'cancel' },
      { text: '确认预留', onPress: () => void submit() },
    ]);
  };

  return <Modal visible animationType="slide" transparent onRequestClose={onClose}>
    <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <View style={styles.headerCopy}><Text style={styles.eyebrow}>购买算力</Text><Text numberOfLines={1} style={styles.title}>{listing.title}</Text></View>
          <Pressable onPress={onClose} style={styles.close}><Ionicons name="close" size={23} color={colors.ink} /></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.approvedCard}>
            <View style={styles.approvedTop}>
              <View><Text style={styles.approvedLabel}>资源与价格均已审核</Text><Text style={styles.product}>{listing.productCode} · {listing.region}</Text></View>
              <Ionicons name="shield-checkmark" size={30} color={colors.green} />
            </View>
            <Text style={styles.price}>{creditAmount(listing.unitCredits)} <Text style={styles.priceUnit}>KAI 卡时 / {listing.capacityUnit}</Text></Text>
          </View>

          {error ? <View style={styles.errorBox}><Ionicons name="alert-circle-outline" size={18} color={colors.red} /><Text style={styles.errorText}>{error}</Text></View> : null}

          <Text style={styles.fieldLabel}>购买数量</Text>
          <View style={[styles.quantityRow, invalidQuantity && quantity.length > 0 && styles.quantityInvalid]}>
            <TextInput value={quantity} onChangeText={(value) => { setQuantity(value.replace(/[^0-9.]/gu, '')); setError(null); request.current = null; }} keyboardType="decimal-pad" maxLength={24} style={styles.quantityInput} />
            <Text style={styles.quantityUnit}>{listing.capacityUnit}</Text>
          </View>
          <Text style={styles.fieldHint}>最低 {decimal(amounts.minimum ?? 0n)} · 当前可售 {decimal(amounts.available ?? 0n)} {listing.capacityUnit}</Text>
          <View style={styles.deliveryCard}><Ionicons name={physicalProduct ? 'cube-outline' : 'hardware-chip-outline'} size={20} color={colors.primary} /><View style={styles.deliveryCopy}><Text style={styles.deliveryTitle}>{physicalProduct ? '整机实物交付' : '固定分配 1 张 GPU'}</Text><Text style={styles.deliveryText}>{physicalProduct ? `${listing.shippingEstimate ?? '交付时间待确认'}；数量与订单结果以服务端为准。` : `${gpuHourMeaning(quantity || 'X')}。付款后由平台自动开通，拿到连接信息并通过健康检查后才计费。`}</Text></View></View>

          <View style={styles.totalCard}>
            <Text style={styles.totalLabel}>本次预计</Text>
            <Text style={styles.totalValue}>{amounts.total ? creditAmount(decimal(amounts.total)) : '—'} <Text style={styles.totalUnit}>KAI 卡时</Text></Text>
            <View style={styles.totalLine} />
            <View style={styles.walletRow}><Text style={styles.walletLabel}>当前可用</Text><Text style={[styles.walletValue, insufficient && styles.walletShort]}>{balance ? creditAmount(decimal(amounts.wallet ?? 0n)) : authenticated ? '读取中' : '登录后查看'}</Text></View>
            <Text style={styles.serverNote}>提交时会按当前审核价和实时余量重新计算。</Text>
          </View>

          {insufficient ? <Pressable style={styles.creditButton} onPress={onNeedCredits}><Text style={styles.creditButtonText}>卡时不足，前往卡时账户</Text><Ionicons name="arrow-forward" size={17} color={colors.primary} /></Pressable> : null}
          <Pressable disabled={busy} onPress={confirm} style={[styles.primary, busy && styles.disabled]}>
            {busy ? <ActivityIndicator color={colors.surface} /> : <><Text style={styles.primaryText}>{authenticated ? insufficient ? '查看卡时账户' : '确认购买' : '登录后购买'}</Text><Ionicons name="arrow-forward" size={18} color={colors.surface} /></>}
          </Pressable>
          <Text style={styles.footnote}>{physicalProduct ? '提交后由服务端核对活动库存与采购资格；未确认成功前不展示订单成功。' : '确认购买后卡时先冻结，平台立即开通算力；开通失败或超时会自动全额退回。'}</Text>
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(18,35,58,0.36)' },
  sheet: { maxHeight: '92%', borderTopLeftRadius: 30, borderTopRightRadius: 30, overflow: 'hidden', backgroundColor: colors.canvas },
  handle: { width: 42, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 9, backgroundColor: '#D6DEE8' },
  header: { minHeight: 76, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerCopy: { flex: 1, marginRight: 12 }, eyebrow: { color: colors.primary, fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  title: { color: colors.ink, fontSize: 23, fontWeight: '900', marginTop: 3 }, close: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  content: { padding: 17, paddingBottom: 36 }, approvedCard: { minHeight: 145, padding: 17, borderWidth: 1, borderColor: '#D5E5FA', borderRadius: 23, backgroundColor: colors.surface },
  approvedTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, approvedLabel: { color: colors.green, fontSize: 10, fontWeight: '900' },
  product: { color: colors.muted, fontSize: 10, marginTop: 6 }, price: { color: colors.primaryDark, fontSize: 28, fontWeight: '900', marginTop: 24 }, priceUnit: { color: colors.primary, fontSize: 11 },
  errorBox: { padding: 12, marginTop: 14, borderRadius: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#FDECEC' }, errorText: { flex: 1, color: colors.red, fontSize: 11, lineHeight: 17 },
  fieldLabel: { color: colors.ink, fontSize: 13, fontWeight: '900', marginTop: 22, marginBottom: 8 }, quantityRow: { minHeight: 59, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.line, borderRadius: 17, backgroundColor: colors.surface }, quantityInvalid: { borderColor: colors.red },
  quantityInput: { flex: 1, paddingHorizontal: 15, color: colors.ink, fontSize: 23, fontWeight: '900' }, quantityUnit: { paddingHorizontal: 15, color: colors.muted, fontSize: 12, fontWeight: '800' }, fieldHint: { color: colors.muted, fontSize: 10, marginTop: 7 },
  deliveryCard: { padding: 13, marginTop: 14, borderRadius: 17, flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: colors.primarySoft }, deliveryCopy: { flex: 1 }, deliveryTitle: { color: colors.primaryDark, fontSize: 12, fontWeight: '900' }, deliveryText: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 4 },
  totalCard: { marginTop: 19, padding: 16, borderRadius: 21, backgroundColor: colors.surface }, totalLabel: { color: colors.muted, fontSize: 10 }, totalValue: { color: colors.primaryDark, fontSize: 29, fontWeight: '900', marginTop: 5 }, totalUnit: { color: colors.primary, fontSize: 11 }, totalLine: { height: 1, backgroundColor: colors.line, marginVertical: 14 },
  walletRow: { flexDirection: 'row', justifyContent: 'space-between' }, walletLabel: { color: colors.muted, fontSize: 11 }, walletValue: { color: colors.ink, fontSize: 13, fontWeight: '900' }, walletShort: { color: colors.red }, serverNote: { color: colors.subtle, fontSize: 9, lineHeight: 14, marginTop: 11 },
  creditButton: { minHeight: 48, marginTop: 13, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.primary, borderRadius: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, creditButtonText: { color: colors.primary, fontSize: 12, fontWeight: '900' },
  primary: { minHeight: 53, marginTop: 14, borderRadius: 17, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 14, fontWeight: '900' }, disabled: { opacity: 0.52 },
  footnote: { color: colors.muted, fontSize: 10, lineHeight: 16, textAlign: 'center', marginTop: 12 },
});
