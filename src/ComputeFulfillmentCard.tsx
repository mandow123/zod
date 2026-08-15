import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import * as ScreenCapture from 'expo-screen-capture';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  acceptCloudPayFulfillment, createCloudPayAccessSession, loadCloudPayFulfillment, provisionCloudPayFulfillment,
  loadCloudPayFulfillmentIssue, reportCloudPayFulfillmentIssue, stopCloudPayFulfillment,
  type CloudPayFulfillmentIssue, type CloudPayFulfillmentResponse, type CloudPaySshConnection,
  type CloudPayOrder,
} from './api';
import { accessRequestIsCurrent } from './access-request-lifecycle';
import { acceptancePresentation, accessExpiryCopy, canEnterFulfillment, fulfillmentPresentation } from './fulfillment-ui';
import { FulfillmentIssueCard } from './FulfillmentIssueCard';
import { knownHostsInstallCommand, privateKeyPath, sshCommand, validateSshConnection } from './ssh-connection';
import { colors } from './theme';
import { isAmbiguousMutationFailure } from './mutation-recovery';
import { creditAmount } from './format';

export function ComputeFulfillmentCard({ order, onChanged, onSnapshot, onIssueChanged }: Readonly<{
  order: CloudPayOrder;
  onChanged: () => Promise<void> | void;
  onSnapshot?: (snapshot: CloudPayFulfillmentResponse | null) => void;
  onIssueChanged?: (issue: CloudPayFulfillmentIssue | null) => void;
}>) {
  const [state, setState] = useState<CloudPayFulfillmentResponse | null>(null);
  const [connection, setConnection] = useState<CloudPaySshConnection | null>(null);
  const [revealPrivateKey, setRevealPrivateKey] = useState(false);
  const [issue, setIssue] = useState<CloudPayFulfillmentIssue | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [issueKind, setIssueKind] = useState<'access' | 'metering'>('metering');
  const [issueDescription, setIssueDescription] = useState('');
  const requestIds = useRef(new Map<string, string>());
  const connectionRef = useRef<CloudPaySshConnection | null>(null);
  const screenCaptureKeyRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const orderIdRef = useRef(order.id);
  const accessGenerationRef = useRef(0);
  orderIdRef.current = order.id;

  const requestId = (action: string) => {
    const existing = requestIds.current.get(action);
    if (existing) return existing;
    const created = `fulfillment-${action}-${Crypto.randomUUID()}`;
    requestIds.current.set(action, created);
    return created;
  };

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const latest = await loadCloudPayFulfillment(order.id);
      setState(latest); setNow(Date.now()); setError(null);
      try {
        const issueResult = await loadCloudPayFulfillmentIssue(order.id);
        setIssue(issueResult.issue); setIssueError(null);
      } catch (reason) {
        setIssueError(reason instanceof Error ? reason.message : '问题处理结果暂时无法读取。');
      }
      return latest;
    } catch (reason) {
      if (!quiet) setError(reason instanceof Error ? reason.message : '算力状态暂时无法读取。');
      return null;
    } finally { if (!quiet) setLoading(false); }
  }, [order.id]);

  const syncAfterConfirmed = useCallback((fallbackNotice: string, isCurrent = () => (
    mountedRef.current && orderIdRef.current === order.id
  )) => {
    void (async () => {
      const latest = await refresh(true);
      let parentSynced = true;
      try { await onChanged(); } catch { parentSynced = false; }
      if ((!latest || !parentSynced) && isCurrent()) setNotice(fallbackNotice);
    })();
  }, [onChanged, order.id, refresh]);

  useEffect(() => {
    accessGenerationRef.current += 1;
    requestIds.current.clear();
    setState(null); setConnection(null); setRevealPrivateKey(false); setIssue(null); setNotice(null); setError(null); setIssueError(null); setNow(Date.now());
    setIssueKind('metering'); setIssueDescription(''); setBusy(false);
    void refresh();
    return undefined;
  }, [refresh]);

  useEffect(() => { onSnapshot?.(state); }, [onSnapshot, state]);
  useEffect(() => { onIssueChanged?.(issue); }, [issue, onIssueChanged]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      accessGenerationRef.current += 1;
      requestIds.current.delete('access');
    };
  }, []);

  useEffect(() => {
    const status = state?.fulfillment?.status;
    const acceptancePending = status === 'stopped' && state?.fulfillment?.acceptanceMode === 'pending';
    if (!status || ((status === 'failed' || (status === 'stopped' && !acceptancePending)) && issue?.status !== 'open')) return undefined;
    const delay = ['pending', 'provisioning', 'stopping'].includes(status) ? 5_000 : 15_000;
    const timer = setInterval(() => void refresh(true), delay);
    return () => clearInterval(timer);
  }, [issue?.status, refresh, state?.fulfillment?.acceptanceMode, state?.fulfillment?.status]);

  useEffect(() => {
    if (!connection) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [connection]);

  useEffect(() => {
    connectionRef.current = connection;
    return () => { connectionRef.current = null; };
  }, [connection]);

  useEffect(() => {
    if (connection || !screenCaptureKeyRef.current) return;
    const key = screenCaptureKeyRef.current;
    screenCaptureKeyRef.current = null;
    void ScreenCapture.allowScreenCaptureAsync(key).catch(() => undefined);
  }, [connection]);

  useEffect(() => () => {
    const key = screenCaptureKeyRef.current;
    screenCaptureKeyRef.current = null;
    if (key) void ScreenCapture.allowScreenCaptureAsync(key).catch(() => undefined);
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') {
        const hadConnection = connectionRef.current !== null;
        accessGenerationRef.current += 1;
        requestIds.current.delete('access');
        connectionRef.current = null;
        setConnection(null); setRevealPrivateKey(false);
        setBusy(false);
        if (hadConnection) setNotice('App 进入后台后已清除连接信息，需要时请重新获取。');
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (connection && Date.parse(connection.expiresAt) <= now) {
      setConnection(null); setRevealPrivateKey(false);
      setNotice('上一次连接信息已失效，需要时可重新获取。');
    }
  }, [connection, now]);

  const provision = async () => {
    const key = requestId('provision');
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await provisionCloudPayFulfillment(order.id, key);
      requestIds.current.delete('provision');
      setState(result); setNotice('已重新发起开通，平台正在检查真实实例。');
      await onChanged();
    } catch (reason) {
      const latest = await refresh(true);
      if (latest?.fulfillment && latest.fulfillment.status !== 'pending') {
        requestIds.current.delete('provision'); setNotice('开通请求已收到，状态已经同步。');
      } else setError(reason instanceof Error ? reason.message : '暂时无法发起开通，请稍后重试。');
    } finally { setBusy(false); }
  };

  const enter = async () => {
    const key = requestId('access');
    const requestedOrderId = order.id;
    const requestedGeneration = accessGenerationRef.current + 1;
    accessGenerationRef.current = requestedGeneration;
    const isCurrent = () => accessRequestIsCurrent({
      mounted: mountedRef.current,
      appState: AppState.currentState,
      currentOrderId: orderIdRef.current,
      requestedOrderId,
      currentGeneration: accessGenerationRef.current,
      requestedGeneration,
    });
    setBusy(true); setError(null); setNotice(null); setConnection(null); setRevealPrivateKey(false);
    let pendingScreenCaptureKey: string | null = null;
    try {
      const result = await createCloudPayAccessSession(order.id, key);
      requestIds.current.delete('access');
      if (!isCurrent()) return;
      const validated = validateSshConnection(
        result.session,
        result.fulfillment.connection,
        result.fulfillment.leaseExpiresAt,
      );
      pendingScreenCaptureKey = `kai-cloudpay-ssh-${key}`;
      await ScreenCapture.preventScreenCaptureAsync(pendingScreenCaptureKey);
      if (!isCurrent()) {
        await ScreenCapture.allowScreenCaptureAsync(pendingScreenCaptureKey).catch(() => undefined);
        pendingScreenCaptureKey = null;
        return;
      }
      screenCaptureKeyRef.current = pendingScreenCaptureKey;
      pendingScreenCaptureKey = null;
      setConnection(validated); setNow(Date.now());
      setNotice('连接信息已获取。私钥只在本页保留，请在失效前使用。');
      syncAfterConfirmed('连接信息已获取，最新订单状态稍后同步。', isCurrent);
    } catch (reason) {
      if (pendingScreenCaptureKey) {
        await ScreenCapture.allowScreenCaptureAsync(pendingScreenCaptureKey).catch(() => undefined);
      }
      if (!isAmbiguousMutationFailure(reason)) requestIds.current.delete('access');
      if (!isCurrent()) return;
      await refresh(true);
      if (!isCurrent()) return;
      setError(reason instanceof Error ? reason.message : '暂时无法获取连接信息，请重新获取。');
    } finally { if (isCurrent()) setBusy(false); }
  };

  const stop = () => Alert.alert(
    '停止本次算力',
    '停止后不能重新启动。请先保存模型、代码和数据，平台会关闭连接并核对最终用量。',
    [
      { text: '继续使用', style: 'cancel' },
      { text: '确认停止', style: 'destructive', onPress: () => void stopConfirmed() },
    ],
  );

  const stopConfirmed = async () => {
    accessGenerationRef.current += 1;
    requestIds.current.delete('access');
    const key = requestId('stop');
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await stopCloudPayFulfillment(order.id, key);
      requestIds.current.delete('stop'); setState(result); setConnection(null); setRevealPrivateKey(false);
      setNotice(result.fulfillment?.status === 'stopped'
        ? '算力已停止，请在验收截止前核对平台计量。'
        : '停止请求已收到，平台正在安全关闭实例。');
      await Promise.all([refresh(true), Promise.resolve(onChanged())]);
    } catch (reason) {
      const latest = await refresh(true);
      if (latest?.fulfillment && ['stopping', 'stopped'].includes(latest.fulfillment.status)) {
        requestIds.current.delete('stop'); setConnection(null); setRevealPrivateKey(false); setNotice('停止请求已经生效。');
      } else setError(reason instanceof Error ? reason.message : '暂时无法停止算力，请稍后重试。');
    } finally { setBusy(false); }
  };

  const accept = () => Alert.alert(
    '确认本次用量',
    '确认后，平台会按服务端计量凭证结算实际使用的卡时，未使用部分立即退回卡时账户。',
    [
      { text: '再核对一下', style: 'cancel' },
      { text: '确认结算', onPress: () => void acceptConfirmed() },
    ],
  );

  const acceptConfirmed = async () => {
    accessGenerationRef.current += 1;
    requestIds.current.delete('access');
    const key = requestId('accept');
    setBusy(true); setError(null); setNotice(null); setConnection(null); setRevealPrivateKey(false);
    try {
      const result = await acceptCloudPayFulfillment(order.id, key);
      requestIds.current.delete('accept'); setState(result);
      setNotice(`已按实际用量结算 ${creditAmount(result.settlement.capturedCredits)} 卡时，退回 ${creditAmount(result.settlement.refundedCredits)} 卡时。`);
      syncAfterConfirmed('结算已经完成，最新订单状态稍后同步。');
    } catch (reason) {
      await refresh(true);
      setError(reason instanceof Error ? reason.message : '结算暂时没有完成，请稍后重试。');
    } finally { setBusy(false); }
  };

  const reportIssue = async () => {
    const description = issueDescription.trim();
    if (description.length < 10) return;
    const signature = `issue:${issueKind}`;
    const key = requestId(signature);
    setBusy(true); setError(null); setNotice(null);
    try {
      await reportCloudPayFulfillmentIssue(order.id, issueKind, description, key);
      requestIds.current.delete(signature); setIssueDescription('');
      setNotice('问题已提交，本单卡时继续冻结，平台处理结果会同步到订单和消息。');
      syncAfterConfirmed('问题已经提交，最新订单状态稍后同步。');
    } catch (reason) {
      await refresh(true);
      setError(reason instanceof Error ? reason.message : '问题暂时没有提交成功，请稍后重试。');
    } finally { setBusy(false); }
  };

  const copy = async (value: string, label: string) => {
    try { await Clipboard.setStringAsync(value); setNotice(label === '私钥' ? '私钥已复制；导入后请清空系统剪贴板。' : `${label}已复制`); }
    catch { setError(`${label}复制失败，请长按文字复制。`); }
  };

  if (loading && !state) return <View style={styles.card}><ActivityIndicator color={colors.primary} /></View>;
  const fulfillment = state?.fulfillment ?? null;
  const presentation = fulfillmentPresentation(fulfillment, order.status);
  const acceptance = acceptancePresentation(fulfillment, now);
  const canEnter = canEnterFulfillment(fulfillment, state?.accessAvailable ?? false, state?.actions ?? []);
  const toneStyle = presentation.tone === 'danger' ? styles.danger
    : presentation.tone === 'success' ? styles.success : presentation.tone === 'muted' ? styles.muted : styles.waiting;

  return <View style={[styles.card, toneStyle]}>
    <View style={styles.top}>
      <View style={styles.heading}>
        <Text style={styles.eyebrow}>我的算力</Text>
        <Text style={styles.title}>{presentation.title}</Text>
      </View>
      <View style={styles.status}><Ionicons name={presentation.icon} size={17} color={presentation.tone === 'danger' ? colors.red : presentation.tone === 'success' ? colors.green : presentation.tone === 'waiting' ? colors.amber : colors.muted} /><Text style={styles.statusText}>{presentation.label}</Text></View>
    </View>
    <Text style={styles.description}>{presentation.description}</Text>

    {fulfillment?.connection ? <View style={styles.connection}>
      <Text style={styles.connectionName}>{fulfillment.connection.displayName}</Text>
      <Text style={styles.connectionMeta}>{fulfillment.connection.protocol.toUpperCase()} · 由平台安全接入</Text>
    </View> : null}
    {fulfillment?.leaseExpiresAt ? <View style={styles.lease}><Ionicons name="timer-outline" size={15} color={colors.amber} /><Text style={styles.leaseText}>租约到期：{formatTime(fulfillment.leaseExpiresAt)}</Text></View> : null}

    {state?.usage ? <View style={styles.usage}>
      <View><Text style={styles.usageLabel}>{order.side === 'provider' ? '平台计量实耗' : '已使用卡时'}</Text><Text style={styles.usageValue}>{creditAmount(state.usage.consumedCredits)}</Text></View>
      <View style={styles.usageRight}><Text style={styles.usageLabel}>{order.side === 'provider'
        ? state.usage.issueOpen ? '结算核对中' : state.usage.acceptedAt ? '提供方待结算' : '验收中实耗'
        : state.usage.issueOpen ? '冻结中卡时' : state.usage.acceptedAt ? '已退回卡时' : '待退回卡时'}</Text><Text style={styles.usageValue}>{creditAmount(order.side === 'provider' ? state.usage.consumedCredits : state.usage.remainingCredits)}</Text></View>
      <Text style={styles.measured}>平台计量 · {formatTime(state.usage.measuredAt)}</Text>
    </View> : fulfillment?.status === 'running' ? <Text style={styles.meterPending}>正在等待平台计量记录，手机不会自行估算扣费。</Text> : null}

    {acceptance ? <View style={[styles.acceptance, acceptance.tone === 'success' && styles.acceptanceSuccess]}>
      <View style={styles.acceptanceTop}><Text style={styles.acceptanceTitle}>{acceptance.title}</Text>
        {acceptance.deadline ? <Text style={styles.acceptanceDeadline}>截止 {formatTime(acceptance.deadline)}</Text> : null}
      </View>
      <Text style={styles.acceptanceText}>{acceptance.description}</Text>
    </View> : null}

    {issue ? <FulfillmentIssueCard issue={issue} side={order.side} /> : null}
    {issueError ? <View style={styles.errorRow}><Text style={styles.error}>问题处理结果暂时无法读取。</Text><Pressable onPress={() => void refresh()}><Text style={styles.retry}>重新读取</Text></Pressable></View> : null}

    {fulfillment?.lastError ? <Text style={styles.failure}>{fulfillment.lastError.retryable
      ? '实例检查没有通过，平台会继续重试；目前不会开放入口。'
      : '实例无法交付，平台已停止开通并处理本单退款。'}</Text> : null}
    {notice ? <Text style={styles.notice}>{notice}</Text> : null}
    {error ? <View style={styles.errorRow}><Text style={styles.error}>{error}</Text><Pressable onPress={() => void refresh()}><Text style={styles.retry}>重新读取</Text></Pressable></View> : null}

    {connection ? <View style={styles.ticket}>
      <View style={styles.ticketTop}><Text style={styles.ticketTitle}>SSH 连接信息</Text><Text style={styles.expiry}>{accessExpiryCopy(connection.expiresAt, now)}</Text></View>
      <AccessRow label="主机" value={connection.host} onCopy={() => void copy(connection.host, '主机')} />
      <AccessRow label="端口" value={String(connection.port)} onCopy={() => void copy(String(connection.port), '端口')} />
      <AccessRow label="用户名" value={connection.username} onCopy={() => void copy(connection.username, '用户名')} />
      <AccessRow label="服务器指纹" value={connection.hostKeyFingerprint} onCopy={() => void copy(connection.hostKeyFingerprint, '服务器指纹')} />
      <AccessRow label="第 1 步 · 安装服务器身份凭证" value={knownHostsInstallCommand(connection)} onCopy={() => void copy(knownHostsInstallCommand(connection), '身份凭证安装命令')} />
      <AccessRow label="第 2 步 · 私钥保存路径" value={privateKeyPath(connection)} onCopy={() => void copy(privateKeyPath(connection), '私钥保存路径')} />
      <View style={styles.privateKeyBlock}>
        <View style={styles.privateKeyTop}><Text style={styles.accessLabel}>一次性 OpenSSH 私钥</Text><View style={styles.privateActions}>
          <Pressable onPress={() => setRevealPrivateKey((value) => !value)}><Text style={styles.privateActionText}>{revealPrivateKey ? '隐藏' : '显示'}</Text></Pressable>
          <Pressable onPress={() => void copy(connection.privateKey, '私钥')}><Text style={styles.privateActionText}>复制</Text></Pressable>
        </View></View>
        <Text selectable={revealPrivateKey} style={styles.privateKeyValue}>{revealPrivateKey ? connection.privateKey : '私钥已隐藏，点击“显示”仅查看本次内容'}</Text>
      </View>
      <AccessRow label="第 3 步 · 连接命令" value={sshCommand(connection)} onCopy={() => void copy(sshCommand(connection), '连接命令')} />
      <Text style={styles.ticketNote}>先安装服务器身份凭证，再执行连接命令。不要跳过主机校验。连接信息和私钥关闭或过期后会清除。</Text>
    </View> : null}

    {canEnter && !connection ? <Pressable disabled={busy} onPress={() => void enter()} style={[styles.primary, busy && styles.disabled]}>{busy ? <ActivityIndicator color={colors.surface} /> : <><Text style={styles.primaryText}>获取连接信息</Text><Ionicons name="key-outline" size={17} color={colors.surface} /></>}</Pressable> : null}
    {state?.actions.includes('stop_fulfillment') ? <Pressable disabled={busy} onPress={stop} style={[styles.secondary, busy && styles.disabled]}><Text style={styles.secondaryText}>停止本次算力</Text></Pressable> : null}
    {state?.actions.includes('accept_fulfillment') ? <Pressable disabled={busy} onPress={accept} style={[styles.primary, busy && styles.disabled]}><Text style={styles.primaryText}>确认用量并结算</Text></Pressable> : null}
    {state?.actions.includes('report_fulfillment_issue') ? <View style={styles.issueBox}>
      <Text style={styles.issueTitle}>用量或连接有问题？</Text>
      <View style={styles.issueChoices}>
        <IssueChoice active={issueKind === 'metering'} label="计量不符" onPress={() => setIssueKind('metering')} />
        <IssueChoice active={issueKind === 'access'} label="无法使用" onPress={() => setIssueKind('access')} />
      </View>
      <TextInput value={issueDescription} onChangeText={setIssueDescription} multiline maxLength={2_000}
        placeholder="写清发生时间、实际情况和你核对过的内容（至少 10 个字）" placeholderTextColor={colors.subtle}
        style={styles.issueInput} />
      <Pressable disabled={busy || issueDescription.trim().length < 10} onPress={() => void reportIssue()}
        style={[styles.secondary, (busy || issueDescription.trim().length < 10) && styles.disabled]}><Text style={styles.secondaryText}>提交问题，暂缓结算</Text></Pressable>
      <Text style={styles.issueNote}>提交后不会自动退款。平台完成核对前，本单卡时保持冻结。</Text>
    </View> : null}
    {order.side === 'provider' && state?.actions.includes('provision_fulfillment') ? <Pressable disabled={busy} onPress={() => void provision()} style={[styles.secondary, busy && styles.disabled]}><Text style={styles.secondaryText}>重新发起开通</Text></Pressable> : null}
  </View>;
}

function AccessRow({ label, value, onCopy, secret = false }: Readonly<{ label: string; value: string; onCopy: () => void; secret?: boolean }>) {
  return <View style={styles.accessRow}><View style={styles.accessCopy}><Text style={styles.accessLabel}>{label}</Text><Text selectable numberOfLines={secret ? 2 : 3} style={styles.accessValue}>{secret ? `•••• ${value.slice(-4)}` : value}</Text></View><Pressable onPress={onCopy} accessibilityRole="button" accessibilityLabel={`复制${label}`} style={styles.copyButton}><Ionicons name="copy-outline" size={17} color={colors.primary} /></Pressable></View>;
}

function IssueChoice({ active, label, onPress }: Readonly<{ active: boolean; label: string; onPress: () => void }>) {
  return <Pressable onPress={onPress} style={[styles.issueChoice, active && styles.issueChoiceActive]}><Ionicons name={active ? 'radio-button-on' : 'radio-button-off'} size={16} color={active ? colors.primary : colors.subtle} /><Text style={[styles.issueChoiceText, active && styles.issueChoiceTextActive]}>{label}</Text></Pressable>;
}

function formatTime(value: string) { const date = new Date(value); return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }

const styles = StyleSheet.create({
  card: { padding: 17, marginTop: 15, borderWidth: 1, borderColor: colors.line, borderRadius: 22, backgroundColor: colors.surface },
  waiting: { borderColor: '#E6D7A9', backgroundColor: '#FFFCF2' }, success: { borderColor: '#B8DEC2', backgroundColor: '#F6FCF7' }, danger: { borderColor: '#ECC0BD', backgroundColor: '#FFF8F7' }, muted: { backgroundColor: colors.canvas },
  top: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }, heading: { flex: 1 }, eyebrow: { color: colors.primary, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 }, title: { color: colors.ink, fontSize: 17, lineHeight: 23, fontWeight: '900', marginTop: 4 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.surface }, statusText: { color: colors.ink, fontSize: 9, fontWeight: '900' }, description: { color: colors.muted, fontSize: 11, lineHeight: 18, marginTop: 9 },
  connection: { padding: 12, marginTop: 13, borderWidth: 1, borderColor: '#D5E5FA', borderRadius: 14, backgroundColor: colors.primarySoft }, connectionName: { color: colors.primaryDark, fontSize: 12, fontWeight: '900' }, connectionMeta: { color: colors.muted, fontSize: 9, marginTop: 5 },
  lease: { marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 5 }, leaseText: { color: colors.amber, fontSize: 9, fontWeight: '800' },
  usage: { padding: 12, marginTop: 12, flexDirection: 'row', flexWrap: 'wrap', borderRadius: 14, backgroundColor: colors.surface }, usageRight: { marginLeft: 34 }, usageLabel: { color: colors.muted, fontSize: 9 }, usageValue: { color: colors.primaryDark, fontSize: 20, fontWeight: '900', marginTop: 3 }, measured: { width: '100%', color: colors.subtle, fontSize: 8, marginTop: 8 }, meterPending: { color: colors.muted, fontSize: 9, lineHeight: 15, marginTop: 10 },
  acceptance: { padding: 13, marginTop: 12, borderWidth: 1, borderColor: '#E6D7A9', borderRadius: 15, backgroundColor: '#FFFCF2' }, acceptanceSuccess: { borderColor: '#B8DEC2', backgroundColor: '#F6FCF7' }, acceptanceTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, acceptanceTitle: { flex: 1, color: colors.ink, fontSize: 12, fontWeight: '900' }, acceptanceDeadline: { color: colors.amber, fontSize: 8, fontWeight: '900' }, acceptanceText: { color: colors.muted, fontSize: 9, lineHeight: 16, marginTop: 7 },
  failure: { color: colors.red, fontSize: 10, lineHeight: 17, marginTop: 11 }, notice: { color: colors.greenDark, fontSize: 10, lineHeight: 16, marginTop: 11 }, errorRow: { marginTop: 11, flexDirection: 'row', alignItems: 'flex-start', gap: 8 }, error: { flex: 1, color: colors.red, fontSize: 10, lineHeight: 16 }, retry: { color: colors.primary, fontSize: 10, fontWeight: '900' },
  ticket: { padding: 13, marginTop: 13, borderRadius: 16, backgroundColor: '#0B2345' }, ticketTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, ticketTitle: { color: colors.surface, fontSize: 13, fontWeight: '900' }, expiry: { color: '#A9CFFF', fontSize: 9, fontWeight: '800' }, accessRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingTop: 11, marginTop: 10, borderTopWidth: 1, borderTopColor: '#274A78' }, accessCopy: { flex: 1 }, accessLabel: { color: '#A9CFFF', fontSize: 8 }, accessValue: { color: colors.surface, fontSize: 11, lineHeight: 17, marginTop: 3 }, copyButton: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E8F2FF' }, ticketNote: { color: '#A9CFFF', fontSize: 8, lineHeight: 14, marginTop: 10 }, privateKeyBlock: { paddingTop: 11, marginTop: 10, borderTopWidth: 1, borderTopColor: '#274A78' }, privateKeyTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, privateActions: { flexDirection: 'row', gap: 14 }, privateActionText: { color: '#A9CFFF', fontSize: 10, fontWeight: '900' }, privateKeyValue: { color: colors.surface, fontSize: 9, lineHeight: 14, marginTop: 8 },
  primary: { minHeight: 50, marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 16, backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 13, fontWeight: '900' }, secondary: { minHeight: 47, marginTop: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.primary, borderRadius: 15, backgroundColor: colors.surface }, secondaryText: { color: colors.primary, fontSize: 12, fontWeight: '900' }, disabled: { opacity: 0.48 },
  issueBox: { paddingTop: 13, marginTop: 13, borderTopWidth: 1, borderTopColor: colors.line }, issueTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' }, issueChoices: { flexDirection: 'row', gap: 8, marginTop: 10 }, issueChoice: { flex: 1, minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderWidth: 1, borderColor: colors.line, borderRadius: 13, backgroundColor: colors.surface }, issueChoiceActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft }, issueChoiceText: { color: colors.muted, fontSize: 10, fontWeight: '800' }, issueChoiceTextActive: { color: colors.primaryDark }, issueInput: { minHeight: 86, marginTop: 10, padding: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 14, color: colors.ink, backgroundColor: colors.surface, textAlignVertical: 'top' }, issueNote: { color: colors.muted, fontSize: 8, lineHeight: 14, marginTop: 8 },
});
