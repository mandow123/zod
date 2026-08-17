import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  cancelDeviceOrder, confirmDeviceOrder, loadDeviceOrder, receiveDeviceOrder, shipDeviceOrder,
  type DeviceOrder, type DeviceProduct,
} from './api';
import { creditAmount } from './format';
import { isAmbiguousMutationFailure } from './mutation-recovery';
import { colors } from './theme';
import { availableDeviceOrderActions, type DeviceAction } from './device-order-actions';

const stateLabel: Record<DeviceOrder['status'], string> = {
  reserved: '待供应商确认', confirmed: '待发货', shipping: '运输中', received: '已签收',
  cancelled: '已取消', expired: '已失效',
};

export function DeviceOrderDetailSheet({ order: initialOrder, product, onClose, onChanged }: Readonly<{
  order: DeviceOrder | null;
  product: DeviceProduct | null;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}>) {
  const [order, setOrder] = useState<DeviceOrder | null>(initialOrder);
  const [busy, setBusy] = useState<DeviceAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shipOpen, setShipOpen] = useState(false);
  const [logisticsProvider, setLogisticsProvider] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const keys = useRef(new Map<DeviceAction, string>());

  useEffect(() => {
    setOrder(initialOrder); setBusy(null); setError(null); setShipOpen(false);
    setLogisticsProvider(''); setTrackingNumber(''); keys.current.clear();
  }, [initialOrder?.id]);

  if (!order) return null;
  const actions = availableDeviceOrderActions(order);
  const side = order.side;
  const key = (action: DeviceAction) => {
    const existing = keys.current.get(action);
    if (existing) return existing;
    const created = `device-order-${action}:${Crypto.randomUUID()}`;
    keys.current.set(action, created);
    return created;
  };
  const sync = async () => {
    const next = await loadDeviceOrder(order.id);
    setOrder(next); await onChanged();
  };
  const run = async (action: Exclude<DeviceAction, 'ship'>) => {
    setBusy(action); setError(null);
    try {
      if (action === 'cancel') await cancelDeviceOrder(order.id, key(action));
      if (action === 'confirm') await confirmDeviceOrder(order.id, key(action));
      if (action === 'receive') await receiveDeviceOrder(order.id, key(action));
      keys.current.delete(action); await sync();
    } catch (reason) {
      setError(isAmbiguousMutationFailure(reason)
        ? '网络中断，结果正在确认。再次操作会沿用同一请求，不会重复处理。'
        : reason instanceof Error ? reason.message : '订单操作没有完成。');
    } finally { setBusy(null); }
  };
  const ship = async () => {
    const provider = logisticsProvider.trim();
    const tracking = trackingNumber.trim().replace(/\s+/gu, '');
    if (provider.length < 2 || tracking.length < 6) { setError('请完整填写物流公司和运单号。'); return; }
    setBusy('ship'); setError(null);
    try {
      await shipDeviceOrder(order.id, { logisticsProvider: provider, trackingNumber: tracking, idempotencyKey: key('ship') });
      keys.current.delete('ship'); setTrackingNumber(''); setShipOpen(false); await sync();
    } catch (reason) {
      setError(isAmbiguousMutationFailure(reason)
        ? '网络中断，发货结果正在确认。保持内容再次提交不会重复发货。'
        : reason instanceof Error ? reason.message : '发货没有完成。');
    } finally { setBusy(null); }
  };

  return <Modal visible transparent animationType="slide" onRequestClose={onClose}><View style={styles.backdrop}><View style={styles.sheet}><View style={styles.handle} />
    <View style={styles.header}><View><Text style={styles.eyebrow}>{side === 'provider' ? '供应商设备订单' : side === 'buyer' ? '设备采购订单' : '设备订单'}</Text><Text style={styles.title}>{product?.title ?? order.orderNumber}</Text></View><Pressable onPress={onClose} style={styles.close}><Ionicons name="close" size={22} color={colors.ink} /></Pressable></View>
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <View style={styles.stateCard}><View><Text style={styles.stateLabel}>当前状态</Text><Text style={styles.stateValue}>{stateLabel[order.status]}</Text></View><View style={styles.stateIcon}><Ionicons name={order.status === 'shipping' ? 'car-outline' : order.status === 'received' ? 'checkmark-circle-outline' : 'cube-outline'} size={24} color={colors.primary} /></View></View>
      {error ? <View style={styles.error}><Ionicons name="alert-circle-outline" size={18} color={colors.red} /><Text style={styles.errorText}>{error}</Text></View> : null}
      <View style={styles.details}><Detail label="订单号" value={order.orderNumber} /><Detail label="数量" value={`${order.quantity} 台`} /><Detail label="单价" value={`${creditAmount(order.unitCredit)} 卡时`} /><Detail label="订单合计" value={`${creditAmount(order.totalCredit)} 卡时`} />{side === 'buyer' && order.logisticsProvider ? <Detail label="承运方" value={order.logisticsProvider} /> : null}{side === 'buyer' && order.trackingDisplay ? <Detail label="运单" value={order.trackingDisplay} /> : null}<Detail label="创建时间" value={new Date(order.createdAt).toLocaleString('zh-CN')} /></View>
      {side === 'provider' && order.settlement ? <View style={styles.settlement}><Text style={styles.sectionTitle}>结算</Text><Detail label="订单卡时" value={creditAmount(order.settlement.grossCredit)} /><Detail label="平台服务费" value={creditAmount(order.settlement.serviceFeeCredit)} /><Detail label="供应商实收" value={creditAmount(order.settlement.netCredit)} /></View> : null}
      {shipOpen ? <View style={styles.shipForm}><Text style={styles.sectionTitle}>登记发货</Text><TextInput value={logisticsProvider} onChangeText={setLogisticsProvider} placeholder="物流公司" placeholderTextColor={colors.subtle} style={styles.input} /><TextInput value={trackingNumber} onChangeText={setTrackingNumber} placeholder="运单号" placeholderTextColor={colors.subtle} autoCapitalize="characters" style={styles.input} /><Text style={styles.hint}>运单号通过加密连接提交，并由服务端加密保存。</Text><Pressable disabled={busy !== null} onPress={() => void ship()} style={styles.primary}>{busy === 'ship' ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>确认发货</Text>}</Pressable></View> : null}
      <View style={styles.actions}>{actions.includes('cancel') ? <Action label="取消订单并释放卡时" danger busy={busy === 'cancel'} onPress={() => Alert.alert('取消订单？', '取消后库存和预留卡时会由服务端释放。', [{ text: '返回', style: 'cancel' }, { text: '确认取消', style: 'destructive', onPress: () => void run('cancel') }])} /> : null}{actions.includes('confirm') ? <Action label="确认订单并锁定库存" busy={busy === 'confirm'} onPress={() => void run('confirm')} /> : null}{actions.includes('ship') && !shipOpen ? <Action label="登记发货" busy={false} onPress={() => setShipOpen(true)} /> : null}{actions.includes('receive') ? <Action label="确认收货" busy={busy === 'receive'} onPress={() => Alert.alert('确认已收货？', '确认后设备归入你的资产，并进入供应商结算流程。', [{ text: '返回', style: 'cancel' }, { text: '确认收货', onPress: () => void run('receive') }])} /> : null}</View>
      {!actions.length ? <Text style={styles.noAction}>当前没有待操作事项，状态变化会通过消息通知。</Text> : null}
    </ScrollView>
  </View></View></Modal>;
}

function Detail({ label, value }: Readonly<{ label: string; value: string }>) { return <View style={styles.detail}><Text style={styles.detailLabel}>{label}</Text><Text selectable style={styles.detailValue}>{value}</Text></View>; }
function Action({ label, onPress, busy, danger = false }: Readonly<{ label: string; onPress: () => void; busy: boolean; danger?: boolean }>) { return <Pressable disabled={busy} onPress={onPress} style={[styles.primary, danger && styles.danger]}>{busy ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>{label}</Text>}</Pressable>; }

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(17,24,39,0.32)' }, sheet: { maxHeight: '92%', borderTopLeftRadius: 16, borderTopRightRadius: 16, backgroundColor: colors.canvas }, handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 9, backgroundColor: '#D0D5DD' }, header: { minHeight: 72, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, eyebrow: { color: colors.primary, fontSize: 9, fontWeight: '900' }, title: { color: colors.ink, fontSize: 19, fontWeight: '900', marginTop: 4 }, close: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, content: { padding: 16, paddingBottom: 32 },
  stateCard: { minHeight: 86, padding: 15, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.primarySoft }, stateLabel: { color: colors.muted, fontSize: 9 }, stateValue: { color: colors.ink, fontSize: 20, fontWeight: '900', marginTop: 5 }, stateIcon: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  details: { paddingHorizontal: 13, marginTop: 10, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, detail: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line }, detailLabel: { color: colors.muted, fontSize: 10 }, detailValue: { maxWidth: '68%', color: colors.ink, fontSize: 10, fontWeight: '800', textAlign: 'right' }, settlement: { padding: 13, marginTop: 10, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, sectionTitle: { color: colors.ink, fontSize: 14, fontWeight: '900', marginBottom: 6 },
  error: { padding: 12, marginTop: 10, borderRadius: 12, flexDirection: 'row', gap: 8, backgroundColor: '#FFF1F1' }, errorText: { flex: 1, color: colors.red, fontSize: 10, lineHeight: 16 }, shipForm: { padding: 13, marginTop: 10, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, input: { minHeight: 46, marginTop: 8, paddingHorizontal: 12, borderRadius: 8, color: colors.ink, backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.line }, hint: { color: colors.muted, fontSize: 8, lineHeight: 13, marginTop: 7 }, actions: { gap: 8, marginTop: 12 }, primary: { minHeight: 46, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, danger: { backgroundColor: colors.red }, primaryText: { color: colors.surface, fontSize: 12, fontWeight: '900' }, noAction: { color: colors.muted, fontSize: 9, lineHeight: 15, textAlign: 'center', marginTop: 16 },
});
