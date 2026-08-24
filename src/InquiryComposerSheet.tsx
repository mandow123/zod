import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import * as Crypto from 'expo-crypto';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView,
  StyleSheet, Switch, Text, TextInput, View,
} from 'react-native';
import { loadLegalDocuments, type LegalDocuments } from './api';
import {
  createResourceInquiry, loadInquiryCandidate, validateInquiryInput,
  type CreateResourceInquiryInput, type InquiryBillingMode, type InquiryCatalogCandidate,
  type ResourceInquiry,
} from './resource-inquiries';
import { loadSupplierInquiryResource, supplierCatalogInquiryCandidate } from './honghuan-inquiry-catalog';
import { colors } from './theme';
import {
  COMMON_TIME_ZONES, formatZonedDateTime, initialInquirySchedule, inquiryCardTypeLabel, systemTimeZone,
} from './inquiry-form';
import { ApiError } from './api-client';

type Draft = Readonly<{
  startsAt: string; endsAt: string; confirmBy: string; timeZone: string; quantity: string;
  billingMode: InquiryBillingMode; useCase: ResourceInquiry['useCase']; description: string;
  environment: ResourceInquiry['requirements']['environment']; network: ResourceInquiry['requirements']['network'];
  storageGiB: string; dataRegion: string; allowSubstitutes: boolean; maxCreditAmount: string;
}>;

const useCases: Array<[Draft['useCase'], string]> = [
  ['training', '训练'], ['inference', '推理'], ['rendering', '渲染'], ['research', '科研'], ['other', '其他'],
];
const environments: Array<[Draft['environment'], string]> = [
  ['bare_metal', '裸金属'], ['virtual_machine', '虚拟机'], ['container', '容器'], ['flexible', '可协商'],
];
const networks: Array<[Draft['network'], string]> = [
  ['public_internet', '公网'], ['private_network', '私网'], ['dedicated_line', '专线'], ['flexible', '可协商'],
];

function createInitialDraft(): Draft {
  return {
    ...initialInquirySchedule(), timeZone: systemTimeZone(), quantity: '1', billingMode: 'hourly',
    useCase: 'training', description: '', environment: 'container', network: 'public_internet', storageGiB: '100',
    dataRegion: '中国大陆', allowSubstitutes: false, maxCreditAmount: '',
  };
}

function initialQuantity(candidate: InquiryCatalogCandidate) {
  return String(candidate.catalog?.quantity.allowedValues?.[0] ?? candidate.catalog?.quantity.min ?? 1);
}

export function InquiryComposerSheet({ candidate: initialCandidate, visible, authenticated, onLogin, onClose, onSubmitted }: Readonly<{
  candidate: InquiryCatalogCandidate | null; visible: boolean; authenticated: boolean;
  onLogin: () => void; onClose: () => void; onSubmitted: (inquiry: ResourceInquiry) => void;
}>) {
  const [candidate, setCandidate] = useState<InquiryCatalogCandidate | null>(null);
  const [documents, setDocuments] = useState<LegalDocuments | null>(null);
  const [draft, setDraft] = useState<Draft>(createInitialDraft);
  const [timeZoneVisible, setTimeZoneVisible] = useState(false);
  const [accepted, setAccepted] = useState({ terms: false, privacy: false, inquiry: false });
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<ResourceInquiry | null>(null);
  const request = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    if (!visible || !initialCandidate) return;
    let active = true;
    setCandidate(initialCandidate); setDraft({ ...createInitialDraft(), quantity: initialQuantity(initialCandidate),
      billingMode: initialCandidate.modes[0] ?? 'hourly' });
    setDocuments(null); setAccepted({ terms: false, privacy: false, inquiry: false }); setError(null); setSubmitted(null); request.current = null;
    setLoading(true);
    const candidateRequest = initialCandidate.source === 'shanghai_honghuan'
      ? loadSupplierInquiryResource(initialCandidate.candidateId).then(supplierCatalogInquiryCandidate)
      : loadInquiryCandidate(initialCandidate.candidateId);
    void Promise.all([candidateRequest, loadLegalDocuments()])
      .then(([nextCandidate, nextDocuments]) => {
        if (!active) return;
        setCandidate(nextCandidate); setDocuments(nextDocuments);
        setDraft((current) => ({ ...current, quantity: initialQuantity(nextCandidate),
          billingMode: nextCandidate.modes[0] ?? 'hourly' }));
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : '暂时无法读取询期资料。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [initialCandidate, visible]);

  const parsed = useMemo(() => ({
    ...draft, gpuCount: Number(draft.quantity), storageGiB: Number(draft.storageGiB),
  }), [draft]);
  const supplierQuantity = candidate?.catalog?.quantity;
  const parsedQuantity = Number(draft.quantity);
  const supplierQuantityError = supplierQuantity && (!Number.isInteger(parsedQuantity)
    || parsedQuantity < supplierQuantity.min || parsedQuantity > supplierQuantity.max
    || (supplierQuantity.allowedValues !== null && !supplierQuantity.allowedValues.includes(parsedQuantity)))
    ? supplierQuantity.allowedValues
      ? `请选择 ${supplierQuantity.allowedValues.join(' / ')} 中的一个租赁档位。`
      : `主机实例数需为 ${supplierQuantity.min} 至 ${supplierQuantity.max} 的整数。`
    : null;
  const validationError = supplierQuantityError ?? validateInquiryInput(parsed);
  const allAccepted = accepted.terms && accepted.privacy && accepted.inquiry;
  const canSubmit = Boolean(candidate && documents && !validationError && allAccepted && !submitting);
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    if (!candidate || !documents || validationError || !allAccepted || submitting) return;
    if (!authenticated) { onLogin(); return; }
    const common = {
      startsAt: parsed.startsAt, endsAt: parsed.endsAt, timeZone: parsed.timeZone, confirmBy: parsed.confirmBy,
      billingMode: parsed.billingMode, allowSubstitutes: parsed.allowSubstitutes,
      maxCreditAmount: parsed.maxCreditAmount, useCase: parsed.useCase, description: parsed.description.trim(),
      environment: parsed.environment, network: parsed.network, storageGiB: parsed.storageGiB,
      dataRegion: parsed.dataRegion.trim(),
      terms: {
        termsVersion: documents.terms.version,
        privacyVersion: documents.privacy.version,
        inquiryVersion: documents.inquiry.version,
      },
    };
    const input: CreateResourceInquiryInput = candidate.source === 'shanghai_honghuan' && candidate.catalog
      ? { ...common, source: 'shanghai_honghuan', supplierResourceId: candidate.catalog.canonicalId,
        supplierResourceVersion: candidate.catalog.version, quantity: parsedQuantity }
      : { ...common, source: 'general_inquiry', candidateId: candidate.candidateId, gpuCount: parsedQuantity };
    const signature = JSON.stringify(input);
    if (request.current?.signature !== signature) request.current = { signature, key: `resource-inquiry:${Crypto.randomUUID()}` };
    setSubmitting(true); setError(null);
    try {
      const result = await createResourceInquiry(input, request.current.key);
      request.current = null; setSubmitted(result.inquiry); onSubmitted(result.inquiry);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'LEGAL_VERSION_STALE') {
        try {
          setDocuments(await loadLegalDocuments()); setAccepted({ terms: false, privacy: false, inquiry: false });
          request.current = null; setError('协议已更新，请重新阅读并勾选三份协议。');
        } catch (legalReason) {
          setError(legalReason instanceof Error ? legalReason.message : '协议已更新，暂时无法重新读取。');
        }
      } else if (reason instanceof ApiError && reason.code === 'CATALOG_VERSION_CONFLICT'
        && candidate.source === 'shanghai_honghuan') {
        try {
          const refreshed = supplierCatalogInquiryCandidate(await loadSupplierInquiryResource(candidate.candidateId));
          setCandidate(refreshed); setAccepted({ terms: false, privacy: false, inquiry: false }); request.current = null;
          setError('目录信息已更新，已保留你填写的需求。请重新核对配置和参考卡时后再确认。');
        } catch (refreshReason) {
          setError(refreshReason instanceof Error ? refreshReason.message : '目录已更新，暂时无法读取新版本。');
        }
      } else setError(reason instanceof Error ? reason.message : '询期提交结果暂时无法确认，请使用同一内容重试。');
    } finally { setSubmitting(false); }
  };

  const openDocument = (url: string | null) => {
    if (url && /^https:\/\//u.test(url)) void Linking.openURL(url);
    else setError('协议地址尚未配置，请稍后重试。');
  };

  return <><Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.backdrop}>
      <View style={styles.sheet}><View style={styles.handle} />
        <View style={styles.heading}><View><Text style={styles.eyebrow}>预约算力</Text><Text style={styles.title}>{submitted ? '询期已提交' : `${candidate?.model ?? 'GPU'} 询期`}</Text></View><Pressable onPress={onClose} accessibilityLabel="关闭询期"><Ionicons name="close" size={24} color={colors.ink} /></Pressable></View>
        {submitted ? <View style={styles.success}><View style={styles.successIcon}><Ionicons name="checkmark" size={26} color={colors.green} /></View><Text style={styles.successTitle}>询期已提交</Text><Text style={styles.successText}>平台正在联系供应方</Text><Text style={styles.successMeta}>询期编号 {submitted.inquiryNumber}</Text><Text style={styles.disclosure}>此次提交不会生成订单，也不会冻结或扣除卡时。</Text><Pressable onPress={onClose} style={styles.primary}><Text style={styles.primaryText}>完成</Text></Pressable></View> :
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {loading ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.hint}>正在读取候选资源与协议</Text></View> : null}
          {candidate ? <View style={styles.candidate}><View style={styles.candidateCopy}><Text style={styles.candidateTitle}>{candidate.model} · {inquiryCardTypeLabel(candidate.cardType)}</Text><Text style={styles.candidateMeta}>{candidate.region} · {candidate.supplier.displayName}</Text>{candidate.source === 'shanghai_honghuan' ? <Text style={styles.unverified}>报价资料导入 · 未经 KAI 验真</Text> : null}</View><View><Text style={styles.quote}>{candidate.catalog?.referenceCreditAmount ? `${candidate.catalog.referenceCreditAmount} KAI 卡时` : '参考卡时待确认'}</Text>{candidate.catalog?.legalReviewRequired ? <Text style={styles.legalReview}>合同条款待确认</Text> : null}</View></View> : null}
          <DateTimeField label="开始时间" hint="分别选择日期和时间" value={draft.startsAt} timeZone={draft.timeZone} minimumDate={new Date()} onChange={(value) => update('startsAt', value)} />
          <DateTimeField label="精确归还时间" hint="必须晚于开始时间" value={draft.endsAt} timeZone={draft.timeZone} minimumDate={new Date(draft.startsAt)} onChange={(value) => update('endsAt', value)} />
          <DateTimeField label="最晚确认时间" hint="必须早于开始时间" value={draft.confirmBy} timeZone={draft.timeZone} minimumDate={new Date()} maximumDate={new Date(draft.startsAt)} onChange={(value) => update('confirmBy', value)} />
          <Field label="使用时区" hint="切换时区会更新界面显示，已选的时刻不变"><Pressable accessibilityLabel="选择时区" onPress={() => setTimeZoneVisible(true)} style={styles.selectField}><View><Text style={styles.selectText}>{timeZoneLabel(draft.timeZone)}</Text><Text style={styles.selectMeta}>{draft.timeZone}</Text></View><Ionicons name="chevron-forward" size={18} color={colors.muted} /></Pressable></Field>
          {candidate?.catalog?.quantity.allowedValues ? <Choice label="整机长期租赁档位" value={draft.quantity}
            choices={candidate.catalog.quantity.allowedValues.map((value) => [String(value), `${value} 台`] as [string, string])}
            onChange={(value) => update('quantity', value)} />
            : <View style={styles.twoColumns}><View style={styles.column}><Field label={candidate?.source === 'shanghai_honghuan' ? '主机实例数' : 'GPU 数量'}><Input value={draft.quantity} keyboardType="number-pad" onChangeText={(value) => update('quantity', value)} /></Field></View><View style={styles.column}><Field label="存储（GiB）"><Input value={draft.storageGiB} keyboardType="number-pad" onChangeText={(value) => update('storageGiB', value)} /></Field></View></View>}
          {candidate?.catalog?.quantity.allowedValues ? <Field label="存储（GiB）"><Input value={draft.storageGiB} keyboardType="number-pad" onChangeText={(value) => update('storageGiB', value)} /></Field> : null}
          <Choice label="结算周期" value={draft.billingMode} choices={candidate?.modes.map((mode) => [mode, mode === 'hourly' ? '按小时' : '包月'] as [InquiryBillingMode, string]) ?? []} onChange={(value) => update('billingMode', value)} />
          <Choice label="用途分类" value={draft.useCase} choices={useCases} onChange={(value) => update('useCase', value)} />
          <Field label="需求说明" hint={`${draft.description.trim().length}/500，至少 20 字`}><Input value={draft.description} multiline onChangeText={(value) => update('description', value)} placeholder="说明工作负载、软件版本、期望交付方式与验收条件" /></Field>
          <Choice label="运行环境" value={draft.environment} choices={environments} onChange={(value) => update('environment', value)} />
          <Choice label="网络要求" value={draft.network} choices={networks} onChange={(value) => update('network', value)} />
          <Field label="数据区域"><Input value={draft.dataRegion} onChangeText={(value) => update('dataRegion', value)} placeholder="数据驻留或合规区域" /></Field>
          <View style={styles.switchRow}><View style={styles.switchCopy}><Text style={styles.fieldLabel}>接受替代方案</Text><Text style={styles.fieldHint}>供应方可推荐同等级或更高配置，最终仍需你确认</Text></View><Switch value={draft.allowSubstitutes} onValueChange={(value) => update('allowSubstitutes', value)} trackColor={{ true: colors.primarySoft }} thumbColor={draft.allowSubstitutes ? colors.primary : colors.subtle} /></View>
          <Field label="最大可接受卡时" hint="仅作为询期预算偏好，不冻结、不扣除"><Input value={draft.maxCreditAmount} keyboardType="decimal-pad" onChangeText={(value) => update('maxCreditAmount', value)} placeholder="例如 1000.00" /><Text style={styles.inputUnit}>KAI 卡时</Text></Field>
          {documents ? <View style={styles.legal}>{([
            ['terms', '用户协议', documents.terms.url], ['privacy', '隐私政策', documents.privacy.url], ['inquiry', '算力询期服务协议', documents.inquiry.url],
          ] as const).map(([key, label, url]) => <Pressable key={key} onPress={() => setAccepted((current) => ({ ...current, [key]: !current[key] }))} style={styles.consent}><View style={[styles.checkbox, accepted[key] && styles.checkboxActive]}>{accepted[key] ? <Ionicons name="checkmark" size={14} color={colors.surface} /> : null}</View><Text style={styles.consentText}>我已阅读并同意</Text><Pressable onPress={() => openDocument(url)}><Text style={styles.legalLink}>{label}</Text></Pressable></Pressable>)}</View> : null}
          {error || validationError ? <View style={styles.error}><Ionicons name="alert-circle-outline" size={18} color={colors.red} /><Text style={styles.errorText}>{error ?? validationError}</Text></View> : null}
          <Pressable disabled={!canSubmit} onPress={() => void submit()} style={[styles.primary, !canSubmit && styles.disabled]}>{submitting ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>{authenticated ? candidate?.catalog?.serviceMode === 'long_term_machine' ? '提交租赁意向' : '提交询期' : '登录后提交'}</Text>}</Pressable>
          <Text style={styles.disclosure}>提交后仅进入供应方询期，不生成购买或订单，也不会冻结卡时。</Text>
        </ScrollView>}
      </View>
    </KeyboardAvoidingView>
  </Modal><TimeZonePicker visible={timeZoneVisible} value={draft.timeZone} onClose={() => setTimeZoneVisible(false)} onSelect={(value) => { update('timeZone', value); setTimeZoneVisible(false); }} /></>;
}

function Field({ label, hint, children }: Readonly<{ label: string; hint?: string; children: React.ReactNode }>) { return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text>{hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}<View style={styles.inputWrap}>{children}</View></View>; }
function Input(props: React.ComponentProps<typeof TextInput>) { return <TextInput {...props} placeholderTextColor={colors.subtle} style={[styles.input, props.multiline && styles.multiline]} />; }
function Choice<T extends string>({ label, value, choices, onChange }: Readonly<{ label: string; value: T; choices: Array<[T, string]>; onChange: (value: T) => void }>) { return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><View style={styles.chips}>{choices.map(([key, text]) => <Pressable key={key} onPress={() => onChange(key)} style={[styles.chip, value === key && styles.chipActive]}><Text style={[styles.chipText, value === key && styles.chipTextActive]}>{text}</Text></Pressable>)}</View></View>; }

function DateTimeField({ label, hint, value, timeZone, minimumDate, maximumDate, onChange }: Readonly<{
  label: string; hint: string; value: string; timeZone: string; minimumDate?: Date; maximumDate?: Date; onChange: (value: string) => void;
}>) {
  const [iosMode, setIosMode] = useState<'date' | 'time' | null>(null);
  const selected = new Date(value);
  const safeValue = Number.isNaN(selected.getTime()) ? new Date() : selected;
  const display = formatZonedDateTime(value, timeZone);
  const open = (mode: 'date' | 'time') => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: safeValue, mode, is24Hour: true, timeZoneName: timeZone, minimumDate, maximumDate,
        onValueChange: (_event, next) => onChange(next.toISOString()),
      });
    } else setIosMode(mode);
  };
  return <Field label={label} hint={hint}><View style={styles.dateTimeRow}><Pressable accessibilityLabel={`${label}日期`} onPress={() => open('date')} style={styles.dateTimeButton}><Ionicons name="calendar-outline" size={17} color={colors.primary} /><Text style={styles.dateTimeText}>{display.date}</Text></Pressable><Pressable accessibilityLabel={`${label}时间`} onPress={() => open('time')} style={styles.dateTimeButton}><Ionicons name="time-outline" size={17} color={colors.primary} /><Text style={styles.dateTimeText}>{display.time}</Text></Pressable></View>{Platform.OS === 'ios' && iosMode ? <View style={styles.iosPicker}><DateTimePicker value={safeValue} mode={iosMode} display="spinner" timeZoneName={timeZone} minimumDate={minimumDate} maximumDate={maximumDate} onValueChange={(_event, next) => onChange(next.toISOString())} /><Pressable onPress={() => setIosMode(null)}><Text style={styles.pickerDone}>完成</Text></Pressable></View> : null}</Field>;
}

function timeZoneLabel(value: string) { return COMMON_TIME_ZONES.find(([zone]) => zone === value)?.[1] ?? '系统时区'; }

function TimeZonePicker({ visible, value, onClose, onSelect }: Readonly<{ visible: boolean; value: string; onClose: () => void; onSelect: (value: string) => void }>) {
  const [query, setQuery] = useState('');
  const zones = useMemo(() => {
    const base: Array<readonly [string, string]> = COMMON_TIME_ZONES.some(([zone]) => zone === value) ? [...COMMON_TIME_ZONES] : [[value, '系统时区'], ...COMMON_TIME_ZONES];
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? base.filter(([zone, label]) => `${zone} ${label}`.toLocaleLowerCase().includes(normalized)) : base;
  }, [query, value]);
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><View style={styles.timeZoneBackdrop}><View style={styles.timeZoneSheet}><View style={styles.timeZoneHeading}><Text style={styles.timeZoneTitle}>选择时区</Text><Pressable onPress={onClose}><Ionicons name="close" size={22} color={colors.ink} /></Pressable></View><View style={styles.timeZoneSearch}><Ionicons name="search" size={18} color={colors.muted} /><TextInput value={query} onChangeText={setQuery} placeholder="搜索城市或时区" placeholderTextColor={colors.subtle} style={styles.timeZoneInput} /></View><ScrollView keyboardShouldPersistTaps="handled">{zones.map(([zone, label]) => <Pressable key={zone} onPress={() => onSelect(zone)} style={styles.timeZoneOption}><View><Text style={styles.timeZoneLabel}>{label}</Text><Text style={styles.timeZoneCode}>{zone}</Text></View>{zone === value ? <Ionicons name="checkmark-circle" size={20} color={colors.primary} /> : null}</Pressable>)}{!zones.length ? <Text style={styles.timeZoneEmpty}>没有匹配的常用时区</Text> : null}</ScrollView></View></View></Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(17,24,39,0.34)' }, sheet: { maxHeight: '94%', borderTopLeftRadius: 22, borderTopRightRadius: 22, backgroundColor: colors.canvas, overflow: 'hidden' }, handle: { width: 38, height: 4, marginTop: 9, borderRadius: 2, alignSelf: 'center', backgroundColor: '#CAD2DC' }, heading: { minHeight: 76, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.line }, eyebrow: { color: colors.primary, fontSize: 9, fontWeight: '900' }, title: { color: colors.ink, fontSize: 21, fontWeight: '900', marginTop: 3 }, content: { padding: 16, paddingBottom: 36 }, loading: { padding: 18, alignItems: 'center', gap: 8 }, hint: { color: colors.muted, fontSize: 10 }, candidate: { padding: 14, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: '#CFE0F8', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }, candidateCopy: { flex: 1 }, candidateTitle: { color: colors.ink, fontSize: 14, fontWeight: '900' }, candidateMeta: { color: colors.muted, fontSize: 9, marginTop: 4 }, unverified: { color: colors.muted, fontSize: 8, lineHeight: 13, marginTop: 4 }, quote: { color: colors.primary, fontSize: 9, fontWeight: '900', textAlign: 'right' }, legalReview: { color: colors.muted, fontSize: 8, fontWeight: '800', marginTop: 4, textAlign: 'right' }, field: { marginTop: 15 }, fieldLabel: { color: colors.ink, fontSize: 12, fontWeight: '900' }, fieldHint: { color: colors.muted, fontSize: 8, lineHeight: 13, marginTop: 3 }, inputWrap: { position: 'relative', marginTop: 7 }, input: { minHeight: 46, paddingHorizontal: 13, borderRadius: 9, color: colors.ink, fontSize: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, multiline: { minHeight: 90, paddingTop: 12, textAlignVertical: 'top' }, inputUnit: { position: 'absolute', right: 12, top: 15, color: colors.muted, fontSize: 9 }, twoColumns: { flexDirection: 'row', gap: 10 }, column: { flex: 1 }, chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 7 }, chip: { minHeight: 36, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, chipActive: { backgroundColor: colors.primarySoft, borderColor: '#B7CEF4' }, chipText: { color: colors.muted, fontSize: 10, fontWeight: '700' }, chipTextActive: { color: colors.primary, fontWeight: '900' }, switchRow: { minHeight: 64, marginTop: 15, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', borderRadius: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, switchCopy: { flex: 1 }, legal: { marginTop: 18, padding: 12, borderRadius: 11, backgroundColor: colors.surface }, consent: { minHeight: 36, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }, checkbox: { width: 20, height: 20, borderRadius: 6, alignItems: 'center', justifyContent: 'center', marginRight: 3, borderWidth: 1, borderColor: colors.line }, checkboxActive: { backgroundColor: colors.primary, borderColor: colors.primary }, consentText: { color: colors.muted, fontSize: 10 }, legalLink: { color: colors.primary, fontSize: 10, fontWeight: '800' }, error: { marginTop: 14, padding: 11, flexDirection: 'row', gap: 7, borderRadius: 10, backgroundColor: '#FDECEC' }, errorText: { flex: 1, color: colors.red, fontSize: 10, lineHeight: 15 }, primary: { minHeight: 49, marginTop: 18, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: colors.primary }, disabled: { opacity: 0.4 }, primaryText: { color: colors.surface, fontSize: 13, fontWeight: '900' }, disclosure: { color: colors.muted, fontSize: 9, lineHeight: 14, textAlign: 'center', marginTop: 10 }, success: { padding: 28, alignItems: 'center' }, successIcon: { width: 56, height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.greenSoft }, successTitle: { color: colors.ink, fontSize: 22, fontWeight: '900', marginTop: 16 }, successText: { color: colors.muted, fontSize: 12, marginTop: 7 }, successMeta: { color: colors.primary, fontSize: 10, fontWeight: '800', marginTop: 14 },
  selectField: { minHeight: 54, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 9, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  selectText: { color: colors.ink, fontSize: 12, fontWeight: '800' }, selectMeta: { color: colors.muted, fontSize: 8, marginTop: 3 },
  dateTimeRow: { flexDirection: 'row', gap: 8 }, dateTimeButton: { flex: 1, minHeight: 46, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 9, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, dateTimeText: { color: colors.ink, fontSize: 11, fontWeight: '800' },
  iosPicker: { marginTop: 8, padding: 8, borderRadius: 10, backgroundColor: colors.surface }, pickerDone: { color: colors.primary, fontWeight: '900', textAlign: 'right', padding: 8 },
  timeZoneBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(17,24,39,0.34)' }, timeZoneSheet: { maxHeight: '72%', padding: 16, paddingBottom: 28, borderTopLeftRadius: 20, borderTopRightRadius: 20, backgroundColor: colors.canvas }, timeZoneHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, timeZoneTitle: { color: colors.ink, fontSize: 18, fontWeight: '900' }, timeZoneSearch: { minHeight: 46, marginTop: 12, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 9, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, timeZoneInput: { flex: 1, color: colors.ink, fontSize: 12 }, timeZoneOption: { minHeight: 58, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: colors.line }, timeZoneLabel: { color: colors.ink, fontSize: 12, fontWeight: '800' }, timeZoneCode: { color: colors.muted, fontSize: 8, marginTop: 3 }, timeZoneEmpty: { color: colors.muted, fontSize: 11, textAlign: 'center', padding: 24 },
});
