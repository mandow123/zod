import { Ionicons } from '@expo/vector-icons';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError } from './api-client';
import { COMMON_TIME_ZONES } from './inquiry-form';
import {
  emptySupplierDraftForm, formatSupplierDateTime, supplierDraftPayload, supplierDraftToForm,
  systemTimeZone, validateSupplierDraftForm, type SupplierDraftForm,
} from './staging-supplier-draft-form';
import { replayPendingStagingSupplierDraft, type PendingStagingSupplierDraft } from './staging-supplier-draft-recovery-core';
import {
  clearConfirmedStagingSupplierDraft, loadPendingStagingSupplierDraft, savePendingStagingSupplierDraft,
} from './staging-supplier-draft-recovery';
import {
  createStagingSupplierDraft, loadStagingSupplierDraft, loadStagingSupplierDrafts,
  updateStagingSupplierDraft, type StagingSupplierDraft,
} from './staging-supplier-drafts-api';
import { loadStagingPrincipalFingerprint } from './staging-principal';
import { colors } from './theme';

type Group = 'basic' | 'capacity' | 'schedule' | 'pricing';
const regionChoices = [['CN-SH', '上海'], ['CN-BJ', '北京'], ['CN-GD', '广东'], ['CN-ZJ', '浙江'],
  ['CN-JS', '江苏'], ['CN-SC', '四川'], ['CN-OTHER', '其他']] as const;

async function fingerprint(value: unknown) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(value));
}

async function executePending(pending: PendingStagingSupplierDraft) {
  if (pending.operation === 'create') return createStagingSupplierDraft(pending.payload, pending.idempotencyKey);
  if (!pending.draftId || pending.expectedVersion === null) throw new Error('待确认草稿版本缺失。');
  const { clientDraftId: _clientDraftId, ...patch } = pending.payload;
  return updateStagingSupplierDraft(pending.draftId, pending.expectedVersion, patch, pending.idempotencyKey);
}

export function StagingSupplierDraftsSheet({ visible, onClose, onChanged }: Readonly<{
  visible: boolean; onClose: () => void; onChanged: (items: StagingSupplierDraft[]) => void;
}>) {
  const [items, setItems] = useState<StagingSupplierDraft[]>([]);
  const [editing, setEditing] = useState<StagingSupplierDraft | null | 'new'>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const pending = await loadPendingStagingSupplierDraft();
      if (pending) {
        try {
          await replayPendingStagingSupplierDraft(pending, await loadStagingPrincipalFingerprint(),
            executePending, clearConfirmedStagingSupplierDraft);
        } catch (reason) {
          if (reason instanceof ApiError && reason.code === 'VERSION_CONFLICT') {
            await clearConfirmedStagingSupplierDraft(pending.idempotencyKey);
          } else throw reason;
        }
      }
      const next = await loadStagingSupplierDrafts(); setItems(next); onChanged(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '草稿暂时无法读取。'); }
    finally { setLoading(false); }
  }, [onChanged]);
  useEffect(() => { if (visible) void refresh(); }, [refresh, visible]);

  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><View style={styles.backdrop}>
    <View style={styles.sheet}><View style={styles.handle} /><View style={styles.header}><View><Text style={styles.title}>测试资源草稿</Text>
      <Text style={styles.subtitle}>私有资料保存在测试服务器，尚未进入市场。</Text></View>
      <Pressable accessibilityLabel="关闭测试资源草稿" onPress={onClose}><Ionicons name="close" size={22} color={colors.ink} /></Pressable></View>
      {error ? <InlineError text={error} action="重新加载" onPress={() => void refresh()} /> : null}
      {loading ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.muted}>正在读取服务器草稿…</Text></View>
        : <ScrollView contentContainerStyle={styles.list}>{items.map((item) => <Pressable key={item.id}
          disabled={!item.allowedActions.includes('edit')} onPress={() => setEditing(item)} style={styles.draftRow}>
          <View style={styles.rowCopy}><Text style={styles.rowTitle}>{item.resource.name ?? '未命名草稿'}</Text>
            <Text style={styles.rowMeta}>{item.resource.gpuModel ?? 'GPU 型号待填'} · {item.resource.gpuCardType ?? '卡型待填'} · {item.resource.regionCode ?? '地区待填'}</Text>
            <Text style={styles.rowMeta}>{item.completeness.complete ? '资料已填齐' : `还缺 ${item.completeness.missingFields.length} 项`} · 版本 {item.version} · {new Date(item.updatedAt).toLocaleString('zh-CN')}</Text></View>
          <Ionicons name="chevron-forward" size={17} color={colors.subtle} /></Pressable>)}
          {!items.length ? <Text style={styles.empty}>还没有测试资源草稿。</Text> : null}
          <Pressable style={styles.primary} onPress={() => setEditing('new')}><Ionicons name="add" size={18} color="#FFFFFF" /><Text style={styles.primaryText}>新建测试资源</Text></Pressable>
        </ScrollView>}
      {editing ? <SupplierDraftEditor draft={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
        onSaved={async () => {
          const next = await loadStagingSupplierDrafts();
          setItems(next);
          onChanged(next);
        }} /> : null}
    </View></View></Modal>;
}

function SupplierDraftEditor({ draft, onClose, onSaved }: Readonly<{
  draft: StagingSupplierDraft | null; onClose: () => void; onSaved: (saved: StagingSupplierDraft) => Promise<void>;
}>) {
  const initial = useMemo(() => draft ? supplierDraftToForm(draft)
    : emptySupplierDraftForm(Crypto.randomUUID(), systemTimeZone()), [draft]);
  const [serverDraft, setServerDraft] = useState(draft);
  const [baseline, setBaseline] = useState(initial);
  const [form, setForm] = useState(initial);
  const [opened, setOpened] = useState<Set<Group>>(new Set(['basic']));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const errors = useMemo(() => validateSupplierDraftForm(form), [form]);
  const update = <K extends keyof SupplierDraftForm>(key: K, value: SupplierDraftForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const close = () => dirty ? Alert.alert('放弃未保存内容？', '只有点“保存到服务器”后资料才会保留。', [
    { text: '继续填写', style: 'cancel' }, { text: '放弃', style: 'destructive', onPress: onClose },
  ]) : onClose();

  const save = async () => {
    if (Object.keys(errors).length) {
      const group = errorGroup(Object.keys(errors)[0]!); setOpened((value) => new Set([...value, group]));
      setError('请先修改标出的字段。'); return;
    }
    const payload = supplierDraftPayload(form);
    const operation = serverDraft ? 'update' : 'create';
    const signature = await fingerprint({ operation, draftId: serverDraft?.id ?? null, expectedVersion: serverDraft?.version ?? null, payload });
    let submittedPending: PendingStagingSupplierDraft | null = null;
    setBusy(true); setError(null); setNotice(null);
    try {
      const existing = await loadPendingStagingSupplierDraft();
      const input = { operation, clientDraftId: payload.clientDraftId,
        draftId: serverDraft?.id ?? null, expectedVersion: serverDraft?.version ?? null, payload, signature,
        idempotencyKey: `staging-supplier-draft:${Crypto.randomUUID()}` } as const;
      if (existing && existing.signature !== signature) throw new Error('上一份草稿保存结果仍待确认，不能覆盖。');
      const pending = existing ?? await savePendingStagingSupplierDraft(input);
      submittedPending = pending;
      const saved = await replayPendingStagingSupplierDraft(pending, await loadStagingPrincipalFingerprint(),
        executePending, clearConfirmedStagingSupplierDraft);
      const savedForm = supplierDraftToForm(saved);
      setServerDraft(saved);
      setForm(savedForm);
      setBaseline(savedForm);
      setNotice(`已保存 · 版本 ${saved.version}`);
      await onSaved(saved);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'VERSION_CONFLICT') {
        if (submittedPending) {
          try { await clearConfirmedStagingSupplierDraft(submittedPending.idempotencyKey); }
          catch (cleanupReason) {
            setError(cleanupReason instanceof Error ? cleanupReason.message : '待确认草稿无法安全清理。');
            return;
          }
        }
        setError('服务器已有新版本。请重新加载服务器版本后再修改。');
      } else setError(reason instanceof Error ? reason.message : '保存结果尚未确认，请联网重试。');
    } finally { setBusy(false); }
  };

  return <Modal visible transparent animationType="slide" onRequestClose={close}><View style={styles.backdrop}><View style={styles.editor}>
    <View style={styles.handle} /><View style={styles.header}><View><Text style={styles.title}>{serverDraft ? '编辑私有草稿' : '新建私有草稿'}</Text>
      <Text style={styles.subtitle}>可先保存不完整资料；缺项以服务器返回为准。</Text></View><Pressable onPress={close}><Ionicons name="close" size={22} color={colors.ink} /></Pressable></View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
      <Section title="基础资源" open={opened.has('basic')} onToggle={() => toggleGroup(opened, setOpened, 'basic')}>
        <Input label="资源名称" value={form.name} onChangeText={(v) => update('name', v)} error={errors.name} />
        <Input label="GPU 型号" value={form.gpuModel} onChangeText={(v) => update('gpuModel', v)} error={errors.gpuModel} />
        <Choice label="卡型" value={form.gpuCardType} choices={[['SXM', 'SXM'], ['PCIe', 'PCIe'], ['other', '其他']]} onChange={(v) => update('gpuCardType', v)} />
        <Input label="GPU 数量" value={form.gpuCount} keyboardType="number-pad" onChangeText={(v) => update('gpuCount', v)} error={errors.gpuCount} />
        <Input label="单卡显存（GB）" value={form.gpuMemoryGb} keyboardType="number-pad" onChangeText={(v) => update('gpuMemoryGb', v)} error={errors.gpuMemoryGb} />
        <Choice label="宽地区" value={form.regionCode} choices={regionChoices} onChange={(v) => update('regionCode', v)} />
        <Input label="城市（可选）" value={form.city} onChangeText={(v) => update('city', v)} error={errors.city} />
      </Section>
      <Section title="设备能力" open={opened.has('capacity')} onToggle={() => toggleGroup(opened, setOpened, 'capacity')}>
        <Choice label="机器形态（可选）" value={form.machineType} choices={[['bare_metal', '裸金属'], ['virtualized', '虚拟化']]} onChange={(v) => update('machineType', v)} />
        <Input label="CPU 型号（可选）" value={form.cpuModel} onChangeText={(v) => update('cpuModel', v)} error={errors.cpuModel} />
        <Two><Input label="CPU 核数" value={form.cpuCores} keyboardType="number-pad" onChangeText={(v) => update('cpuCores', v)} error={errors.cpuCores} />
          <Input label="内存 GB" value={form.memoryGb} keyboardType="number-pad" onChangeText={(v) => update('memoryGb', v)} error={errors.memoryGb} /></Two>
        <Two><Input label="存储 GB" value={form.storageGb} keyboardType="number-pad" onChangeText={(v) => update('storageGb', v)} error={errors.storageGb} />
          <Input label="网络 Mbps" value={form.networkMbps} keyboardType="number-pad" onChangeText={(v) => update('networkMbps', v)} error={errors.networkMbps} /></Two>
        <Choice label="操作系统（可选）" value={form.operatingSystem} choices={[['ubuntu_22_04', 'Ubuntu 22.04'], ['ubuntu_24_04', 'Ubuntu 24.04'], ['other', '其他']]} onChange={(v) => update('operatingSystem', v)} />
        <Input label="容量（GPU 时）" value={form.capacityGpuHours} keyboardType="decimal-pad" onChangeText={(v) => update('capacityGpuHours', v)} error={errors.capacityGpuHours} />
      </Section>
      <Section title="可用安排" open={opened.has('schedule')} onToggle={() => toggleGroup(opened, setOpened, 'schedule')}>
        <Choice label="安排方式" value={form.deliveryMode} choices={[['scheduled_window', '可用时间段'], ['preparation_lead_time', '准备周期']]} onChange={(v) => update('deliveryMode', v)} />
        {form.deliveryMode === 'scheduled_window' ? <><DateField label="开始时间" value={form.startsAt} timezone={form.timezone} onChange={(v) => update('startsAt', v)} />
          <DateField label="结束时间" value={form.endsAt} timezone={form.timezone} onChange={(v) => update('endsAt', v)} />
          <Choice label="时区" value={form.timezone} choices={COMMON_TIME_ZONES} onChange={(v) => update('timezone', v)} />
          {errors.endsAt ? <Text style={styles.fieldError}>{errors.endsAt}</Text> : null}</>
          : form.deliveryMode === 'preparation_lead_time' ? <Input label="准备小时" value={form.leadTimeHours} keyboardType="number-pad" onChangeText={(v) => update('leadTimeHours', v)} error={errors.leadTimeHours} />
            : <Text style={styles.muted}>请选择可用时间段或准备周期。</Text>}
      </Section>
      <Section title="拟定卡时与确认" open={opened.has('pricing')} onToggle={() => toggleGroup(opened, setOpened, 'pricing')}>
        <Input label="拟定卡时 / GPU 时" value={form.priceAmount} keyboardType="decimal-pad" onChangeText={(v) => update('priceAmount', v)} error={errors.priceAmount} />
        <Input label="履约说明（可选）" value={form.fulfillmentNotes} multiline onChangeText={(v) => update('fulfillmentNotes', v)} error={errors.fulfillmentNotes} />
        <Text style={styles.warningText}>禁止填写密码、密钥、token、SSH 连接资料、IP/端口、个人证件、银行卡、手机号或精确机房地址。</Text>
        <Check value={form.ownershipConfirmed} label="我确认有权提供这项资源" onChange={(v) => update('ownershipConfirmed', v)} />
        <Check value={form.remoteAccessSafetyAcknowledged} label="我已了解远程访问安全要求" onChange={(v) => update('remoteAccessSafetyAcknowledged', v)} />
      </Section>
      {error ? <InlineError text={error} action={error.includes('服务器已有新版本') ? '重新加载服务器版本' : undefined}
        onPress={serverDraft ? () => void loadStagingSupplierDraft(serverDraft.id).then((next) => {
          const nextForm = supplierDraftToForm(next);
          setServerDraft(next);
          setForm(nextForm);
          setBaseline(nextForm);
          setNotice(null);
          setError(null);
        }) : undefined} /> : null}
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      <View style={styles.saveSpace} />
    </ScrollView>
    <View style={styles.footer}><Pressable disabled={busy} onPress={() => void save()} style={[styles.primary, busy && styles.disabled]}>
      {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>保存到服务器</Text>}</Pressable></View>
  </View></View></Modal>;
}

function toggleGroup(value: Set<Group>, set: (next: Set<Group>) => void, group: Group) {
  const next = new Set(value); if (next.has(group)) next.delete(group); else next.add(group); set(next);
}
function errorGroup(field: string): Group {
  if (['name', 'gpuModel', 'gpuCardType', 'gpuCount', 'gpuMemoryGb', 'regionCode', 'city'].includes(field)) return 'basic';
  if (['machineType', 'cpuModel', 'cpuCores', 'memoryGb', 'storageGb', 'networkMbps', 'operatingSystem', 'capacityGpuHours'].includes(field)) return 'capacity';
  if (['startsAt', 'endsAt', 'timezone', 'leadTimeHours'].includes(field)) return 'schedule'; return 'pricing';
}
function Section({ title, open, onToggle, children }: Readonly<{ title: string; open: boolean; onToggle: () => void; children: React.ReactNode }>) {
  return <View style={styles.section}><Pressable onPress={onToggle} style={styles.sectionHead}><Text style={styles.sectionTitle}>{title}</Text><Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.muted} /></Pressable>{open ? <View style={styles.sectionBody}>{children}</View> : null}</View>;
}
function Input({ label, error, ...props }: React.ComponentProps<typeof TextInput> & Readonly<{ label: string; error?: string }>) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><TextInput {...props} placeholderTextColor={colors.subtle} style={[styles.input, props.multiline && styles.multiline, error && styles.inputError]} />{error ? <Text style={styles.fieldError}>{error}</Text> : null}</View>;
}
function Choice<T extends string>({ label, value, choices, onChange }: Readonly<{ label: string; value: string; choices: readonly (readonly [T, string])[]; onChange: (value: T) => void }>) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><View style={styles.chips}>{choices.map(([key, text]) => <Pressable key={key} onPress={() => onChange(key)} style={[styles.chip, value === key && styles.chipActive]}><Text style={[styles.chipText, value === key && styles.chipTextActive]}>{text}</Text></Pressable>)}</View></View>;
}
function DateField({ label, value, timezone, onChange }: Readonly<{ label: string; value: string; timezone: string; onChange: (value: string) => void }>) {
  const open = (mode: 'date' | 'time') => DateTimePickerAndroid.open({ value: new Date(value), mode, is24Hour: true,
    timeZoneName: timezone, onValueChange: (_event, next) => onChange(next.toISOString()) });
  const display = formatSupplierDateTime(value, timezone);
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><View style={styles.dateRow}><Pressable style={styles.dateButton} onPress={() => open('date')}><Ionicons name="calendar-outline" size={16} color={colors.primary} /><Text style={styles.dateText}>{display.split(' ')[0]}</Text></Pressable><Pressable style={styles.dateButton} onPress={() => open('time')}><Ionicons name="time-outline" size={16} color={colors.primary} /><Text style={styles.dateText}>{display.split(' ')[1] ?? '--:--'}</Text></Pressable></View></View>;
}
function Check({ value, label, onChange }: Readonly<{ value: boolean; label: string; onChange: (value: boolean) => void }>) {
  return <Pressable style={styles.check} onPress={() => onChange(!value)}><Ionicons name={value ? 'checkbox' : 'square-outline'} size={20} color={value ? colors.primary : colors.muted} /><Text style={styles.checkText}>{label}</Text></Pressable>;
}
function Two({ children }: Readonly<{ children: React.ReactNode }>) { return <View style={styles.two}>{children}</View>; }
function InlineError({ text, action, onPress }: Readonly<{ text: string; action?: string; onPress?: () => void }>) { return <View style={styles.errorBox}><Text style={styles.errorText}>{text}</Text>{action && onPress ? <Pressable onPress={onPress}><Text style={styles.errorAction}>{action}</Text></Pressable> : null}</View>; }

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(17,24,39,0.30)' }, sheet: { height: '90%', borderTopLeftRadius: 18, borderTopRightRadius: 18, backgroundColor: '#F4F7FB', padding: 18, paddingBottom: 28 }, editor: { height: '94%', borderTopLeftRadius: 18, borderTopRightRadius: 18, backgroundColor: '#F4F7FB', overflow: 'hidden' }, handle: { width: 38, height: 4, alignSelf: 'center', borderRadius: 2, backgroundColor: '#D0D5DD' }, header: { minHeight: 70, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, title: { color: colors.ink, fontSize: 20, fontWeight: '900' }, subtitle: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 4 }, loading: { padding: 30, alignItems: 'center', gap: 8 }, muted: { color: colors.muted, fontSize: 10 }, list: { paddingBottom: 24 }, draftRow: { minHeight: 86, padding: 14, marginBottom: 9, borderRadius: 14, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, rowCopy: { flex: 1 }, rowTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, rowMeta: { color: colors.muted, fontSize: 8, lineHeight: 13, marginTop: 5 }, empty: { color: colors.muted, fontSize: 11, textAlign: 'center', padding: 30 }, primary: { minHeight: 47, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', borderRadius: 11, backgroundColor: colors.primary }, primaryText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' }, disabled: { opacity: 0.5 }, form: { padding: 16, paddingBottom: 24 }, section: { marginBottom: 10, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' }, sectionHead: { minHeight: 56, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, sectionTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, sectionBody: { paddingHorizontal: 14, paddingBottom: 14, borderTopWidth: 1, borderTopColor: colors.line }, field: { flex: 1, marginTop: 13 }, fieldLabel: { color: colors.ink, fontSize: 10, fontWeight: '800', marginBottom: 6 }, input: { minHeight: 45, paddingHorizontal: 12, borderRadius: 9, color: colors.ink, fontSize: 11, backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: colors.line }, multiline: { minHeight: 86, paddingTop: 11, textAlignVertical: 'top' }, inputError: { borderColor: colors.red }, fieldError: { color: colors.red, fontSize: 8, marginTop: 5 }, chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, chip: { minHeight: 35, paddingHorizontal: 11, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: colors.line }, chipActive: { backgroundColor: colors.primarySoft, borderColor: '#B7CEF4' }, chipText: { color: colors.muted, fontSize: 9, fontWeight: '700' }, chipTextActive: { color: colors.primary, fontWeight: '900' }, two: { flexDirection: 'row', gap: 9 }, dateRow: { flexDirection: 'row', gap: 8 }, dateButton: { flex: 1, minHeight: 44, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 9, backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: colors.line }, dateText: { color: colors.ink, fontSize: 9, fontWeight: '800' }, warningText: { color: colors.primaryDark, fontSize: 9, lineHeight: 14, padding: 10, borderRadius: 9, backgroundColor: colors.amberSoft }, check: { minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 8 }, checkText: { color: colors.ink, fontSize: 10 }, errorBox: { marginVertical: 9, padding: 11, borderRadius: 10, backgroundColor: '#FDECEC' }, errorText: { color: colors.red, fontSize: 9, lineHeight: 14 }, errorAction: { color: colors.primary, fontSize: 9, fontWeight: '900', marginTop: 7 }, notice: { color: colors.green, fontSize: 10, fontWeight: '800', textAlign: 'center', marginTop: 10 }, footer: { padding: 14, paddingBottom: 24, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.line }, saveSpace: { height: 10 },
});
