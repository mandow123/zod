import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError } from './api-client';
import { loadStagingOrder } from './staging-sandbox-api';
import { loadStagingSshPublicKeys, submitStagingManualDelivery, type StagingSshPublicKey } from './staging-manual-delivery-api';
import { replayStagingProfileMutation, type StagingProfileMutation } from './staging-profile-mutation-recovery-core';
import { clearConfirmedStagingProfileMutation, loadPendingStagingProfileMutation,
  savePendingStagingProfileMutation } from './staging-profile-mutation-recovery';
import { acquireStagingOrderMutation } from './staging-order-mutation-lock';
import { shouldReloadStagingOrderSlot, type StagingOrderSlotRefresh } from './staging-order-slot-sync';
import { loadStagingPrincipalFingerprint } from './staging-principal';
import { colors } from './theme';

const statusLabel = {
  submitted: '等待平台核验', key_verified: '公钥已核验', provisioning: '人工准备中', ready: '人工履约已就绪',
  rejected: '履约资料未通过', canceled: '履约申请已取消',
} as const;

async function signature(payload: object) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(payload));
}

export function StagingManualDeliverySlot({ enabled, orderId, onChanged, refreshSignal }: Readonly<{
  enabled: boolean; orderId: string; onChanged: () => Promise<void> | void;
  refreshSignal: StagingOrderSlotRefresh;
}>) {
  const [order, setOrder] = useState<Awaited<ReturnType<typeof loadStagingOrder>> | null>(null);
  const [visible, setVisible] = useState(false);
  const [keys, setKeys] = useState<StagingSshPublicKey[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const observedRefreshRevision = useRef(0);

  const execute = useCallback(async (pending: StagingProfileMutation) => {
    if (pending.operation !== 'submit_manual_delivery') throw new Error('待确认操作与人工履约不匹配。');
    const payload = pending.payload as { orderId?: unknown; expectedOrderVersion?: unknown; sshPublicKeyId?: unknown };
    if (typeof payload.orderId !== 'string' || !Number.isInteger(payload.expectedOrderVersion)
      || typeof payload.sshPublicKeyId !== 'string') throw new Error('待确认人工履约资料格式异常。');
    return submitStagingManualDelivery(payload.orderId, Number(payload.expectedOrderVersion), payload.sshPublicKeyId,
      pending.idempotencyKey);
  }, []);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const pending = await loadPendingStagingProfileMutation();
      if (pending?.operation === 'submit_manual_delivery' && pending.payload.orderId === orderId) {
        try {
          await replayStagingProfileMutation(pending, await loadStagingPrincipalFingerprint(), execute,
            clearConfirmedStagingProfileMutation);
        } catch (reason) {
          if (reason instanceof ApiError && reason.status === 409) {
            await clearConfirmedStagingProfileMutation(pending.idempotencyKey);
          } else throw reason;
        }
      }
      setOrder(await loadStagingOrder(orderId));
    } catch (reason) { setError(reason instanceof Error ? reason.message : '人工履约状态暂时无法读取。'); }
  }, [execute, orderId]);

  useEffect(() => { if (enabled) void reload(); else setOrder(null); }, [enabled, reload]);
  useEffect(() => {
    if (!enabled || !shouldReloadStagingOrderSlot(refreshSignal, observedRefreshRevision.current, orderId)) return;
    observedRefreshRevision.current = refreshSignal.revision;
    void reload();
  }, [enabled, orderId, refreshSignal, reload]);

  const open = async () => {
    setBusy(true); setError(null);
    try {
      const active = (await loadStagingSshPublicKeys()).filter((item) => item.status === 'active');
      setKeys(active); setSelected(active[0]?.id ?? null); setVisible(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '公钥列表暂时无法读取。'); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    if (!order || !selected || !attested || !order.allowedActions.includes('submit_manual_delivery')) return;
    const releaseMutation = acquireStagingOrderMutation(order.id);
    if (!releaseMutation) { setError('该订单另一项操作正在确认，请等待结果。'); return; }
    let pending: StagingProfileMutation | null = null;
    setBusy(true); setError(null);
    try {
      const latest = await loadStagingOrder(order.id);
      setOrder(latest);
      if (!latest.allowedActions.includes('submit_manual_delivery')) {
        throw new Error('服务端已更新订单，当前不允许提交人工履约资料。');
      }
      const payload = { orderId: latest.id, expectedOrderVersion: latest.version, sshPublicKeyId: selected };
      const digest = await signature({ operation: 'submit_manual_delivery', ...payload });
      const existing = await loadPendingStagingProfileMutation();
      const input = { operation: 'submit_manual_delivery' as const, signature: digest,
        idempotencyKey: `staging-manual-delivery:${Crypto.randomUUID()}`, payload };
      if (existing && existing.signature !== digest) throw new Error('上一项安全操作结果仍待确认，不能提交新的履约资料。');
      pending = existing ?? await savePendingStagingProfileMutation(input);
      await replayStagingProfileMutation(pending, await loadStagingPrincipalFingerprint(), execute,
        clearConfirmedStagingProfileMutation);
      setVisible(false); setAttested(false); await reload(); await onChanged();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409 && pending) {
        try {
          await clearConfirmedStagingProfileMutation(pending.idempotencyKey);
          setError('服务端已拒绝过期版本的履约资料，订单已重新读取。');
          await reload(); await onChanged();
          return;
        } catch (cleanupReason) {
          setError(cleanupReason instanceof Error ? cleanupReason.message : '人工履约资料结果尚未确认。');
          return;
        }
      }
      setError(reason instanceof Error ? reason.message : '人工履约资料结果尚未确认。');
    }
    finally { releaseMutation(); setBusy(false); }
  };

  if (!enabled || !order || (!order.manualDeliveryRequest && !order.allowedActions.includes('submit_manual_delivery'))) return null;
  return <View style={styles.card}>
    <View style={styles.heading}><View style={styles.icon}><Ionicons name="key-outline" size={18} color={colors.primary} /></View>
      <View style={styles.copy}><Text style={styles.title}>人工履约</Text><Text style={styles.meta}>只使用已保存的 SSH 公钥，不收集任何私钥。</Text></View></View>
    {order.manualDeliveryRequest ? <View style={styles.request}>
      <Text style={styles.status}>{statusLabel[order.manualDeliveryRequest.status]}</Text>
      <Text style={styles.keyLabel}>{order.manualDeliveryRequest.key.label}</Text>
      <Text style={styles.fingerprint}>{order.manualDeliveryRequest.key.algorithm} · {order.manualDeliveryRequest.key.fingerprint}</Text>
      <Text style={styles.safety}>不显示真实服务器秘密，不提供复制或连接按钮。</Text>
    </View> : <Pressable disabled={busy} onPress={() => void open()} style={styles.primary}>
      {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>提交人工履约资料</Text>}
    </Pressable>}
    {error ? <Text style={styles.error}>{error}</Text> : null}
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => setVisible(false)}>
      <View style={styles.backdrop}><View style={styles.sheet}><View style={styles.handle} />
        <View style={styles.sheetHead}><View><Text style={styles.sheetTitle}>选择 SSH 公钥</Text>
          <Text style={styles.sheetMeta}>只提交公钥标识；不会传输私钥或服务器连接资料。</Text></View>
          <Pressable onPress={() => setVisible(false)}><Ionicons name="close" size={22} color={colors.ink} /></Pressable></View>
        <ScrollView>{keys.map((key) => <Pressable key={key.id} onPress={() => setSelected(key.id)}
          style={[styles.keyRow, selected === key.id && styles.keyRowActive]}><View style={styles.copy}>
            <Text style={styles.keyLabel}>{key.label}</Text><Text style={styles.fingerprint}>{key.algorithm} · {key.fingerprint}</Text></View>
          <Ionicons name={selected === key.id ? 'checkmark-circle' : 'ellipse-outline'} size={20}
            color={selected === key.id ? colors.primary : colors.subtle} /></Pressable>)}</ScrollView>
        {!keys.length ? <Text style={styles.empty}>没有可用公钥，请先到“我的 → SSH 公钥”添加。</Text> : null}
        <Pressable onPress={() => setAttested((value) => !value)} style={styles.attest}>
          <Ionicons name={attested ? 'checkbox' : 'square-outline'} size={20} color={attested ? colors.primary : colors.muted} />
          <Text style={styles.attestText}>我确认选择的是自己控制的公钥，并同意测试环境人工履约条款。</Text></Pressable>
        <Pressable disabled={busy || !selected || !attested} onPress={() => void submit()}
          style={[styles.primary, (!selected || !attested) && styles.disabled]}><Text style={styles.primaryText}>保存到服务器</Text></Pressable>
      </View></View>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  card: { marginTop: 14, padding: 14, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  heading: { flexDirection: 'row', alignItems: 'center' }, icon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft },
  copy: { flex: 1, marginLeft: 10 }, title: { color: colors.ink, fontSize: 14, fontWeight: '900' }, meta: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 4 },
  request: { marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: colors.canvas }, status: { color: colors.primary, fontSize: 12, fontWeight: '900' }, keyLabel: { color: colors.ink, fontSize: 11, fontWeight: '800', marginTop: 7 }, fingerprint: { color: colors.muted, fontSize: 8, marginTop: 4 }, safety: { color: colors.amber, fontSize: 9, lineHeight: 14, marginTop: 9 },
  primary: { minHeight: 46, marginTop: 12, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' }, disabled: { opacity: 0.45 }, error: { color: colors.red, fontSize: 9, lineHeight: 14, marginTop: 9 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(17,24,39,0.30)' }, sheet: { maxHeight: '82%', padding: 18, paddingBottom: 28, borderTopLeftRadius: 18, borderTopRightRadius: 18, backgroundColor: colors.surface }, handle: { width: 38, height: 4, alignSelf: 'center', borderRadius: 2, backgroundColor: '#D0D5DD' },
  sheetHead: { minHeight: 72, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, sheetTitle: { color: colors.ink, fontSize: 19, fontWeight: '900' }, sheetMeta: { color: colors.muted, fontSize: 9, marginTop: 5 },
  keyRow: { minHeight: 64, padding: 12, marginBottom: 8, borderRadius: 12, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.line, backgroundColor: colors.canvas }, keyRowActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft }, empty: { color: colors.muted, fontSize: 10, padding: 20, textAlign: 'center' }, attest: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 8 }, attestText: { flex: 1, color: colors.ink, fontSize: 9, lineHeight: 14 },
});
