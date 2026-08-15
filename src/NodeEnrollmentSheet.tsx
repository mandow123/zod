import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as ScreenCapture from 'expo-screen-capture';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, Modal, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { NODE_ENROLL_COMMAND } from './node-claim-envelope';
import type { ProviderAsset } from './provider-assets';
import { issueProviderNodeClaim, revokeProviderNodeEnrollment } from './provider-node-enrollment';
import { colors } from './theme';

type IssuedClaim = Awaited<ReturnType<typeof issueProviderNodeClaim>>;

export function NodeEnrollmentSheet({ asset, onClose, onChanged }: Readonly<{
  asset: ProviderAsset | null;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}>) {
  const [issued, setIssued] = useState<IssuedClaim | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const screenCaptureKey = useRef<string | null>(null);
  const clipboardSecret = useRef<string | null>(null);
  const clipboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestGeneration = useRef(0);

  const releaseScreen = async () => {
    const key = screenCaptureKey.current;
    screenCaptureKey.current = null;
    if (key) await ScreenCapture.allowScreenCaptureAsync(key).catch(() => undefined);
  };

  const clearClipboard = async () => {
    if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    clipboardTimer.current = null;
    const secret = clipboardSecret.current;
    clipboardSecret.current = null;
    if (!secret) return;
    try {
      if (await Clipboard.getStringAsync() === secret) await Clipboard.setStringAsync('');
    } catch { /* Clipboard cleanup is best effort. */ }
  };

  const clearSensitiveState = async () => {
    requestGeneration.current += 1;
    setIssued(null); setBusy(false);
    await Promise.all([releaseScreen(), clearClipboard()]);
  };

  useEffect(() => {
    if (!issued) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [issued]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') void clearSensitiveState();
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => () => { void clearSensitiveState(); }, []);

  useEffect(() => {
    void clearSensitiveState(); setError(null); setNotice(null); setNow(Date.now());
  }, [asset?.id]);

  if (!asset) return null;
  const nodeAction = asset.nodeAction;
  const canIssue = nodeAction?.key === 'issue_node_claim';
  const deploymentId = nodeAction?.deploymentId ?? asset.nodeEnrollment.deploymentId;
  const remainingSeconds = issued ? Math.max(0, Math.ceil((Date.parse(issued.envelope.expiresAt) - now) / 1_000)) : 0;

  const issue = async () => {
    const generation = ++requestGeneration.current;
    setBusy(true); setError(null); setNotice(null);
    let pendingScreenKey: string | null = null;
    try {
      const result = await issueProviderNodeClaim(asset.id);
      if (generation !== requestGeneration.current) return;
      pendingScreenKey = `kai-node-claim-${result.envelope.claimId}`;
      await ScreenCapture.preventScreenCaptureAsync(pendingScreenKey);
      if (generation !== requestGeneration.current) {
        await ScreenCapture.allowScreenCaptureAsync(pendingScreenKey).catch(() => undefined); return;
      }
      screenCaptureKey.current = pendingScreenKey; pendingScreenKey = null;
      setIssued(result); setNow(Date.now());
      setNotice(result.replayed ? '已恢复同一份接入配置。' : '接入配置已生成，请在失效前完成。');
      await onChanged();
    } catch (reason) {
      if (pendingScreenKey) await ScreenCapture.allowScreenCaptureAsync(pendingScreenKey).catch(() => undefined);
      if (generation === requestGeneration.current) {
        setError(reason instanceof Error ? reason.message : '暂时无法生成接入配置。');
      }
    } finally { if (generation === requestGeneration.current) setBusy(false); }
  };

  const copy = async (value: string, secret: boolean) => {
    try {
      await Clipboard.setStringAsync(value);
      if (secret) {
        clipboardSecret.current = value;
        if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
        clipboardTimer.current = setTimeout(() => void clearClipboard(), 60_000);
        setNotice('一次性配置已复制，60 秒后会尝试从剪贴板清除。');
      } else setNotice('命令已复制。');
    } catch { setError('复制失败，请检查系统剪贴板权限。'); }
  };

  const refresh = async () => {
    setBusy(true); setError(null);
    try { await onChanged(); setNotice('已读取最新节点状态。'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '暂时没能刷新节点状态。'); }
    finally { setBusy(false); }
  };

  const revoke = () => {
    if (!deploymentId) return;
    Alert.alert('断开这台节点？', '有挂牌或正在交付的订单时，平台会拒绝断开。确认断开后，这一代接入不能恢复。', [
      { text: '取消', style: 'cancel' },
      { text: '确认断开', style: 'destructive', onPress: () => void revokeConfirmed(deploymentId) },
    ]);
  };

  const revokeConfirmed = async (targetDeploymentId: string) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await revokeProviderNodeEnrollment(asset.id, targetDeploymentId);
      await clearSensitiveState(); await onChanged();
      setNotice(result.replayed ? '这次接入此前已经断开。' : '节点已断开。'); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '暂时无法断开节点。'); }
    finally { setBusy(false); }
  };

  const close = () => { void clearSensitiveState(); onClose(); };

  return <Modal visible animationType="slide" transparent onRequestClose={close}>
    <View style={styles.backdrop}><View style={styles.sheet}>
      <View style={styles.handle} />
      <View style={styles.header}>
        <View style={styles.headerCopy}><Text style={styles.eyebrow}>设备接入</Text><Text style={styles.title}>{asset.name}</Text><Text style={styles.subtitle}>{asset.region} · {asset.deliveryReadiness.label}</Text></View>
        <Pressable disabled={busy} onPress={close} style={styles.close}><Ionicons name="close" size={22} color={colors.ink} /></Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.securityCard}><Ionicons name="shield-checkmark-outline" size={24} color={colors.primary} /><View style={styles.securityCopy}><Text style={styles.securityTitle}>安全接入</Text><Text style={styles.securityText}>一次性配置 10 分钟内有效。接入后，平台会核对 GPU 和运行环境。</Text></View></View>
        {error ? <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View> : null}
        {notice ? <View style={styles.notice}><Text style={styles.noticeText}>{notice}</Text></View> : null}

        {!issued && canIssue ? <>
          <Step number="1" title="在服务器安装节点程序" detail="安装完成后，不要手动填写节点编号或密钥。" />
          <Step number="2" title={asset.nodeEnrollment.status === 'claim_issued' ? '恢复一次性接入配置' : '生成一次性接入配置'} detail="配置只在本页临时保留；App 进入后台后会立即清除。" />
          <Pressable disabled={busy} onPress={() => void issue()} style={[styles.primary, busy && styles.disabled]}>{busy ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>{asset.nodeEnrollment.status === 'claim_issued' ? '恢复接入配置' : '生成接入配置'}</Text>}</Pressable>
          {deploymentId ? <Pressable disabled={busy} onPress={revoke} style={styles.textButton}><Text style={styles.dangerText}>取消本次接入</Text></Pressable> : null}
        </> : null}

        {issued ? <>
          <View style={[styles.expiry, remainingSeconds <= 60 && styles.expiryUrgent]}><Text style={styles.expiryLabel}>配置剩余时间</Text><Text style={styles.expiryValue}>{timeRemaining(remainingSeconds)}</Text></View>
          <Step number="1" title="在 H100 服务器运行" detail="这个命令会打开安全输入，不会把密钥写进命令历史。" />
          <CopyRow value={NODE_ENROLL_COMMAND} label="复制命令" onCopy={() => void copy(NODE_ENROLL_COMMAND, false)} />
          <Step number="2" title="粘贴一次性配置" detail="运行命令后粘贴配置并回车。配置不会在屏幕上回显。" />
          <Pressable disabled={busy || remainingSeconds === 0} onPress={() => void copy(issued.serialized, true)} style={[styles.secretButton, (busy || remainingSeconds === 0) && styles.disabled]}><Ionicons name="copy-outline" size={18} color={colors.primary} /><Text style={styles.secretText}>{remainingSeconds === 0 ? '配置已失效，请重新生成' : '复制一次性配置'}</Text></Pressable>
          <Step number="3" title="回到这里看节点状态" detail="出现“节点在线，可交付”后，才能创建上架方案。" />
          <Pressable disabled={busy} onPress={() => void refresh()} style={[styles.primary, busy && styles.disabled]}>{busy ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>我已完成，刷新状态</Text>}</Pressable>
        </> : null}

        {!canIssue && nodeAction?.key === 'revoke_node_enrollment' ? <>
          <View style={styles.connected}><Ionicons name="checkmark-circle" size={26} color={colors.green} /><View style={styles.connectedCopy}><Text style={styles.connectedTitle}>{asset.deliveryReadiness.label}</Text><Text style={styles.connectedText}>节点正在由平台持续核对。断开前请先处理挂牌和正在交付的订单。</Text></View></View>
          <Pressable disabled={busy} onPress={revoke} style={[styles.revoke, busy && styles.disabled]}>{busy ? <ActivityIndicator color={colors.red} /> : <Text style={styles.revokeText}>断开节点</Text>}</Pressable>
        </> : null}
      </ScrollView>
    </View></View>
  </Modal>;
}

function Step({ number, title, detail }: Readonly<{ number: string; title: string; detail: string }>) {
  return <View style={styles.step}><View style={styles.stepNumber}><Text style={styles.stepNumberText}>{number}</Text></View><View style={styles.stepCopy}><Text style={styles.stepTitle}>{title}</Text><Text style={styles.stepDetail}>{detail}</Text></View></View>;
}

function CopyRow({ value, label, onCopy }: Readonly<{ value: string; label: string; onCopy: () => void }>) {
  return <View style={styles.copyRow}><Text numberOfLines={2} style={styles.code}>{value}</Text><Pressable onPress={onCopy} style={styles.copyButton}><Text style={styles.copyText}>{label}</Text></Pressable></View>;
}

function timeRemaining(seconds: number) {
  const minutes = Math.floor(seconds / 60); const rest = String(seconds % 60).padStart(2, '0');
  return `${minutes}:${rest}`;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.42)' },
  sheet: { height: '92%', paddingTop: 9, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden', backgroundColor: colors.canvas },
  handle: { width: 42, height: 5, alignSelf: 'center', borderRadius: 3, backgroundColor: '#D0D5DD' },
  header: { paddingHorizontal: 18, paddingVertical: 15, flexDirection: 'row', alignItems: 'flex-start' }, headerCopy: { flex: 1 },
  eyebrow: { color: colors.primary, fontSize: 12, fontWeight: '800', letterSpacing: 0.8 }, title: { color: colors.ink, fontSize: 24, lineHeight: 32, fontWeight: '900', marginTop: 3 }, subtitle: { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 3 },
  close: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  content: { paddingHorizontal: 17, paddingBottom: 50 },
  securityCard: { padding: 16, borderRadius: 16, flexDirection: 'row', alignItems: 'flex-start', backgroundColor: colors.primarySoft }, securityCopy: { flex: 1, marginLeft: 12 }, securityTitle: { color: colors.primaryDark, fontSize: 16, lineHeight: 24, fontWeight: '900' }, securityText: { color: colors.muted, fontSize: 14, lineHeight: 22, marginTop: 3 },
  error: { marginTop: 10, padding: 12, borderRadius: 12, backgroundColor: '#FEECEB' }, errorText: { color: colors.red, fontSize: 14, lineHeight: 22 }, notice: { marginTop: 10, padding: 12, borderRadius: 12, backgroundColor: colors.primarySoft }, noticeText: { color: colors.primaryDark, fontSize: 14, lineHeight: 22 },
  step: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 20 }, stepNumber: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, stepNumberText: { color: colors.surface, fontSize: 12, fontWeight: '900' }, stepCopy: { flex: 1, marginLeft: 12 }, stepTitle: { color: colors.ink, fontSize: 16, lineHeight: 24, fontWeight: '900' }, stepDetail: { color: colors.muted, fontSize: 14, lineHeight: 22, marginTop: 2 },
  primary: { minHeight: 52, marginTop: 20, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 16, fontWeight: '900' }, disabled: { opacity: 0.5 }, textButton: { minHeight: 46, marginTop: 6, alignItems: 'center', justifyContent: 'center' }, dangerText: { color: colors.red, fontSize: 14, fontWeight: '800' },
  expiry: { marginTop: 16, padding: 14, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.amberSoft }, expiryUrgent: { backgroundColor: '#FEECEB' }, expiryLabel: { color: colors.muted, fontSize: 14 }, expiryValue: { color: colors.amber, fontSize: 18, fontWeight: '900', fontVariant: ['tabular-nums'] },
  copyRow: { minHeight: 60, marginTop: 10, padding: 12, borderRadius: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface }, code: { flex: 1, color: colors.ink, fontSize: 12, lineHeight: 18, fontFamily: 'monospace' }, copyButton: { minHeight: 44, marginLeft: 10, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, copyText: { color: colors.primary, fontSize: 13, fontWeight: '900' },
  secretButton: { minHeight: 52, marginTop: 10, borderWidth: 1, borderColor: '#B9D2F7', borderRadius: 12, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, secretText: { color: colors.primary, fontSize: 15, fontWeight: '900' },
  connected: { marginTop: 18, padding: 15, borderRadius: 18, flexDirection: 'row', alignItems: 'flex-start', backgroundColor: colors.greenSoft }, connectedCopy: { flex: 1, marginLeft: 11 }, connectedTitle: { color: colors.greenDark, fontSize: 14, fontWeight: '900' }, connectedText: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 4 },
  revoke: { minHeight: 52, marginTop: 20, borderWidth: 1, borderColor: '#F2B7B7', borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, revokeText: { color: colors.red, fontSize: 13, fontWeight: '900' },
});
