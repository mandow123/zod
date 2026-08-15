import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { listSupplierListings, setCreditListingStatus, type CreditListing } from './publishing';
import { isAmbiguousMutationFailure, listingStatusChangeAccepted } from './mutation-recovery';
import { colors } from './theme';
import { creditAmount } from './format';

function compact(value: string) {
  return value.replace(/\.0+$/u, '').replace(/(\.\d*?)0+$/u, '$1');
}

function dateLabel(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

const statusLabel: Record<CreditListing['sellingStage'], string> = {
  scheduled: '待生效', scheduled_paused: '排期已暂停', selling: '销售中', paused: '已暂停', sold_out: '已售罄', expired: '已到期', withdrawn: '已结束', suspended: '已停用',
};

export function ListingManageSheet({ listing, title, readOnly = false, onClose, onUpdated }: Readonly<{
  listing: CreditListing | null;
  title: string;
  readOnly?: boolean;
  onClose: () => void;
  onUpdated: (listing: CreditListing) => void;
}>) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionInFlightRef = useRef(false);

  useEffect(() => { setError(null); setSaving(false); actionInFlightRef.current = false; }, [listing?.id]);
  if (!listing) return null;
  const scheduled = listing.sellingStage === 'scheduled' || listing.sellingStage === 'scheduled_paused';

  const update = async (status: 'active' | 'paused' | 'withdrawn') => {
    if (readOnly || saving || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setSaving(true); setError(null);
    try {
      const updated = await setCreditListingStatus(listing.id, status);
      onUpdated(updated);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (status === 'withdrawn') onClose();
    } catch (cause) {
      if (isAmbiguousMutationFailure(cause)) {
        try {
          const confirmed = listingStatusChangeAccepted(listing.id, status, await listSupplierListings());
          if (confirmed) {
            onUpdated(confirmed);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            if (status === 'withdrawn') onClose();
            return;
          }
        } catch { /* Keep the unknown result visible and let the user retry after syncing. */ }
      }
      setError(isAmbiguousMutationFailure(cause)
        ? '网络中断，暂时没能确认挂牌状态。请同步最新状态后再操作。'
        : cause instanceof Error ? cause.message : '操作失败，请刷新后重试。');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      actionInFlightRef.current = false;
      setSaving(false);
    }
  };

  const endListing = () => Alert.alert(
    scheduled ? '取消这次排期？' : '结束这条挂牌？',
    scheduled ? '取消后不会自动生效，也不能恢复。' : '结束后不能恢复；已售出的容量不受影响。',
    [{ text: '返回', style: 'cancel' }, { text: scheduled ? '确认取消' : '确认结束', style: 'destructive', onPress: () => void update('withdrawn') }],
  );

  const closeSafely = () => {
    if (actionInFlightRef.current) return;
    onClose();
  };

  const canManage = !readOnly && (listing.status === 'active' || listing.status === 'paused');
  return (
    <Modal visible animationType="slide" transparent onRequestClose={closeSafely}>
      <View style={styles.backdrop}>
        <Pressable disabled={saving} style={styles.dismissArea} onPress={closeSafely} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.eyebrow}>挂牌管理</Text>
              <Text style={styles.title}>{title}</Text>
            </View>
            <Pressable disabled={saving} style={[styles.close, saving && styles.disabled]} onPress={closeSafely}><Ionicons name="close" size={22} color={colors.ink} /></Pressable>
          </View>

          <View style={styles.statusRow}>
            <View style={[styles.statusDot, listing.sellingStage === 'selling' ? styles.statusActive : listing.sellingStage === 'scheduled' ? styles.statusScheduled : styles.statusPaused]} />
            <Text style={styles.statusText}>{statusLabel[listing.sellingStage]}</Text>
            <Text style={styles.windowText}>{scheduled ? `${dateLabel(listing.startsAt)} 开始` : `至 ${dateLabel(listing.expiresAt)}`}</Text>
          </View>

          <View style={styles.stockGrid}>
            <Stock label={scheduled ? '上架容量' : '可售'} value={listing.capacityAvailable} unit={listing.capacityUnit} strong />
            <Stock label="已预留" value={listing.capacityReserved} unit={listing.capacityUnit} />
            <Stock label="已售" value={listing.capacitySold} unit={listing.capacityUnit} />
          </View>
          <Text style={styles.price}>{creditAmount(listing.unitCredits)} KAI 卡时 / {listing.capacityUnit}</Text>
          <View style={styles.estimate}>
            <View><Text style={styles.estimateLabel}>满售预计成交额</Text><Text style={styles.estimateValue}>{creditAmount(listing.selloutEstimate.grossCredits)} KAI 卡时</Text></View>
            <Text style={styles.estimateHint}>{listing.selloutEstimate.disclosure}</Text>
          </View>

          {readOnly ? <View style={styles.readOnly}><Ionicons name="cloud-offline-outline" size={17} color={colors.amber} /><Text style={styles.readOnlyText}>当前是上次保存的挂牌状态。同步最新库存后才能修改。</Text></View> : null}
          {error ? <View style={styles.error}><Ionicons name="alert-circle" size={17} color={colors.red} /><Text style={styles.errorText}>{error}</Text></View> : null}

          {listing.status === 'active' ? (
            <Pressable disabled={saving} style={[styles.primary, saving && styles.disabled]} onPress={() => void update('paused')}>
              <Ionicons name="pause" size={18} color={colors.surface} /><Text style={styles.primaryText}>{saving ? '处理中…' : scheduled ? '暂停这次排期' : '暂停销售'}</Text>
            </Pressable>
          ) : listing.status === 'paused' ? (
            <Pressable disabled={saving} style={[styles.primary, saving && styles.disabled]} onPress={() => void update('active')}>
              <Ionicons name="play" size={18} color={colors.surface} /><Text style={styles.primaryText}>{saving ? '处理中…' : scheduled ? '恢复排期' : '恢复销售'}</Text>
            </Pressable>
          ) : null}
          {canManage ? <Pressable disabled={saving} style={styles.endButton} onPress={endListing}><Text style={styles.endText}>{scheduled ? '取消排期' : '结束挂牌'}</Text></Pressable> : null}
          {!canManage && !readOnly ? <Text style={styles.doneText}>这条挂牌已结束，不能再修改。</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

function Stock({ label, value, unit, strong = false }: Readonly<{ label: string; value: string; unit: string; strong?: boolean }>) {
  return <View style={styles.stock}><Text style={styles.stockLabel}>{label}</Text><Text style={[styles.stockValue, strong && styles.stockStrong]}>{compact(value)}</Text><Text style={styles.stockUnit}>{unit}</Text></View>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.34)' },
  dismissArea: { flex: 1 },
  sheet: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 30, borderTopLeftRadius: 29, borderTopRightRadius: 29, backgroundColor: colors.surface },
  handle: { width: 42, height: 5, alignSelf: 'center', borderRadius: 3, backgroundColor: '#D4DDD7', marginBottom: 17 },
  header: { flexDirection: 'row', alignItems: 'center' }, headerCopy: { flex: 1 },
  eyebrow: { color: colors.primary, fontSize: 10, fontWeight: '900', letterSpacing: 1.3 },
  title: { color: colors.ink, fontSize: 22, fontWeight: '900', marginTop: 4 },
  close: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas },
  statusRow: { minHeight: 46, marginTop: 15, paddingHorizontal: 13, borderRadius: 14, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.canvas },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 }, statusActive: { backgroundColor: colors.green }, statusScheduled: { backgroundColor: colors.blue }, statusPaused: { backgroundColor: colors.amber },
  statusText: { color: colors.ink, fontSize: 12, fontWeight: '800' }, windowText: { flex: 1, textAlign: 'right', color: colors.muted, fontSize: 11 },
  stockGrid: { flexDirection: 'row', gap: 9, marginTop: 14 },
  stock: { flex: 1, minHeight: 98, padding: 12, borderRadius: 16, backgroundColor: colors.canvas },
  stockLabel: { color: colors.muted, fontSize: 10 }, stockValue: { color: colors.ink, fontSize: 20, fontWeight: '900', marginTop: 8 }, stockStrong: { color: colors.green }, stockUnit: { color: colors.muted, fontSize: 9, marginTop: 3 },
  price: { color: colors.ink, fontSize: 12, fontWeight: '800', marginTop: 14 },
  estimate: { marginTop: 12, padding: 13, borderRadius: 14, backgroundColor: colors.primarySoft },
  estimateLabel: { color: colors.muted, fontSize: 10 }, estimateValue: { color: colors.primary, fontSize: 18, fontWeight: '900', marginTop: 5 },
  estimateHint: { color: colors.muted, fontSize: 10, lineHeight: 15, marginTop: 7 },
  error: { marginTop: 13, padding: 12, borderRadius: 13, backgroundColor: '#FDECEC', flexDirection: 'row', gap: 7 }, errorText: { flex: 1, color: colors.red, fontSize: 11, lineHeight: 17 },
  readOnly: { marginTop: 13, padding: 12, borderRadius: 13, backgroundColor: '#FFF8E7', flexDirection: 'row', gap: 7 }, readOnlyText: { flex: 1, color: colors.muted, fontSize: 11, lineHeight: 17 },
  primary: { minHeight: 52, marginTop: 18, borderRadius: 17, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  primaryText: { color: colors.surface, fontSize: 14, fontWeight: '900' }, disabled: { opacity: 0.55 },
  endButton: { minHeight: 48, marginTop: 9, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FDECEC' }, endText: { color: colors.red, fontSize: 13, fontWeight: '800' },
  doneText: { color: colors.muted, fontSize: 12, textAlign: 'center', marginTop: 20, marginBottom: 5 },
});
