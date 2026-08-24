import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Constants from 'expo-constants';
import { ApiError } from './api-client';
import { loadStagingSupplierDrafts } from './staging-supplier-drafts-api';
import {
  createStagingSshPublicKey, loadStagingSshPublicKeys, renameStagingSshPublicKey, revokeStagingSshPublicKey,
  type StagingSshPublicKey,
} from './staging-manual-delivery-api';
import { replayStagingProfileMutation, type StagingProfileMutation } from './staging-profile-mutation-recovery-core';
import { clearConfirmedStagingProfileMutation, loadPendingStagingProfileMutation,
  savePendingStagingProfileMutation } from './staging-profile-mutation-recovery';
import { checkSshPublicKey } from './staging-ssh-public-key';
import { StagingSupplierDraftsSheet } from './StagingSupplierDraftsSheet';
import { assertNoPendingStagingMutationBeforePrincipalChange } from './staging-pending-guard';
import { clearStagingPrincipalToken, loadStagingPrincipalFingerprint, loadStagingPrincipalToken,
  saveStagingPrincipalToken } from './staging-principal';
import { colors } from './theme';
import type { StagingProfileEntry } from './StagingProfileToolsSlot';

async function digest(value: object) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(value));
}

async function executeKeyMutation(pending: StagingProfileMutation) {
  const payload = pending.payload;
  if (pending.operation === 'create_ssh_key') {
    if (typeof payload.clientKeyId !== 'string' || typeof payload.label !== 'string'
      || typeof payload.publicKey !== 'string' || payload.ownershipAttested !== true) throw new Error('待确认公钥资料格式异常。');
    return createStagingSshPublicKey({ clientKeyId: payload.clientKeyId, label: payload.label,
      publicKey: payload.publicKey, ownershipAttested: true }, pending.idempotencyKey);
  }
  if (pending.operation === 'rename_ssh_key') {
    if (typeof payload.id !== 'string' || !Number.isInteger(payload.expectedVersion) || typeof payload.label !== 'string') {
      throw new Error('待确认公钥名称资料格式异常。');
    }
    return renameStagingSshPublicKey(payload.id, Number(payload.expectedVersion), payload.label, pending.idempotencyKey);
  }
  if (pending.operation === 'revoke_ssh_key') {
    if (typeof payload.id !== 'string' || !Number.isInteger(payload.expectedVersion)) throw new Error('待确认停用资料格式异常。');
    return revokeStagingSshPublicKey(payload.id, Number(payload.expectedVersion), pending.idempotencyKey);
  }
  throw new Error('待确认操作不属于公钥管理。');
}

export function useStagingProfileToolsSlot(): Readonly<{
  draftEntry: StagingProfileEntry | null; sshEntry: StagingProfileEntry | null;
  connectionEntry: StagingProfileEntry | null; sheets: React.ReactNode;
}> {
  const [draftCount, setDraftCount] = useState<number | null>(null);
  const [keys, setKeys] = useState<StagingSshPublicKey[] | null>(null);
  const [sshVisible, setSshVisible] = useState(false);
  const [draftVisible, setDraftVisible] = useState(false);
  const [connectionVisible, setConnectionVisible] = useState(false);
  const [connected, setConnected] = useState(false);

  const probe = useCallback(async () => {
    const principal = await loadStagingPrincipalToken();
    setConnected(Boolean(principal));
    if (!principal) { setDraftCount(null); setKeys(null); return; }
    const [drafts, nextKeys] = await Promise.allSettled([loadStagingSupplierDrafts(), loadStagingSshPublicKeys()]);
    setDraftCount(drafts.status === 'fulfilled' ? drafts.value.length : null);
    setKeys(nextKeys.status === 'fulfilled' ? nextKeys.value : null);
  }, []);
  useEffect(() => { void probe(); }, [probe]);

  const refreshKeys = useCallback(async () => {
    setKeys(await loadStagingSshPublicKeys());
  }, []);

  const draftEntry = useMemo(() => draftCount === null ? null : ({ count: draftCount,
    label: '测试资源草稿', meta: '资料保存在测试服务器，尚未进入市场', onPress: () => setDraftVisible(true) }), [draftCount]);
  const sshEntry = useMemo(() => keys === null ? null : ({ count: keys.length, label: 'SSH 公钥',
    meta: `只保存公钥指纹与状态 · ${keys.filter((item) => item.status === 'active').length} 个可用`,
    onPress: () => setSshVisible(true) }), [keys]);
  const connectionEntry = useMemo(() => ({ label: '连接测试账号', meta: connected ? '已连接 · 可断开或更换测试身份' : '未连接 · 凭证只保存在本机安全存储',
    onPress: () => setConnectionVisible(true) }), [connected]);
  return { draftEntry, sshEntry, connectionEntry, sheets: <><StagingPrincipalSheet connected={connected}
    visible={connectionVisible} onClose={() => setConnectionVisible(false)} onChanged={probe} />
    <StagingSupplierDraftsSheet visible={draftVisible}
    onClose={() => setDraftVisible(false)} onChanged={(items) => setDraftCount(items.length)} />
    <SshKeysSheet keys={keys ?? []} onChanged={refreshKeys}
      onClose={() => setSshVisible(false)} visible={sshVisible} /></> };
}

async function verifyStagingPrincipal(candidate: string) {
  const baseUrl = String(Constants.expoConfig?.extra?.cloudPayBaseUrl ?? '').replace(/\/+$/u, '');
  if (!/^http:\/\/10\.0\.2\.2:4187$/u.test(baseUrl)) throw new Error('测试服务地址不符合隔离要求。');
  const response = await fetch(`${baseUrl}/mobile/v1/staging/balance`, { method: 'GET', headers: {
    Accept: 'application/json', 'X-Zod-Client-Environment': 'staging', 'x-kai-e2e-session': candidate,
  } });
  let payload: unknown; try { payload = await response.json(); } catch { throw new Error('测试服务返回异常。'); }
  const envelope = payload as { environment?: unknown; simulation?: unknown } | null;
  if (!response.ok || response.headers.get('X-Zod-Environment') !== 'staging'
    || envelope?.environment !== 'staging' || envelope.simulation !== true) throw new Error('测试账号无法验证，请检查后重试。');
}

function StagingPrincipalSheet({ connected, visible, onClose, onChanged }: Readonly<{
  connected: boolean; visible: boolean; onClose: () => void; onChanged: () => Promise<void>;
}>) {
  const [candidate, setCandidate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clearInput = useCallback(() => { setCandidate(''); setError(null); }, []);
  useEffect(() => () => clearInput(), [clearInput]);
  const close = () => { clearInput(); onClose(); };
  const connect = async () => {
    const value = candidate.trim();
    if (!/^[A-Za-z0-9._~-]{43,200}$/u.test(value)) { setError('测试账号凭证格式不正确。'); return; }
    setBusy(true); setError(null);
    try {
      await assertNoPendingStagingMutationBeforePrincipalChange();
      await verifyStagingPrincipal(value);
      await assertNoPendingStagingMutationBeforePrincipalChange();
      await saveStagingPrincipalToken(value); clearInput(); await onChanged(); onClose();
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : '测试账号无法验证，请检查网络或凭证后重试。'); }
    finally { setBusy(false); }
  };
  const disconnect = async () => {
    setBusy(true); setError(null);
    try {
      await assertNoPendingStagingMutationBeforePrincipalChange();
      await clearStagingPrincipalToken(); clearInput(); await onChanged(); onClose();
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : '暂时无法断开测试账号，请重试。'); }
    finally { setBusy(false); }
  };
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={close}><View style={styles.centerBackdrop}>
    <View style={styles.connectionCard}><View style={styles.head}><View><Text style={styles.title}>连接测试账号</Text>
      <Text style={styles.subtitle}>凭证只保存到本机系统安全存储。</Text></View><Pressable onPress={close}><Ionicons name="close" size={22} color={colors.ink} /></Pressable></View>
      <TextInput value={candidate} onChangeText={setCandidate} secureTextEntry autoCapitalize="none" autoCorrect={false}
        autoComplete="off" maxLength={200} placeholder="输入测试账号凭证" placeholderTextColor={colors.subtle} style={styles.input} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}><Pressable disabled={busy} onPress={close} style={styles.secondary}><Text style={styles.secondaryText}>取消</Text></Pressable>
        <Pressable disabled={busy || !candidate.trim()} onPress={() => void connect()} style={[styles.primary, !candidate.trim() && styles.disabled]}>
          {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>连接</Text>}</Pressable></View>
      {connected ? <Pressable disabled={busy} onPress={() => void disconnect()} style={styles.disconnect}><Text style={styles.dangerText}>断开测试账号</Text></Pressable> : null}
    </View></View></Modal>;
}

function SshKeysSheet({ keys, onChanged, onClose, visible }: Readonly<{
  keys: StagingSshPublicKey[]; onChanged: () => Promise<void>; onClose: () => void; visible: boolean;
}>) {
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [ownership, setOwnership] = useState(false);
  const [renaming, setRenaming] = useState<StagingSshPublicKey | null>(null);
  const [renameLabel, setRenameLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyCheck = useMemo(() => checkSshPublicKey(publicKey), [publicKey]);

  const recover = useCallback(async () => {
    const pending = await loadPendingStagingProfileMutation();
    if (!pending || pending.operation === 'submit_manual_delivery') return;
    try {
      await replayStagingProfileMutation(pending, await loadStagingPrincipalFingerprint(), executeKeyMutation,
        clearConfirmedStagingProfileMutation);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        await clearConfirmedStagingProfileMutation(pending.idempotencyKey);
      } else throw reason;
    }
    await onChanged();
  }, [onChanged]);
  useEffect(() => { if (visible) void recover().catch((reason) => setError(reason instanceof Error ? reason.message : '安全操作尚未确认。')); }, [recover, visible]);

  const run = async (operation: StagingProfileMutation['operation'], payload: Readonly<Record<string, unknown>>) => {
    const signature = await digest({ operation, payload });
    const existing = await loadPendingStagingProfileMutation();
    if (existing && existing.signature !== signature) throw new Error('上一项安全操作结果仍待确认，不能覆盖。');
    const pending = existing ?? await savePendingStagingProfileMutation({ operation, payload, signature,
      idempotencyKey: `staging-profile:${Crypto.randomUUID()}` });
    try {
      await replayStagingProfileMutation(pending, await loadStagingPrincipalFingerprint(), executeKeyMutation,
        clearConfirmedStagingProfileMutation);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        await clearConfirmedStagingProfileMutation(pending.idempotencyKey);
        throw new Error('服务端已拒绝过期版本的安全操作，请按最新资料重新提交。');
      }
      throw reason;
    }
  };

  const create = async () => {
    const normalizedLabel = label.trim();
    if (normalizedLabel.length < 1 || normalizedLabel.length > 80 || !keyCheck.valid || !ownership) return;
    setBusy(true); setError(null);
    try {
      await run('create_ssh_key', { clientKeyId: Crypto.randomUUID(), label: normalizedLabel,
        publicKey: publicKey.trim(), ownershipAttested: true });
      setCreating(false); setLabel(''); setPublicKey(''); setOwnership(false); await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '公钥保存结果尚未确认，请联网重试。'); }
    finally { setBusy(false); }
  };

  const rename = async () => {
    if (!renaming || renameLabel.trim().length < 1 || renameLabel.trim().length > 80) return;
    setBusy(true); setError(null);
    try { await run('rename_ssh_key', { id: renaming.id, expectedVersion: renaming.version,
      label: renameLabel.trim() }); setRenaming(null); await onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '名称保存结果尚未确认。'); }
    finally { setBusy(false); }
  };

  const revoke = (key: StagingSshPublicKey) => Alert.alert('停用这个公钥？', '停用后不能用于新的人工履约；已经关联的记录会保留。', [
    { text: '取消', style: 'cancel' }, { text: '停用', style: 'destructive', onPress: () => void (async () => {
      setBusy(true); setError(null);
      try { await run('revoke_ssh_key', { id: key.id, expectedVersion: key.version }); await onChanged(); }
      catch (reason) { setError(reason instanceof Error ? reason.message : '公钥暂时无法停用。'); }
      finally { setBusy(false); }
    })() },
  ]);

  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><View style={styles.backdrop}>
    <View style={styles.sheet}><View style={styles.handle} /><View style={styles.head}><View><Text style={styles.title}>SSH 公钥</Text>
      <Text style={styles.subtitle}>只粘贴公钥，绝不要提交私钥。</Text></View><Pressable onPress={onClose}><Ionicons name="close" size={22} color={colors.ink} /></Pressable></View>
      <View style={styles.warning}><Ionicons name="warning-outline" size={19} color={colors.amber} /><Text style={styles.warningText}>禁止填写私钥、密码、token、服务器 IP 或端口。服务端不会回传完整公钥。</Text></View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {creating ? <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
        <Field label="公钥名称"><TextInput value={label} onChangeText={setLabel} maxLength={80} placeholder="例如：工作电脑"
          placeholderTextColor={colors.subtle} style={styles.input} /></Field>
        <Field label="OpenSSH 公钥"><TextInput value={publicKey} onChangeText={setPublicKey} multiline autoCapitalize="none"
          autoCorrect={false} placeholder="粘贴以 ssh-ed25519 等算法开头的公钥" placeholderTextColor={colors.subtle}
          style={[styles.input, styles.keyInput]} /></Field>
        {publicKey.trim() ? <Text style={keyCheck.valid ? styles.hint : styles.error}>{keyCheck.error
          ?? `${keyCheck.algorithm} 格式可提交，最终以服务器校验为准。`}</Text> : null}
        {keyCheck.commentIgnored ? <Text style={styles.hint}>公钥末尾 comment 仅用于识别，不会保存。</Text> : null}
        <Pressable onPress={() => setOwnership((value) => !value)} style={styles.checkRow}><Ionicons
          name={ownership ? 'checkbox' : 'square-outline'} size={20} color={ownership ? colors.primary : colors.muted} />
          <Text style={styles.checkText}>这是我控制的公钥</Text></Pressable>
        <View style={styles.actions}><Pressable onPress={() => { setCreating(false); setPublicKey(''); }} style={styles.secondary}><Text style={styles.secondaryText}>返回</Text></Pressable>
          <Pressable disabled={busy || !ownership || !keyCheck.valid || !label.trim()} onPress={() => void create()}
            style={[styles.primary, (!ownership || !keyCheck.valid || !label.trim()) && styles.disabled]}>
            {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>保存到服务器</Text>}</Pressable></View>
      </ScrollView> : <ScrollView contentContainerStyle={styles.list}>{keys.map((key) => <View key={key.id} style={styles.keyCard}>
        <View style={styles.keyHead}><View style={styles.keyIcon}><Ionicons name="key-outline" size={18} color={colors.primary} /></View>
          <View style={styles.copy}><Text style={styles.keyLabel}>{key.label}</Text><Text style={styles.keyMeta}>{key.algorithm} · {key.status === 'active' ? '可用' : '已停用'}</Text></View>
          <Text style={key.status === 'active' ? styles.active : styles.revoked}>{key.status === 'active' ? 'ACTIVE' : 'REVOKED'}</Text></View>
        <Text selectable style={styles.fingerprint}>{key.fingerprint}</Text>
        <Text style={styles.lastUsed}>最近使用：{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString('zh-CN') : '尚未使用'}</Text>
        {key.status === 'active' ? <View style={styles.actions}><Pressable onPress={() => { setRenaming(key); setRenameLabel(key.label); }} style={styles.secondary}><Text style={styles.secondaryText}>改名</Text></Pressable>
          <Pressable onPress={() => revoke(key)} style={styles.secondary}><Text style={styles.dangerText}>停用</Text></Pressable></View> : null}
      </View>)}{!keys.length ? <Text style={styles.empty}>还没有保存公钥。</Text> : null}
        <Pressable onPress={() => setCreating(true)} style={styles.primary}><Text style={styles.primaryText}>新增 SSH 公钥</Text></Pressable>
      </ScrollView>}
      {renaming ? <Modal visible transparent animationType="fade" onRequestClose={() => setRenaming(null)}><View style={styles.centerBackdrop}><View style={styles.renameCard}>
        <Text style={styles.renameTitle}>修改公钥名称</Text><TextInput value={renameLabel} onChangeText={setRenameLabel} maxLength={80} style={styles.input} />
        <View style={styles.actions}><Pressable onPress={() => setRenaming(null)} style={styles.secondary}><Text style={styles.secondaryText}>取消</Text></Pressable>
          <Pressable disabled={busy || !renameLabel.trim()} onPress={() => void rename()} style={styles.primary}><Text style={styles.primaryText}>保存</Text></Pressable></View>
      </View></View></Modal> : null}
    </View></View></Modal>;
}

function Field({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text>{children}</View>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(17,24,39,0.30)' }, sheet: { height: '88%', borderTopLeftRadius: 18, borderTopRightRadius: 18, backgroundColor: '#F4F7FB', padding: 18, paddingBottom: 28 }, handle: { width: 38, height: 4, alignSelf: 'center', borderRadius: 2, backgroundColor: '#D0D5DD' }, head: { minHeight: 68, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, title: { color: colors.ink, fontSize: 20, fontWeight: '900' }, subtitle: { color: colors.amber, fontSize: 10, fontWeight: '800', marginTop: 5 },
  warning: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 12, backgroundColor: colors.amberSoft }, warningText: { flex: 1, color: colors.primaryDark, fontSize: 9, lineHeight: 14, marginLeft: 8 }, error: { color: colors.red, fontSize: 9, lineHeight: 14, marginTop: 8 }, hint: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 7 },
  list: { paddingTop: 12, paddingBottom: 24 }, keyCard: { padding: 14, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, marginBottom: 10 }, keyHead: { flexDirection: 'row', alignItems: 'center' }, keyIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }, copy: { flex: 1, marginLeft: 10 }, keyLabel: { color: colors.ink, fontSize: 12, fontWeight: '900' }, keyMeta: { color: colors.muted, fontSize: 8, marginTop: 4 }, active: { color: colors.green, fontSize: 8, fontWeight: '900' }, revoked: { color: colors.subtle, fontSize: 8, fontWeight: '900' }, fingerprint: { color: colors.ink, fontSize: 9, marginTop: 12 }, lastUsed: { color: colors.muted, fontSize: 8, marginTop: 6 }, empty: { color: colors.muted, fontSize: 11, textAlign: 'center', padding: 28 },
  form: { paddingTop: 12, paddingBottom: 20 }, field: { marginBottom: 13 }, fieldLabel: { color: colors.ink, fontSize: 10, fontWeight: '800', marginBottom: 7 }, input: { minHeight: 46, paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, color: colors.ink, fontSize: 11 }, keyInput: { minHeight: 112, paddingTop: 12, textAlignVertical: 'top' }, checkRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8 }, checkText: { color: colors.ink, fontSize: 10 }, actions: { flexDirection: 'row', gap: 9, marginTop: 10 }, primary: { flex: 1, minHeight: 45, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' }, secondary: { flex: 1, minHeight: 43, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, secondaryText: { color: colors.primary, fontSize: 10, fontWeight: '800' }, dangerText: { color: colors.red, fontSize: 10, fontWeight: '800' }, disabled: { opacity: 0.45 },
  centerBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: 'rgba(17,24,39,0.40)' }, renameCard: { width: '100%', padding: 18, borderRadius: 16, backgroundColor: colors.surface }, renameTitle: { color: colors.ink, fontSize: 16, fontWeight: '900', marginBottom: 12 }, connectionCard: { width: '100%', padding: 18, borderRadius: 16, backgroundColor: colors.surface }, disconnect: { minHeight: 42, marginTop: 8, alignItems: 'center', justifyContent: 'center' },
});
