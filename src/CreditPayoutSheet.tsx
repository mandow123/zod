import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { createCreditPayout, type CreditBalance, type CreditPayout, type CreditPayoutProfile } from './api';
import { ApiError } from './api-client';
import { creditAmount, creditToCnyEstimate } from './format';
import { isAmbiguousMutationFailure } from './mutation-recovery';
import { colors } from './theme';

export function CreditPayoutSheet({ visible, balance, profile, onClose, onCreated }: Readonly<{
  visible: boolean;
  balance: CreditBalance | null;
  profile: CreditPayoutProfile | null;
  onClose: () => void;
  onCreated: (payout: CreditPayout) => void | Promise<void>;
}>) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ amount: string; key: string } | null>(null);
  useEffect(() => { if (visible) { setAmount(''); setBusy(false); setError(null); request.current = null; } }, [visible]);

  const normalized = amount.trim();
  const valid = /^(?:[1-9]\d{0,4}|100000)(?:\.\d{1,2})?$/u.test(normalized) && Number(normalized) <= 100000;
  const profileActive = profile?.status === 'active';
  const submit = async () => {
    if (!profileActive) { setError('收款主体和公司打款账户尚未完成核验，暂不能申请兑付。'); return; }
    if (!valid) { setError('单次兑付需为 1.00 至 100,000.00 卡时。'); return; }
    if (Number(normalized) > Number(balance?.redeemableSupplierEarnings ?? 0)) { setError('可兑付收益不足。'); return; }
    if (!request.current || request.current.amount !== normalized) request.current = { amount: normalized, key: `credit-payout:${Crypto.randomUUID()}` };
    setBusy(true); setError(null);
    try {
      const payout = await createCreditPayout(normalized, request.current.key);
      onClose(); await onCreated(payout);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'PAYOUT_PROFILE_PENDING_ACTIVATION') setError('收款主体尚未激活，本次没有冻结卡时。');
      else if (reason instanceof ApiError && reason.code === 'PAYOUT_CREDITS_INSUFFICIENT') setError('可兑付收益不足，本次没有创建兑付申请。');
      else if (isAmbiguousMutationFailure(reason)) setError('网络中断，申请结果正在确认。保持金额再次提交，系统不会重复创建。');
      else setError(reason instanceof Error ? reason.message : '兑付申请没有提交成功。');
    } finally { setBusy(false); }
  };

  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><View style={styles.backdrop}><View style={styles.sheet}><View style={styles.handle} />
    <View style={styles.header}><View><Text style={styles.eyebrow}>供应方结算</Text><Text style={styles.title}>申请兑付</Text></View><Pressable onPress={onClose} style={styles.close}><Ionicons name="close" size={22} color={colors.ink} /></Pressable></View>
    <View style={styles.content}><View style={styles.balance}><Text style={styles.balanceLabel}>可兑付收益</Text><Text style={styles.balanceValue}>{balance ? creditAmount(balance.redeemableSupplierEarnings, true) : '—'}</Text><Text style={styles.balanceMeta}>冻结中 {balance ? creditAmount(balance.payoutFrozen, true) : '—'} · 1 卡时 = ¥1.002</Text></View>
      {!profileActive ? <View style={styles.warning}><Ionicons name="alert-circle-outline" size={18} color={colors.amber} /><Text style={styles.warningText}>{profile?.status === 'suspended' ? '收款账户已暂停，请联系平台处理。' : '收款主体尚待平台核验，激活前不能提交兑付。'}</Text></View> : null}
      {error ? <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View> : null}
      <Text style={styles.label}>兑付卡时</Text><TextInput value={amount} onChangeText={(value) => { setAmount(value.replace(/[^0-9.]/gu, '')); setError(null); request.current = null; }} keyboardType="decimal-pad" placeholder="至少 1.00" placeholderTextColor={colors.subtle} style={styles.input} />
      <Text style={styles.estimate}>预计公司付款：{valid ? `¥${creditToCnyEstimate(normalized)}` : '—'}</Text>
      <Pressable disabled={busy || !profileActive} onPress={() => void submit()} style={[styles.primary, (busy || !profileActive) && styles.disabled]}>{busy ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>{profileActive ? '提交兑付申请' : '等待账户核验'}</Text>}</Pressable>
      <Text style={styles.footnote}>提交成功后卡时进入“兑付冻结”，公司付款成功后才完成核销；失败、拒绝或取消会原路退回可用余额。</Text>
    </View>
  </View></View></Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(17,24,39,0.32)' }, sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, backgroundColor: colors.canvas }, handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 9, backgroundColor: '#D0D5DD' }, header: { minHeight: 72, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, eyebrow: { color: colors.primary, fontSize: 9, fontWeight: '900' }, title: { color: colors.ink, fontSize: 21, fontWeight: '900', marginTop: 4 }, close: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, content: { padding: 16, paddingBottom: 30 }, balance: { padding: 15, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, balanceLabel: { color: colors.muted, fontSize: 9 }, balanceValue: { color: colors.ink, fontSize: 27, fontWeight: '900', marginTop: 5 }, balanceMeta: { color: colors.muted, fontSize: 9, marginTop: 6 }, warning: { padding: 12, marginTop: 10, borderRadius: 12, flexDirection: 'row', gap: 8, backgroundColor: '#FFF8E7' }, warningText: { flex: 1, color: colors.muted, fontSize: 10, lineHeight: 16 }, error: { padding: 11, marginTop: 10, borderRadius: 12, backgroundColor: '#FDECEC' }, errorText: { color: colors.red, fontSize: 10, lineHeight: 16 }, label: { color: colors.ink, fontSize: 12, fontWeight: '900', marginTop: 17, marginBottom: 8 }, input: { minHeight: 50, paddingHorizontal: 13, borderRadius: 8, color: colors.ink, fontSize: 18, fontWeight: '900', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, estimate: { color: colors.muted, fontSize: 10, marginTop: 8 }, primary: { minHeight: 50, marginTop: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 12, fontWeight: '900' }, disabled: { opacity: 0.5 }, footnote: { color: colors.muted, fontSize: 9, lineHeight: 15, textAlign: 'center', marginTop: 11 },
});
