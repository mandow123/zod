import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { decideAftercareRefund, type AftercareReview } from './api';
import { colors } from './theme';
import { creditAmount } from './format';

export function AftercareReviewSheet({ review, onClose, onChanged }: Readonly<{
  review: AftercareReview | null;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}>) {
  const [outcome, setOutcome] = useState<'approve_refund' | 'reject_refund'>('approve_refund');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setOutcome('approve_refund'); setReason(''); setError(null); }, [review?.refundId]);
  if (!review) return null;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await decideAftercareRefund(review.order.id, outcome, reason.trim());
      await onChanged();
      onClose();
      setReason('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '处理没有完成，请重试。'); }
    finally { setBusy(false); }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View><Text style={styles.eyebrow}>平台售后</Text><Text style={styles.title}>{review.order.title}</Text></View>
            <Pressable onPress={onClose} style={styles.close}><Ionicons name="close" size={23} color={colors.ink} /></Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.amountCard}>
              <Text style={styles.amountLabel}>原订单卡时</Text>
              <Text style={styles.amount}>{creditAmount(review.order.totalCredits)} <Text style={styles.unit}>KAI 卡时</Text></Text>
              <Text style={styles.meta}>{review.order.orderNumber} · {trim(review.order.quantity)} {review.order.capacityUnit}</Text>
            </View>
            <Evidence label="买方说明" body={review.description} />
            <View style={styles.remedyCard}><Text style={styles.remedyLabel}>申请补偿</Text><Text style={styles.remedyAmount}>{creditAmount(review.creditAmount)} KAI 卡时</Text></View>
            {review.providerResponse ? <Evidence label="提供方异议" body={review.providerResponse} /> : null}
            <View style={styles.evidence}>
              <Text style={styles.label}>交付记录 · 第 {review.delivery.attemptNumber} 次</Text>
              {Object.entries(review.delivery.details).map(([key, value]) => (
                <View key={key} style={styles.detailRow}><Text style={styles.detailKey}>{key}</Text><Text style={styles.detailValue}>{String(value)}</Text></View>
              ))}
            </View>
            <Text style={styles.sectionTitle}>处理结果</Text>
            <View style={styles.choiceRow}>
              <Choice active={outcome === 'approve_refund'} label="支持补偿" onPress={() => setOutcome('approve_refund')} />
              <Choice active={outcome === 'reject_refund'} label="驳回申请" onPress={() => setOutcome('reject_refund')} />
            </View>
            <Text style={styles.notice}>{outcome === 'approve_refund'
              ? `将退回买方 ${creditAmount(review.creditAmount)} KAI 卡时，剩余卡时按原日期结算。`
              : '卡时恢复原结算安排，不会立即转入提供方账户。'}</Text>
            <TextInput value={reason} onChangeText={setReason} multiline maxLength={2000}
              placeholder="写明核对依据和处理理由" placeholderTextColor={colors.subtle}
              style={styles.input} />
            {error ? <View style={styles.error}><Ionicons name="alert-circle-outline" size={18} color={colors.red} /><Text style={styles.errorText}>{error}</Text></View> : null}
            <Pressable disabled={busy || reason.trim().length < 10} onPress={() => Alert.alert(
              '确认处理结果',
              outcome === 'approve_refund'
                ? `将退回 ${creditAmount(review.creditAmount)} KAI 卡时；提交后不可撤回。`
                : '将驳回退款申请并恢复原结算安排；提交后不可撤回。',
              [{ text: '再核对一下', style: 'cancel' }, { text: '确认提交', style: outcome === 'approve_refund' ? 'destructive' : 'default', onPress: () => void submit() }],
            )}
              style={[styles.primary, (busy || reason.trim().length < 10) && styles.disabled]}>
              {busy ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>确认处理结果</Text>}
            </Pressable>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Evidence({ label, body }: Readonly<{ label: string; body: string }>) {
  return <View style={styles.evidence}><Text style={styles.label}>{label}</Text><Text style={styles.body}>{body}</Text></View>;
}
function Choice({ active, label, onPress }: Readonly<{ active: boolean; label: string; onPress: () => void }>) {
  return <Pressable onPress={onPress} style={[styles.choice, active && styles.choiceActive]}><Ionicons name={active ? 'radio-button-on' : 'radio-button-off'} size={18} color={active ? colors.primary : colors.subtle} /><Text style={[styles.choiceText, active && styles.choiceTextActive]}>{label}</Text></Pressable>;
}
function trim(value: string) { return value.replace(/\.0+$/u, '').replace(/(\.\d*?)0+$/u, '$1'); }

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(18,35,58,0.36)' },
  sheet: { height: '94%', borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: colors.canvas, overflow: 'hidden' },
  handle: { width: 42, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 9, backgroundColor: '#D6DEE8' },
  header: { minHeight: 75, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { color: colors.primary, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 }, title: { color: colors.ink, fontSize: 21, fontWeight: '900', marginTop: 3 },
  close: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, content: { padding: 17, paddingBottom: 40 },
  amountCard: { padding: 18, borderWidth: 1, borderColor: '#D5E5FA', borderRadius: 22, backgroundColor: colors.surface }, amountLabel: { color: colors.primary, fontSize: 10, fontWeight: '900' },
  amount: { color: colors.primaryDark, fontSize: 30, fontWeight: '900', marginTop: 7 }, unit: { fontSize: 12, color: colors.primary }, meta: { color: colors.muted, fontSize: 9, marginTop: 6 },
  evidence: { padding: 15, marginTop: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 18, backgroundColor: colors.surface }, label: { color: colors.primary, fontSize: 10, fontWeight: '900' }, body: { color: colors.ink, fontSize: 12, lineHeight: 19, marginTop: 7 },
  remedyCard: { padding: 15, marginTop: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderRadius: 18, backgroundColor: colors.primarySoft }, remedyLabel: { color: colors.primaryDark, fontSize: 11, fontWeight: '800' }, remedyAmount: { color: colors.primaryDark, fontSize: 16, fontWeight: '900' },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 15, marginTop: 8 }, detailKey: { color: colors.muted, fontSize: 10 }, detailValue: { flex: 1, color: colors.ink, fontSize: 10, fontWeight: '800', textAlign: 'right' },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: '900', marginTop: 19 }, choiceRow: { flexDirection: 'row', gap: 9, marginTop: 11 }, choice: { flex: 1, minHeight: 50, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 7, borderWidth: 1, borderColor: colors.line, borderRadius: 15, backgroundColor: colors.surface }, choiceActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft }, choiceText: { color: colors.muted, fontSize: 12, fontWeight: '800' }, choiceTextActive: { color: colors.primaryDark },
  notice: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 11 }, input: { minHeight: 94, padding: 13, marginTop: 13, borderWidth: 1, borderColor: colors.line, borderRadius: 16, color: colors.ink, backgroundColor: colors.surface, textAlignVertical: 'top' },
  error: { flexDirection: 'row', gap: 8, padding: 12, marginTop: 12, borderRadius: 14, backgroundColor: '#FDECEC' }, errorText: { flex: 1, color: colors.red, fontSize: 11, lineHeight: 17 },
  primary: { minHeight: 52, marginTop: 14, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 13, fontWeight: '900' }, disabled: { opacity: 0.48 },
});
