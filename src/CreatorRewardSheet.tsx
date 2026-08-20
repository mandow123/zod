import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { CreatorRewardEvent } from './creator-commissions';
import { creditAmount } from './format';
import { colors } from './theme';

export function CreatorRewardSheet({ event, onClose, onOpenMarket }: Readonly<{
  event: CreatorRewardEvent | null;
  onClose: () => void;
  onOpenMarket: () => void;
}>) {
  return <Modal visible={event !== null} transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.backdrop}><View style={styles.card}>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} style={styles.close}><Ionicons name="close" size={21} color={colors.ink} /></Pressable>
      <View style={styles.icon}><Ionicons name="gift-outline" size={34} color={colors.orange} /></View>
      <Text style={styles.title}>恭喜获得卡时红包</Text>
      <Text style={styles.amount}>{event ? creditAmount(event.cardHours) : '0.00'}</Text>
      <Text style={styles.unit}>KAI 卡时</Text>
      <Text style={styles.subtitle}>已存入你的 KAI 卡时账户</Text>
      <Pressable onPress={onOpenMarket} style={styles.primary}><Text style={styles.primaryText}>转入卡时市场</Text><Ionicons name="arrow-forward" size={17} color={colors.surface} /></Pressable>
    </View></View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, padding: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(15,23,42,0.42)' }, card: { width: '100%', maxWidth: 420, padding: 24, borderRadius: 22, alignItems: 'center', backgroundColor: colors.surface }, close: { position: 'absolute', right: 12, top: 12, width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas }, icon: { width: 68, height: 68, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.orangeSoft }, title: { color: colors.ink, fontSize: 20, fontWeight: '900', marginTop: 17 }, amount: { color: colors.orange, fontSize: 45, fontWeight: '900', letterSpacing: -1, marginTop: 13 }, unit: { color: colors.muted, fontSize: 10, marginTop: 1 }, subtitle: { color: colors.muted, fontSize: 11, marginTop: 13 }, primary: { width: '100%', minHeight: 52, marginTop: 22, borderRadius: 12, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 13, fontWeight: '900' },
});
