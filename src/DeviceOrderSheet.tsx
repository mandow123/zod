import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import {
  createDeviceOrder, createShippingAddress, deleteShippingAddress, loadShippingAddresses,
  type CreditBalance, type DeviceOrder, type DeviceProduct, type ShippingAddress,
} from './api';
import { ApiError } from './api-client';
import { creditAmount } from './format';
import { isAmbiguousMutationFailure } from './mutation-recovery';
import { colors } from './theme';

function micros(value: string) {
  const match = value.match(/^(\d+)(?:\.(\d{1,6}))?$/u);
  return match ? BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0')) : null;
}

export function DeviceOrderSheet({ product, balance, authenticated, purchaseAllowed, blockedReason, onClose, onLogin, onNeedCredits, onCreated }: Readonly<{
  product: DeviceProduct | null;
  balance: CreditBalance | null;
  authenticated: boolean;
  purchaseAllowed: boolean;
  blockedReason: string | null;
  onClose: () => void;
  onLogin: () => void;
  onNeedCredits: () => void;
  onCreated: (order: DeviceOrder) => void | Promise<void>;
}>) {
  const [quantity, setQuantity] = useState('1');
  const [addresses, setAddresses] = useState<ShippingAddress[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [addressMode, setAddressMode] = useState<'list' | 'new'>('list');
  const [addressLoading, setAddressLoading] = useState(false);
  const [addressBusy, setAddressBusy] = useState(false);
  const [recipientName, setRecipientName] = useState('');
  const [phone, setPhone] = useState('');
  const [province, setProvince] = useState('');
  const [city, setCity] = useState('');
  const [district, setDistrict] = useState('');
  const [detail, setDetail] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ signature: string; key: string } | null>(null);
  const addressRequest = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    if (!product) return;
    setQuantity('1'); setBusy(false); setError(null); request.current = null; addressRequest.current = null;
  }, [product]);

  useEffect(() => {
    if (!product || !authenticated) { setAddresses([]); setSelectedAddressId(null); return; }
    let active = true;
    setAddressLoading(true);
    void loadShippingAddresses().then((items) => {
      if (!active) return;
      setAddresses(items);
      const preferred = items.find((item) => item.isDefault) ?? items[0] ?? null;
      setSelectedAddressId(preferred?.id ?? null);
      setAddressMode(items.length ? 'list' : 'new');
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : '收货地址暂时没有读取成功。');
    }).finally(() => { if (active) setAddressLoading(false); });
    return () => { active = false; };
  }, [authenticated, product]);

  const units = Number(quantity);
  const unitMicros = product ? micros(product.pricing.unitCredit) : null;
  const walletMicros = balance ? micros(balance.available) : null;
  const totalMicros = unitMicros !== null && Number.isInteger(units) ? unitMicros * BigInt(Math.max(0, units)) : null;
  const totalCredit = totalMicros === null ? null
    : `${totalMicros / 1_000_000n}.${((totalMicros % 1_000_000n) / 10_000n).toString().padStart(2, '0')}`;
  const invalidQuantity = !product || !Number.isInteger(units) || units < 1 || units > Math.min(20, product.inventory.available);
  const insufficient = Boolean(totalMicros !== null && walletMicros !== null && totalMicros > walletMicros);
  const selectedAddress = useMemo(() => addresses.find((item) => item.id === selectedAddressId) ?? null, [addresses, selectedAddressId]);
  const unavailableReason = product && !purchaseAllowed ? blockedReason ?? '该商品暂不能购买。'
    : product && product.inventory.available <= 0 ? '当前库存已售罄。' : null;

  const submit = async () => {
    if (!product) return;
    if (!authenticated) { onLogin(); return; }
    if (!purchaseAllowed || unavailableReason) { setError(unavailableReason ?? '该商品暂不能购买。'); return; }
    if (invalidQuantity) { setError(`购买数量需为 1 至 ${Math.min(20, product.inventory.available)} 台。`); return; }
    if (!selectedAddress) { setError('请选择或新增一个收货地址。'); return; }
    if (!balance || walletMicros === null) { setError('卡时余额暂未读取成功，请刷新后重试。'); return; }
    if (insufficient) { onNeedCredits(); return; }
    const signature = `${product.id}:${units}:${selectedAddress.id}`;
    if (!request.current || request.current.signature !== signature) {
      request.current = { signature, key: `device-order:${Crypto.randomUUID()}` };
    }
    setBusy(true); setError(null);
    try {
      const order = await createDeviceOrder({ productId: product.id, quantity: units,
        shippingAddressReference: selectedAddress.reference, idempotencyKey: request.current.key });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose(); await onCreated(order);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'DEVICE_PRODUCT_PENDING_ACTIVATION') {
        setError('供应主体尚未完成核验，本次没有生成订单，也没有冻结卡时。');
      } else if (reason instanceof ApiError && reason.code === 'KAI_CREDITS_INSUFFICIENT') {
        setError('可用卡时不足，本次没有生成订单。');
      } else if (isAmbiguousMutationFailure(reason)) {
        setError('网络中断，订单结果正在确认。保持当前信息再次提交，系统会核对同一笔请求，不会重复下单。');
      } else {
        setError(reason instanceof Error ? reason.message : '设备订单提交失败，请重试。');
      }
    } finally { setBusy(false); }
  };

  const clearAddressForm = () => {
    setRecipientName(''); setPhone(''); setProvince(''); setCity(''); setDistrict(''); setDetail(''); setMakeDefault(false);
    addressRequest.current = null;
  };

  const saveAddress = async () => {
    const normalized = { recipientName: recipientName.trim(), phone: phone.trim(), province: province.trim(),
      city: city.trim(), district: district.trim(), detail: detail.trim(), isDefault: makeDefault || addresses.length === 0 };
    if (normalized.recipientName.length < 2) { setError('请填写收货人姓名。'); return; }
    if (!/^(?:\+?86)?1\d{10}$/u.test(normalized.phone.replace(/[\s-]/gu, ''))) { setError('请填写有效的中国大陆手机号。'); return; }
    if ([normalized.province, normalized.city, normalized.district].some((value) => value.length < 2) || normalized.detail.length < 5) {
      setError('请完整填写省、市、区和详细地址。'); return;
    }
    const signature = JSON.stringify(normalized);
    if (!addressRequest.current || addressRequest.current.signature !== signature) {
      addressRequest.current = { signature, key: `shipping-address:${Crypto.randomUUID()}` };
    }
    setAddressBusy(true); setError(null);
    try {
      const address = await createShippingAddress(normalized, addressRequest.current.key);
      setAddresses((current) => normalized.isDefault
        ? [address, ...current.map((item) => ({ ...item, isDefault: false }))]
        : [address, ...current]);
      setSelectedAddressId(address.id); setAddressMode('list'); clearAddressForm();
    } catch (reason) {
      if (isAmbiguousMutationFailure(reason)) setError('网络中断，地址保存结果正在确认。请保持内容再次保存，系统不会重复创建。');
      else setError(reason instanceof Error ? reason.message : '收货地址没有保存成功。');
    } finally { setAddressBusy(false); }
  };

  const removeAddress = (address: ShippingAddress) => {
    Alert.alert('删除收货地址？', `${address.recipientName} · ${address.province}${address.city}${address.district}`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => {
        setAddressBusy(true); setError(null);
        void deleteShippingAddress(address.id).then(() => {
          setAddresses((current) => {
            const next = current.filter((item) => item.id !== address.id);
            if (selectedAddressId === address.id) setSelectedAddressId((next.find((item) => item.isDefault) ?? next[0])?.id ?? null);
            if (!next.length) setAddressMode('new');
            return next;
          });
        }).catch((reason) => setError(reason instanceof Error ? reason.message : '地址没有删除成功。'))
          .finally(() => setAddressBusy(false));
      } },
    ]);
  };

  if (!product) return null;
  return <Modal visible transparent animationType="slide" onRequestClose={onClose}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
      <View style={styles.sheet}><View style={styles.handle} />
        <View style={styles.header}><View><Text style={styles.eyebrow}>设备采购</Text><Text style={styles.title}>{product.title}</Text></View><Pressable onPress={onClose} style={styles.close}><Ionicons name="close" size={22} color={colors.ink} /></Pressable></View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.summary}><View><Text style={styles.supplier}>{product.supplier.displayName} · {product.pricing.discountPercent === 20 ? '8 折' : `优惠 ${product.pricing.discountPercent}%`}</Text><Text style={styles.listPrice}>{creditAmount(product.pricing.listUnitCredit)} 卡时</Text><Text style={styles.price}>{creditAmount(product.pricing.unitCredit)}</Text><Text style={styles.credit}>KAI 卡时 / 台</Text></View><View style={styles.stock}><Text style={styles.stockValue}>{product.inventory.available}</Text><Text style={styles.stockLabel}>实时可售</Text></View></View>
          {unavailableReason ? <View style={styles.warning}><Ionicons name="alert-circle-outline" size={18} color={colors.amber} /><Text style={styles.warningText}>{unavailableReason}</Text></View> : null}
          {error ? <View style={styles.error}><Ionicons name="close-circle-outline" size={18} color={colors.red} /><Text style={styles.errorText}>{error}</Text></View> : null}
          <Text style={styles.label}>采购数量</Text>
          <View style={styles.inputRow}><TextInput value={quantity} onChangeText={(value) => { setQuantity(value.replace(/\D/gu, '')); setError(null); request.current = null; }} keyboardType="number-pad" maxLength={2} style={styles.quantity} /><Text style={styles.unit}>台</Text></View>
          <Text style={styles.hint}>单笔最多 20 台，提交时重新核对库存。</Text>
          <View style={styles.addressHeading}><Text style={styles.label}>收货地址</Text>{addresses.length ? <Pressable onPress={() => { setAddressMode(addressMode === 'list' ? 'new' : 'list'); setError(null); }}><Text style={styles.addressAction}>{addressMode === 'list' ? '新增地址' : '返回地址簿'}</Text></Pressable> : null}</View>
          {addressLoading ? <View style={styles.addressLoading}><ActivityIndicator color={colors.primary} /><Text style={styles.hint}>正在读取地址簿…</Text></View> : addressMode === 'list' && addresses.length ? <View style={styles.addressList}>{addresses.map((address) => <Pressable key={address.id} onPress={() => { setSelectedAddressId(address.id); setError(null); request.current = null; }} style={[styles.addressCard, selectedAddressId === address.id && styles.addressSelected]}>
            <View style={styles.addressTop}><View style={styles.radio}>{selectedAddressId === address.id ? <View style={styles.radioDot} /> : null}</View><View style={styles.addressCopy}><View style={styles.recipientRow}><Text style={styles.recipient}>{address.recipientName}</Text><Text style={styles.phone}>{address.phone}</Text>{address.isDefault ? <Text style={styles.defaultBadge}>默认</Text> : null}</View><Text style={styles.addressText}>{address.province}{address.city}{address.district}{address.detail}</Text></View><Pressable disabled={addressBusy} onPress={() => removeAddress(address)} hitSlop={8}><Ionicons name="trash-outline" size={17} color={colors.muted} /></Pressable></View>
          </Pressable>)}</View> : <View style={styles.addressForm}>
            <View style={styles.formRow}><TextInput value={recipientName} onChangeText={setRecipientName} placeholder="收货人" placeholderTextColor={colors.subtle} style={[styles.addressInput, styles.halfInput]} /><TextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="手机号" placeholderTextColor={colors.subtle} style={[styles.addressInput, styles.halfInput]} /></View>
            <View style={styles.formRow}><TextInput value={province} onChangeText={setProvince} placeholder="省" placeholderTextColor={colors.subtle} style={[styles.addressInput, styles.thirdInput]} /><TextInput value={city} onChangeText={setCity} placeholder="市" placeholderTextColor={colors.subtle} style={[styles.addressInput, styles.thirdInput]} /><TextInput value={district} onChangeText={setDistrict} placeholder="区 / 县" placeholderTextColor={colors.subtle} style={[styles.addressInput, styles.thirdInput]} /></View>
            <TextInput value={detail} onChangeText={setDetail} placeholder="街道、门牌号、楼栋房间" placeholderTextColor={colors.subtle} style={styles.addressInput} />
            <Pressable onPress={() => setMakeDefault((value) => !value)} style={styles.defaultRow}><View style={[styles.checkbox, makeDefault && styles.checkboxActive]}>{makeDefault ? <Ionicons name="checkmark" size={14} color={colors.surface} /> : null}</View><Text style={styles.defaultText}>设为默认地址</Text></Pressable>
            <Pressable disabled={addressBusy} onPress={() => void saveAddress()} style={styles.saveAddress}>{addressBusy ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.saveAddressText}>保存并使用</Text>}</Pressable>
          </View>}
          <View style={styles.total}><View><Text style={styles.totalLabel}>预计使用</Text><Text style={styles.totalValue}>{totalCredit ? creditAmount(totalCredit, true) : '—'} <Text style={styles.totalUnit}>KAI 卡时</Text></Text></View><View><Text style={styles.walletLabel}>当前可用</Text><Text style={[styles.walletValue, insufficient && styles.short]}>{balance ? creditAmount(balance.available, true) : '—'}</Text></View></View>
          {insufficient ? <Pressable onPress={onNeedCredits} style={styles.secondary}><Text style={styles.secondaryText}>卡时不足，前往充值</Text></Pressable> : null}
          <Pressable disabled={busy || Boolean(unavailableReason) || addressLoading || !selectedAddress} onPress={() => void submit()} style={[styles.primary, (busy || Boolean(unavailableReason) || addressLoading || !selectedAddress) && styles.disabled]}>{busy ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>{unavailableReason ? '暂不可购买' : !selectedAddress ? '请先选择收货地址' : authenticated ? '确认采购' : '登录后购买'}</Text>}</Pressable>
          <Text style={styles.footnote}>服务端成功预留库存和卡时后才会生成订单；失败不会显示购买成功。</Text>
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(17,24,39,0.32)' }, sheet: { maxHeight: '92%', borderTopLeftRadius: 16, borderTopRightRadius: 16, backgroundColor: colors.canvas }, handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 9, backgroundColor: '#D0D5DD' },
  header: { minHeight: 72, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, eyebrow: { color: colors.primary, fontSize: 9, fontWeight: '900' }, title: { color: colors.ink, fontSize: 21, fontWeight: '900', marginTop: 4 }, close: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, content: { padding: 16, paddingBottom: 32 },
  summary: { padding: 15, borderRadius: 12, flexDirection: 'row', justifyContent: 'space-between', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, supplier: { color: colors.muted, fontSize: 10, fontWeight: '800' }, listPrice: { color: colors.muted, fontSize: 9, textDecorationLine: 'line-through', marginTop: 7 }, price: { color: colors.ink, fontSize: 23, fontWeight: '900', marginTop: 3 }, credit: { color: colors.primary, fontSize: 11, fontWeight: '800', marginTop: 5 }, stock: { alignItems: 'center', justifyContent: 'center', minWidth: 62 }, stockValue: { color: colors.ink, fontSize: 22, fontWeight: '900' }, stockLabel: { color: colors.muted, fontSize: 9, marginTop: 4 },
  warning: { padding: 12, marginTop: 10, borderRadius: 12, flexDirection: 'row', gap: 8, backgroundColor: '#FFF8E7' }, warningText: { flex: 1, color: colors.muted, fontSize: 10, lineHeight: 16 }, error: { padding: 12, marginTop: 10, borderRadius: 12, flexDirection: 'row', gap: 8, backgroundColor: '#FDECEC' }, errorText: { flex: 1, color: colors.red, fontSize: 10, lineHeight: 16 },
  label: { color: colors.ink, fontSize: 12, fontWeight: '900', marginTop: 18, marginBottom: 8 }, inputRow: { minHeight: 50, paddingHorizontal: 13, borderRadius: 8, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, quantity: { flex: 1, color: colors.ink, fontSize: 18, fontWeight: '900' }, unit: { color: colors.muted, fontSize: 11 }, hint: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 6 },
  addressHeading: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }, addressAction: { color: colors.primary, fontSize: 10, fontWeight: '900', marginBottom: 8 }, addressLoading: { minHeight: 68, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, addressList: { gap: 8 }, addressCard: { padding: 12, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, addressSelected: { borderColor: '#9ABCF0', backgroundColor: '#F5F9FF' }, addressTop: { flexDirection: 'row', alignItems: 'flex-start' }, radio: { width: 18, height: 18, marginTop: 1, marginRight: 9, borderRadius: 9, borderWidth: 1, borderColor: colors.primary, alignItems: 'center', justifyContent: 'center' }, radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary }, addressCopy: { flex: 1, marginRight: 8 }, recipientRow: { flexDirection: 'row', alignItems: 'center', gap: 7 }, recipient: { color: colors.ink, fontSize: 12, fontWeight: '900' }, phone: { color: colors.muted, fontSize: 10 }, defaultBadge: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4, color: colors.primary, fontSize: 8, fontWeight: '800', backgroundColor: '#EAF2FF' }, addressText: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 5 },
  addressForm: { padding: 12, gap: 9, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, formRow: { flexDirection: 'row', gap: 8 }, addressInput: { minHeight: 46, paddingHorizontal: 11, borderRadius: 8, color: colors.ink, fontSize: 11, backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.line }, halfInput: { flex: 1 }, thirdInput: { flex: 1 }, defaultRow: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 8 }, checkbox: { width: 19, height: 19, borderRadius: 5, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line }, checkboxActive: { borderColor: colors.primary, backgroundColor: colors.primary }, defaultText: { color: colors.muted, fontSize: 10 }, saveAddress: { minHeight: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.primary }, saveAddressText: { color: colors.primary, fontSize: 11, fontWeight: '900' },
  total: { padding: 15, marginTop: 18, borderRadius: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', backgroundColor: colors.surface }, totalLabel: { color: colors.muted, fontSize: 9 }, totalValue: { color: colors.ink, fontSize: 22, fontWeight: '900', marginTop: 5 }, totalUnit: { color: colors.muted, fontSize: 9 }, walletLabel: { color: colors.muted, fontSize: 9, textAlign: 'right' }, walletValue: { color: colors.ink, fontSize: 12, fontWeight: '900', marginTop: 5 }, short: { color: colors.red }, secondary: { minHeight: 44, marginTop: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.primary }, secondaryText: { color: colors.primary, fontSize: 11, fontWeight: '900' }, primary: { minHeight: 50, marginTop: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 12, fontWeight: '900' }, disabled: { opacity: 0.5 }, footnote: { color: colors.muted, fontSize: 9, lineHeight: 14, textAlign: 'center', marginTop: 10 },
});
