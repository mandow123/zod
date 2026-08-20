import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import {
  addInquiryClarification, cancelResourceInquiry, inquiryStatusLabel, loadResourceInquiries,
  loadResourceInquiry, type ResourceInquiry, type ResourceInquiryStatus, type ResourceInquirySummary,
} from './resource-inquiries';
import { colors } from './theme';
import { formatZonedDateTime, inquiryCardTypeLabel } from './inquiry-form';

const statusFilters: Array<[ResourceInquiryStatus | null, string]> = [
  [null, '全部'], ['submitted', '已提交'], ['awaiting_supplier', '联系中'],
  ['clarification_required', '待补件'], ['supplier_declined', '未承接'],
  ['inquiry_expired', '已过期'], ['user_cancelled', '已取消'],
  ['capacity_confirmed', '容量已确认'], ['audit_pending', '审核中'],
];

export function MyInquiriesSheet({ visible, authenticated, onLogin, onClose }: Readonly<{
  visible: boolean; authenticated: boolean; onLogin: () => void; onClose: () => void;
}>) {
  const [status, setStatus] = useState<ResourceInquiryStatus | null>(null);
  const [items, setItems] = useState<ResourceInquirySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ResourceInquiry | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [clarification, setClarification] = useState('');
  const [mutating, setMutating] = useState(false);
  const mutationRequest = useRef<{ signature: string; key: string } | null>(null);

  const load = useCallback(async (append = false) => {
    if (!authenticated) return;
    append ? setLoadingMore(true) : setLoading(true); setError(null);
    try {
      const result = await loadResourceInquiries({ status, cursor: append ? cursor : null, limit: 20 });
      setItems((current) => append ? [...current, ...result.inquiries] : result.inquiries);
      setCursor(result.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '暂时无法读取询期记录。');
    } finally { append ? setLoadingMore(false) : setLoading(false); }
  }, [authenticated, cursor, status]);

  useEffect(() => {
    if (!visible) return;
    setSelected(null); setItems([]); setCursor(null); setError(null); setClarification('');
    if (authenticated) void load(false);
  // `load` changes with the cursor populated by this request; only visibility and filters start a new first page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, status, visible]);

  const openDetail = async (item: ResourceInquirySummary) => {
    setDetailLoading(true); setError(null); setClarification(''); mutationRequest.current = null;
    try { setSelected(await loadResourceInquiry(item.id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '暂时无法读取询期详情。'); }
    finally { setDetailLoading(false); }
  };
  const refreshSelected = async (inquiryId: string) => {
    setDetailLoading(true); setError(null);
    try {
      const next = await loadResourceInquiry(inquiryId); setSelected(next);
      setItems((current) => current.map((item) => item.id === next.id ? next : item));
    } catch (reason) { setError(reason instanceof Error ? reason.message : '暂时无法重新查询询期状态。'); }
    finally { setDetailLoading(false); }
  };
  const clarify = async () => {
    if (!selected || !selected.allowedActions.includes('provide_clarification') || clarification.trim().length < 20 || mutating) return;
    const signature = `${selected.id}:${selected.version}:${clarification.trim()}`;
    if (mutationRequest.current?.signature !== signature) mutationRequest.current = { signature, key: `inquiry-clarify:${Crypto.randomUUID()}` };
    setMutating(true); setError(null);
    try {
      const next = await addInquiryClarification(selected.id, clarification.trim(), selected.version, mutationRequest.current.key);
      setSelected(next); setItems((current) => current.map((item) => item.id === next.id ? next : item));
      setClarification(''); mutationRequest.current = null;
    } catch (reason) { setError(reason instanceof Error ? reason.message : '补充内容提交结果暂时无法确认，请保持内容不变后重试。'); }
    finally { setMutating(false); }
  };
  const cancel = (inquiry: ResourceInquiry) => Alert.alert('取消这次询期？', '取消后不能恢复，但不会产生订单或扣除卡时。', [
    { text: '继续保留', style: 'cancel' },
    { text: '确认取消', style: 'destructive', onPress: () => {
      const signature = `cancel:${inquiry.id}:${inquiry.version}`;
      if (mutationRequest.current?.signature !== signature) mutationRequest.current = { signature, key: `inquiry-cancel:${Crypto.randomUUID()}` };
      setMutating(true); setError(null);
      void cancelResourceInquiry(inquiry.id, inquiry.version, mutationRequest.current.key).then((next) => {
        setSelected(next); setItems((current) => current.map((item) => item.id === next.id ? next : item)); mutationRequest.current = null;
      }).catch((reason) => setError(reason instanceof Error ? reason.message : '取消结果暂时无法确认，请重试。'))
        .finally(() => setMutating(false));
    } },
  ]);

  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.backdrop}><View style={styles.sheet}><View style={styles.handle} />
    <View style={styles.heading}><View><Text style={styles.eyebrow}>预约算力</Text><Text style={styles.title}>{selected ? '询期详情' : '我的询期'}</Text></View><Pressable onPress={selected ? () => setSelected(null) : onClose} accessibilityLabel={selected ? '返回询期列表' : '关闭我的询期'}><Ionicons name={selected ? 'arrow-back' : 'close'} size={24} color={colors.ink} /></Pressable></View>
    {!authenticated ? <View style={styles.center}><Ionicons name="person-circle-outline" size={42} color={colors.primary} /><Text style={styles.centerTitle}>登录后查看我的询期</Text><Text style={styles.centerText}>询期按当前主体隔离显示。</Text><Pressable onPress={onLogin} style={styles.primary}><Text style={styles.primaryText}>登录 Zod</Text></Pressable></View> : selected ?
      <InquiryDetail inquiry={selected} clarification={clarification} setClarification={setClarification} mutating={mutating} error={error}
        onClarify={() => void clarify()} onCancel={() => cancel(selected)} onRefresh={() => void refreshSelected(selected.id)} /> :
      <View style={styles.flex}><View style={styles.filtersRail}><ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filtersScroll} contentContainerStyle={styles.filters}>{statusFilters.map(([key, label]) => <Pressable key={key ?? 'all'} onPress={() => setStatus(key)} style={[styles.filter, status === key && styles.filterActive]}><Text style={[styles.filterText, status === key && styles.filterTextActive]}>{label}</Text></Pressable>)}</ScrollView></View>
        {loading || detailLoading ? <View style={styles.center}><ActivityIndicator color={colors.primary} /><Text style={styles.centerText}>正在读取真实询期状态</Text></View> : error ? <View style={styles.center}><Ionicons name="cloud-offline-outline" size={34} color={colors.amber} /><Text style={styles.centerTitle}>暂时无法读取询期</Text><Text style={styles.centerText}>{error}</Text><Pressable onPress={() => void load(false)} style={styles.secondary}><Text style={styles.secondaryText}>重新加载</Text></Pressable></View> :
        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>{items.map((item) => <InquiryRow key={item.id} item={item} onPress={() => void openDetail(item)} />)}{!items.length ? <View style={styles.empty}><Text style={styles.centerTitle}>暂无询期记录</Text><Text style={styles.centerText}>从市场的“预约算力”选择候选资源并提交询期。</Text></View> : null}{cursor ? <Pressable disabled={loadingMore} onPress={() => void load(true)} style={styles.secondary}>{loadingMore ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.secondaryText}>继续加载</Text>}</Pressable> : null}</ScrollView>}
      </View>}
  </View></KeyboardAvoidingView></Modal>;
}

function InquiryRow({ item, onPress }: Readonly<{ item: ResourceInquirySummary; onPress: () => void }>) { return <Pressable onPress={onPress} style={styles.row}><View style={styles.rowTop}><Text style={styles.rowTitle}>{item.candidate.model} · {inquiryCardTypeLabel(item.candidate.cardType)}</Text><Text style={[styles.status, item.status === 'clarification_required' && styles.statusAttention]}>{inquiryStatusLabel[item.status]}</Text></View><Text style={styles.rowMeta}>{item.candidate.region} · {item.gpuCount} 张 · {item.billingMode === 'hourly' ? '按小时询期' : '包月询期'}</Text><Text style={styles.rowTime}>{dateTime(item.startsAt, item.timeZone)} 至 {dateTime(item.endsAt, item.timeZone)} · {item.timeZone}</Text><View style={styles.rowBottom}><Text style={styles.number}>{item.inquiryNumber}</Text><Ionicons name="chevron-forward" size={16} color={colors.subtle} /></View></Pressable>; }

function InquiryDetail({ inquiry, clarification, setClarification, mutating, error, onClarify, onCancel, onRefresh }: Readonly<{
  inquiry: ResourceInquiry; clarification: string; setClarification: (value: string) => void; mutating: boolean;
  error: string | null; onClarify: () => void; onCancel: () => void; onRefresh: () => void;
}>) {
  return <ScrollView contentContainerStyle={styles.detail} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}><View style={styles.detailHero}><Text style={styles.detailTitle}>{inquiry.candidate.model} · {inquiryCardTypeLabel(inquiry.candidate.cardType)}</Text><Text style={styles.detailRegion}>{inquiry.candidate.region} · 待认领供应方</Text><Text style={styles.detailStatus}>{inquiryStatusLabel[inquiry.status]}</Text>{inquiry.statusMessage ? <Text style={styles.description}>{inquiry.statusMessage}</Text> : null}</View>
    <View style={styles.detailCard}>{[
      ['询期编号', inquiry.inquiryNumber], ['使用时段', `${dateTime(inquiry.startsAt, inquiry.timeZone)} 至 ${dateTime(inquiry.endsAt, inquiry.timeZone)}`], ['最晚确认', dateTime(inquiry.confirmBy, inquiry.timeZone)], ['时区', inquiry.timeZone], ['GPU 数量', `${inquiry.gpuCount} 张`], ['周期', inquiry.billingMode === 'hourly' ? '按小时' : '包月'], ['最大可接受卡时', `${inquiry.maxCreditAmount} KAI 卡时`], ['接受替代', inquiry.allowSubstitutes ? '是' : '否'], ['环境', requirementLabel(inquiry.requirements.environment)], ['网络', networkLabel(inquiry.requirements.network)], ['存储', `${inquiry.requirements.storageGiB} GiB`], ['数据区域', inquiry.requirements.dataRegion],
    ].map(([label, value]) => <View key={label} style={styles.detailLine}><Text style={styles.detailLabel}>{label}</Text><Text style={styles.detailValue}>{value}</Text></View>)}</View>
    <View style={styles.detailCard}><Text style={styles.blockTitle}>需求说明</Text><Text style={styles.description}>{inquiry.description}</Text></View>
    {inquiry.clarifications.length ? <View style={styles.detailCard}><Text style={styles.blockTitle}>补充记录</Text>{inquiry.clarifications.map((item) => <View key={item.id} style={styles.clarification}><Text style={styles.description}>{item.message}</Text><Text style={styles.rowTime}>{dateTime(item.createdAt, inquiry.timeZone)} · 询期时区</Text></View>)}</View> : null}
    {inquiry.allowedActions.includes('provide_clarification') ? <View style={styles.detailCard}><Text style={styles.blockTitle}>补充询期资料</Text><TextInput value={clarification} onChangeText={setClarification} multiline placeholder="根据平台或供应方要求补充说明，至少 20 字" placeholderTextColor={colors.subtle} style={styles.textarea} /><Pressable disabled={clarification.trim().length < 20 || mutating} onPress={onClarify} style={[styles.primary, (clarification.trim().length < 20 || mutating) && styles.disabled]}><Text style={styles.primaryText}>提交补充信息</Text></Pressable></View> : null}
    {error ? <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View> : null}
    <Pressable disabled={mutating} onPress={onRefresh} style={styles.secondary}>{mutating ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.secondaryText}>重新查询状态</Text>}</Pressable>
    {inquiry.allowedActions.includes('cancel') ? <Pressable disabled={mutating} onPress={onCancel} style={styles.cancel}><Text style={styles.cancelText}>取消询期</Text></Pressable> : null}
    <Text style={styles.disclosure}>询期结果由服务端状态确认；本阶段不会生成报价确认、订单或卡时冻结。</Text>
  </ScrollView>;
}

function dateTime(value: string, timeZone: string) {
  const formatted = formatZonedDateTime(value, timeZone);
  return formatted.date === '待选择' ? value : `${formatted.date} ${formatted.time}`;
}
function requirementLabel(value: ResourceInquiry['requirements']['environment']) { return ({ bare_metal: '裸金属', virtual_machine: '虚拟机', container: '容器', flexible: '可协商' })[value]; }
function networkLabel(value: ResourceInquiry['requirements']['network']) { return ({ public_internet: '公网', private_network: '私网', dedicated_line: '专线', flexible: '可协商' })[value]; }

const styles = StyleSheet.create({
  flex: { flex: 1 }, backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(17,24,39,0.34)' }, sheet: { height: '92%', borderTopLeftRadius: 22, borderTopRightRadius: 22, backgroundColor: colors.canvas, overflow: 'hidden' }, handle: { width: 38, height: 4, marginTop: 9, borderRadius: 2, alignSelf: 'center', backgroundColor: '#CAD2DC' }, heading: { minHeight: 76, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.line }, eyebrow: { color: colors.primary, fontSize: 9, fontWeight: '900' }, title: { color: colors.ink, fontSize: 21, fontWeight: '900', marginTop: 3 }, filtersRail: { height: 56, flexGrow: 0, flexShrink: 0 }, filtersScroll: { flexGrow: 0, height: 56 }, filters: { height: 56, gap: 7, paddingHorizontal: 15, alignItems: 'center' }, filter: { height: 36, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, filterActive: { backgroundColor: colors.primarySoft, borderColor: '#B7CEF4' }, filterText: { color: colors.muted, fontSize: 9, fontWeight: '700', textAlign: 'center' }, filterTextActive: { color: colors.primary, fontWeight: '900' }, list: { paddingHorizontal: 15, paddingBottom: 30, gap: 8 }, row: { padding: 13, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, rowTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 }, rowTitle: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '900' }, status: { color: colors.primary, fontSize: 8, fontWeight: '900', paddingHorizontal: 7, paddingVertical: 4, borderRadius: 7, backgroundColor: colors.primarySoft }, statusAttention: { color: colors.amber, backgroundColor: colors.amberSoft }, rowMeta: { color: colors.muted, fontSize: 9, marginTop: 6 }, rowTime: { color: colors.subtle, fontSize: 8, marginTop: 5 }, rowBottom: { marginTop: 10, paddingTop: 9, borderTopWidth: 1, borderTopColor: colors.line, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, number: { color: colors.muted, fontSize: 8 }, center: { flex: 1, minHeight: 260, padding: 28, alignItems: 'center', justifyContent: 'center' }, centerTitle: { color: colors.ink, fontSize: 15, fontWeight: '900', marginTop: 10 }, centerText: { color: colors.muted, fontSize: 10, lineHeight: 16, textAlign: 'center', marginTop: 6 }, empty: { minHeight: 180, alignItems: 'center', justifyContent: 'center', padding: 22 }, primary: { minHeight: 46, marginTop: 14, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 11, fontWeight: '900' }, secondary: { minHeight: 44, marginTop: 10, paddingHorizontal: 17, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, secondaryText: { color: colors.primary, fontSize: 10, fontWeight: '900' }, detail: { padding: 15, paddingBottom: 34 }, detailHero: { padding: 15, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: '#CFE0F8' }, detailTitle: { color: colors.ink, fontSize: 16, fontWeight: '900' }, detailRegion: { color: colors.muted, fontSize: 9, marginTop: 5 }, detailStatus: { color: colors.primary, fontSize: 10, fontWeight: '900', marginTop: 12 }, detailCard: { padding: 14, marginTop: 10, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, detailLine: { minHeight: 34, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line }, detailLabel: { color: colors.muted, fontSize: 9 }, detailValue: { flex: 1, color: colors.ink, fontSize: 9, fontWeight: '700', textAlign: 'right' }, blockTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' }, description: { color: colors.muted, fontSize: 10, lineHeight: 17, marginTop: 8 }, clarification: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.line }, textarea: { minHeight: 100, marginTop: 10, padding: 12, borderRadius: 9, color: colors.ink, fontSize: 11, textAlignVertical: 'top', borderWidth: 1, borderColor: colors.line, backgroundColor: colors.canvas }, disabled: { opacity: 0.4 }, cancel: { minHeight: 44, marginTop: 9, alignItems: 'center', justifyContent: 'center' }, cancelText: { color: colors.red, fontSize: 10, fontWeight: '800' }, disclosure: { color: colors.muted, fontSize: 8, lineHeight: 13, textAlign: 'center', marginTop: 10 }, error: { marginTop: 10, padding: 10, borderRadius: 9, backgroundColor: '#FDECEC' }, errorText: { color: colors.red, fontSize: 9 },
});
