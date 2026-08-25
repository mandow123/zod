import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { kaiCloudVerificationCopy, loadKaiCloudVerification, revokeKaiCloudVerification,
  startKaiCloudVerification, type KaiCloudVerificationState } from './kai-cloud-verification';
import type { ProviderAsset } from './provider-assets';
import { colors } from './theme';

export function KaiCloudVerificationSheet({ asset, onClose, onChanged }: Readonly<{
  asset: ProviderAsset | null; onClose: () => void; onChanged: () => void | Promise<void>;
}>) {
  const [state, setState] = useState<KaiCloudVerificationState | null>(null);
  const [loading, setLoading] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null); const generation = useRef(0);
  const refresh = async (assetId: string, current: number) => {
    setLoading(true); setError(null);
    try { const next = await loadKaiCloudVerification(assetId); if (generation.current === current) setState(next); }
    catch (reason) { if (generation.current === current) setError(reason instanceof Error ? reason.message : '暂时无法读取验证状态。'); }
    finally { if (generation.current === current) setLoading(false); }
  };
  useEffect(() => {
    const current = ++generation.current; setState(null); setError(null);
    if (asset) void refresh(asset.id, current);
    return () => { if (generation.current === current) generation.current += 1; };
  }, [asset?.id]);
  if (!asset) return null;
  const copy = state ? kaiCloudVerificationCopy(state) : null;
  const startAllowed = state?.available && ['not_started','failed','revoked'].includes(state.status);
  const revokeAllowed = state?.available && ['pending','running','passed'].includes(state.status);
  const act = async (operation: 'start' | 'revoke') => {
    const current = generation.current; setBusy(true); setError(null);
    try {
      const next = operation === 'start' ? await startKaiCloudVerification(asset.id)
        : await revokeKaiCloudVerification(asset.id);
      if (generation.current !== current) return; setState(next); await onChanged();
    } catch (reason) { if (generation.current === current) setError(reason instanceof Error ? reason.message : '操作没有完成，请稍后重试。'); }
    finally { if (generation.current === current) setBusy(false); }
  };
  return <Modal visible animationType="slide" transparent onRequestClose={() => { if (!busy) onClose(); }}>
    <View style={styles.backdrop}><View style={styles.sheet}>
      <View style={styles.handle} /><View style={styles.header}><View style={styles.headerCopy}>
        <Text style={styles.eyebrow}>KAI CLOUD</Text><Text style={styles.title}>在线验证</Text>
        <Text style={styles.subtitle}>{asset.name} · 验证结果由云端服务确认</Text>
      </View><Pressable disabled={busy} onPress={onClose} style={styles.close}><Ionicons name="close" size={22} color={colors.ink} /></Pressable></View>
      <View style={styles.content}>
        <View style={styles.security}><Ionicons name="shield-checkmark-outline" size={24} color={colors.primary} /><Text style={styles.securityText}>App 不保存 KAI Cloud 密钥，也不会使用网站 Cookie 或管理员接口。</Text></View>
        {loading ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}
        {error ? <View style={styles.error}><Text style={styles.errorText}>{error}</Text><Pressable disabled={busy} onPress={() => void refresh(asset.id, generation.current)}><Text style={styles.retry}>重新读取</Text></Pressable></View> : null}
        {copy ? <View style={[styles.status, copy.tone === 'success' && styles.success, copy.tone === 'warning' && styles.warning, copy.tone === 'danger' && styles.danger]}>
          <Text style={styles.statusTitle}>{copy.label}</Text><Text style={styles.statusDetail}>{copy.detail}</Text>
          {state?.updatedAt ? <Text style={styles.updated}>云端更新时间：{new Date(state.updatedAt).toLocaleString('zh-CN')}</Text> : null}
        </View> : null}
        {startAllowed ? <Pressable disabled={busy} onPress={() => void act('start')} style={styles.primary}>{busy ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>发起在线验证</Text>}</Pressable> : null}
        {revokeAllowed ? <Pressable disabled={busy} onPress={() => void act('revoke')} style={styles.revoke}><Text style={styles.revokeText}>撤销本轮验证</Text></Pressable> : null}
      </View>
    </View></View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.42)' },
  sheet: { minHeight: '58%', paddingTop: 9, borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: colors.canvas },
  handle: { width: 42, height: 5, alignSelf: 'center', borderRadius: 3, backgroundColor: '#D0D5DD' },
  header: { padding: 18, flexDirection: 'row', alignItems: 'flex-start' }, headerCopy: { flex: 1 },
  eyebrow: { color: colors.primary, fontSize: 12, fontWeight: '900', letterSpacing: 0.8 },
  title: { color: colors.ink, fontSize: 24, fontWeight: '900', marginTop: 4 },
  subtitle: { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 4 },
  close: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  content: { paddingHorizontal: 18, paddingBottom: 30 },
  security: { padding: 14, borderRadius: 16, flexDirection: 'row', gap: 10, backgroundColor: colors.primarySoft },
  securityText: { flex: 1, color: colors.primaryDark, fontSize: 13, lineHeight: 20 }, loader: { marginTop: 24 },
  error: { marginTop: 12, padding: 13, borderRadius: 14, backgroundColor: '#FEECEB' },
  errorText: { color: colors.red, fontSize: 13, lineHeight: 20 }, retry: { color: colors.primary, fontWeight: '900', marginTop: 8 },
  status: { marginTop: 14, padding: 16, borderRadius: 18, backgroundColor: colors.surface },
  success: { backgroundColor: colors.greenSoft }, warning: { backgroundColor: colors.amberSoft }, danger: { backgroundColor: '#FEECEB' },
  statusTitle: { color: colors.ink, fontSize: 17, fontWeight: '900' }, statusDetail: { color: colors.muted, fontSize: 13, lineHeight: 21, marginTop: 5 },
  updated: { color: colors.muted, fontSize: 11, marginTop: 10 },
  primary: { minHeight: 52, marginTop: 16, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  primaryText: { color: colors.surface, fontSize: 16, fontWeight: '900' },
  revoke: { minHeight: 50, marginTop: 10, borderWidth: 1, borderColor: '#F2B7B7', borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  revokeText: { color: colors.red, fontSize: 14, fontWeight: '900' },
});
