import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { ResourceKind } from './api';
import { ApiError } from './api-client';
import {
  cancelDemand,
  createDemand,
  createResource,
  getSupplierProfile,
  listDemands,
  loadSupplierWorkspace,
  submitSupplier,
  type ComputeDemand,
  type ComputeResource,
  type SupplierProfile,
} from './publishing';
import { isAmbiguousMutationFailure, supplierSubmissionAccepted } from './mutation-recovery';
import { colors } from './theme';
import { compactDecimal } from './format';
import { providerResourceFormReady, supplierOnboardingFormReady } from './provider-onboarding';
import { gpuNodeSummary } from './compute-product';
import { resourceNodeCopy } from './resource-delivery-readiness';

export type PublishMode = 'buy' | 'sell' | 'supplier';

const kindOptions: Array<{ value: ResourceKind; label: string }> = [
  { value: 'gpu', label: 'GPU' },
  { value: 'token_capacity', label: 'Token' },
  { value: 'rack', label: '柜月' },
  { value: 'storage', label: '存储' },
  { value: 'apple_silicon', label: 'Apple' },
];

const profileStatus: Record<SupplierProfile['status'], string> = {
  draft: '资料草稿', submitted: '等待平台审核', approved: '资源伙伴已认证', rejected: '资料需重新提交', suspended: '供应资格已暂停',
};
const resourceStatus: Record<ComputeResource['status'], string> = {
  draft: '草稿', pending_verification: '待补审核材料', verified: '资料已核验', rejected: '核验未通过', suspended: '已暂停', retired: '已退役',
};

function resourceStatusLabel(resource: ComputeResource) {
  return resource.status === 'pending_verification' && resource.verification?.status === 'running'
    ? '审核中' : resourceStatus[resource.status];
}

function Field({ label, value, onChange, placeholder, keyboardType = 'default', multiline = false }: {
  label: string; value: string; onChange: (value: string) => void; placeholder: string;
  keyboardType?: 'default' | 'decimal-pad' | 'number-pad'; multiline?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.subtle}
        keyboardType={keyboardType}
        multiline={multiline}
        style={[styles.input, multiline && styles.multilineInput]}
      />
    </View>
  );
}

function KindPicker({ value, onChange }: { value: ResourceKind; onChange: (kind: ResourceKind) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.kindRow}>
      {kindOptions.map((item) => (
        <Pressable key={item.value} onPress={() => onChange(item.value)} style={[styles.kindChip, value === item.value && styles.kindChipActive]}>
          <Text style={[styles.kindText, value === item.value && styles.kindTextActive]}>{item.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

export function PublishFlowSheet({
  mode,
  authenticated,
  onModeChange,
  onClose,
  onLogin,
  onOpenResourceEvidence,
}: {
  mode: PublishMode | null;
  authenticated: boolean;
  onModeChange: (mode: PublishMode) => void;
  onClose: () => void;
  onLogin: () => void;
  onOpenResourceEvidence?: (resourceId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [requiresLogin, setRequiresLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [demands, setDemands] = useState<ComputeDemand[]>([]);
  const [profile, setProfile] = useState<SupplierProfile | null>(null);
  const [resources, setResources] = useState<ComputeResource[]>([]);
  const [createdResourceId, setCreatedResourceId] = useState<string | null>(null);

  const [demandKind, setDemandKind] = useState<ResourceKind>('gpu');
  const [demandTitle, setDemandTitle] = useState('');
  const [productHint, setProductHint] = useState('');
  const [demandRegion, setDemandRegion] = useState('');
  const [demandQuantity, setDemandQuantity] = useState('');
  const [demandUnit, setDemandUnit] = useState('GPU时');
  const [startDays, setStartDays] = useState('1');
  const [deadlineDays, setDeadlineDays] = useState('14');
  const [demandDescription, setDemandDescription] = useState('');

  const [legalName, setLegalName] = useState('');
  const [creditCode, setCreditCode] = useState('');
  const [contactName, setContactName] = useState('');

  const resourceKind: ResourceKind = 'gpu';
  const [productCode, setProductCode] = useState('');
  const [resourceRegion, setResourceRegion] = useState('');
  const [capacityTotal, setCapacityTotal] = useState('');
  const capacityUnit = 'GPU时';
  const [gpuCount, setGpuCount] = useState('8');
  const [gpuMemoryGiB, setGpuMemoryGiB] = useState('98');
  const [configuration, setConfiguration] = useState('');
  const [assetReference, setAssetReference] = useState('');
  const [assetIdentityKind, setAssetIdentityKind] = useState<'hardware_serial' | 'cloud_resource_id' | 'internal_asset_id'>('hardware_serial');
  const resourceRequestRef = useRef<{ signature: string; key: string } | null>(null);
  const actionInFlightRef = useRef(false);

  const loadWorkspace = async () => {
    const workspace = await loadSupplierWorkspace();
    setProfile(workspace.profile);
    setResources(workspace.resources);
  };

  const loadCurrentMode = async () => {
    if (!mode || !authenticated) return;
    setLoading(true);
    setError(null);
    setRequiresLogin(false);
    try {
      if (mode === 'buy') setDemands(await listDemands());
      else await loadWorkspace();
      setLoaded(true);
    } catch (reason) {
      setLoaded(false);
      setRequiresLogin(reason instanceof ApiError && reason.status === 401);
      setError(reason instanceof Error ? reason.message : '暂时无法读取发布状态。');
    } finally { setLoading(false); }
  };

  useEffect(() => {
    setLoaded(false);
    if (!mode || !authenticated) return;
    void loadCurrentMode();
  }, [authenticated, mode]);

  useEffect(() => {
    if (!authenticated || mode !== 'supplier' || profile?.status !== 'submitted') return;
    const timer = setInterval(() => {
      void loadWorkspace().catch(() => undefined);
    }, 10_000);
    return () => clearInterval(timer);
  }, [authenticated, mode, profile?.status]);

  useEffect(() => {
    if (!profile || !['draft', 'rejected'].includes(profile.status)) return;
    setLegalName((current) => current || profile.legalName);
    setContactName((current) => current || profile.contactName);
  }, [profile]);

  const withAction = async (action: () => Promise<void>) => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try { await action(); } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setLoaded(false);
        setRequiresLogin(true);
      }
      setError(reason instanceof Error ? reason.message : '提交失败，请稍后重试。');
    } finally { actionInFlightRef.current = false; setBusy(false); }
  };

  const publishDemand = () => withAction(async () => {
    const start = Number(startDays);
    const deadline = Number(deadlineDays);
    if (demandTitle.trim().length < 2 || productHint.trim().length < 1 || demandRegion.trim().length < 2
      || Number(demandQuantity) <= 0 || demandDescription.trim().length < 8
      || !Number.isFinite(start) || !Number.isFinite(deadline) || start < 0 || deadline <= start) {
      throw new Error('请完整填写任务、数量、地区、时间与至少 8 个字符的说明。');
    }
    const now = Date.now();
    const created = await createDemand({
      kind: demandKind, title: demandTitle.trim(), productHint: productHint.trim(), region: demandRegion.trim(),
      quantity: demandQuantity.trim(), capacityUnit: demandUnit.trim(),
      desiredStartAt: new Date(now + start * 86_400_000).toISOString(),
      deadlineAt: new Date(now + deadline * 86_400_000).toISOString(), description: demandDescription.trim(),
    });
    setDemands((current) => [created, ...current]);
    setSuccess('需求任务已发布，状态与后续匹配会留在消息时间线。');
    setDemandTitle(''); setDemandDescription('');
  });

  const registerSupplier = () => withAction(async () => {
    const code = creditCode.trim().toUpperCase();
    if (legalName.trim().length < 2 || !/^[0-9A-Z]{18}$/u.test(code) || contactName.trim().length < 1) {
      throw new Error('请填写企业名称、18 位统一社会信用代码和联系人。');
    }
    const input = { legalName: legalName.trim(), creditCode: code, contactName: contactName.trim() };
    let accepted: SupplierProfile;
    let recovered = false;
    try {
      accepted = await submitSupplier(input);
    } catch (reason) {
      if (!isAmbiguousMutationFailure(reason)) throw reason;
      const current = await getSupplierProfile().catch(() => null);
      if (!supplierSubmissionAccepted(input, current)) throw reason;
      accepted = current!; recovered = true;
    }
    setProfile(accepted);
    setSuccess(recovered
      ? '入驻资料已经提交，无需重复操作。审核结果会发到消息里。'
      : '入驻资料已提交。审核通过后即可提交资源资料核验。');
  });

  const publishResource = () => withAction(async () => {
    const reference = assetReference.trim();
    const parsedGpuCount = Number(gpuCount);
    const parsedGpuMemory = Number(gpuMemoryGiB);
    if (productCode.trim().length < 2 || resourceRegion.trim().length < 2 || Number(capacityTotal) <= 0
      || capacityUnit.trim().length < 1 || reference.length < 4 || resourceKind !== 'gpu'
      || !Number.isInteger(parsedGpuCount) || parsedGpuCount < 1 || parsedGpuCount > 64
      || !Number.isFinite(parsedGpuMemory) || parsedGpuMemory < 1) {
      throw new Error('请完整填写资产编号、资源型号、地区、容量和单位。');
    }
    const input = {
      kind: resourceKind, productCode: productCode.trim(), region: resourceRegion.trim(),
      specifications: {
        gpuCount: parsedGpuCount,
        memoryGiBPerGpu: parsedGpuMemory,
        ...(configuration.trim() ? { configuration: configuration.trim() } : {}),
      },
      capacityTotal: capacityTotal.trim(), capacityUnit: capacityUnit.trim(), assetReference: reference, assetIdentityKind,
    };
    const signature = JSON.stringify(input);
    if (resourceRequestRef.current?.signature !== signature) {
      resourceRequestRef.current = { signature, key: `resource-create-${Crypto.randomUUID()}` };
    }
    const result = await createResource(input, resourceRequestRef.current.key);
    const resource = { ...result.resource, verification: result.resource.verification ?? null };
    setResources((current) => [resource, ...current.filter((item) => item.id !== resource.id)]);
    setSuccess(result.recovered
      ? `识别到这份资源已经提交，已恢复「${result.resource.productCode}」的${resourceStatusLabel(result.resource)}进度。`
      : result.replayed
        ? '上次提交已经成功，当前展示的是同一份资源，不会重复创建。'
        : '资源已保存。请继续准备权属、配置和可用性材料。');
    setCreatedResourceId(resource.id);
    resourceRequestRef.current = null;
    if (onOpenResourceEvidence) {
      onOpenResourceEvidence(resource.id);
      return;
    }
    setAssetReference(''); setProductCode(''); setCapacityTotal(''); setConfiguration(''); setGpuCount('8'); setGpuMemoryGiB('98');
  });

  const removeDemand = (demand: ComputeDemand) => {
    Alert.alert('取消需求任务？', '取消后资源方将不再按这条任务匹配。', [
      { text: '保留', style: 'cancel' },
      { text: '确认取消', style: 'destructive', onPress: () => void withAction(async () => {
        const updated = await cancelDemand(demand.id);
        setDemands((current) => current.map((item) => item.id === updated.id ? updated : item));
      }) },
    ]);
  };

  const closeSafely = () => {
    if (actionInFlightRef.current) return;
    onClose();
  };

  if (!mode) return null;
  const titles = { buy: ['采购需求', '发布采购需求'], sell: ['算力资源', '发布闲置算力'], supplier: ['资源方入驻', '成为资源伙伴'] } as const;
  const supplierFormReady = supplierOnboardingFormReady({ legalName, creditCode, contactName });
  const resourceFormReady = providerResourceFormReady({
    assetReference, productCode, region: resourceRegion, capacityTotal, capacityUnit,
  }) && resourceKind === 'gpu' && Number.isInteger(Number(gpuCount)) && Number(gpuCount) >= 1 && Number(gpuCount) <= 64
    && Number.isFinite(Number(gpuMemoryGiB)) && Number(gpuMemoryGiB) >= 1;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={closeSafely}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View>
              <Text style={styles.eyebrow}>{titles[mode][0]}</Text>
              <Text style={styles.title}>{titles[mode][1]}</Text>
            </View>
            <Pressable disabled={busy} onPress={closeSafely} style={[styles.closeButton, busy && { opacity: 0.5 }]}><Ionicons name="close" size={23} color={colors.ink} /></Pressable>
          </View>

          {!authenticated ? (
            <View style={styles.loginGate}>
              <View style={styles.gateIcon}><Ionicons name="lock-closed-outline" size={32} color={colors.primary} /></View>
              <Text style={styles.gateTitle}>先确认你的 Zod 身份</Text>
              <Text style={styles.gateText}>主体资料、资源和上架进度都会绑定当前交易主体；登录后可在同一账号内切换。</Text>
              <Pressable onPress={() => { onClose(); onLogin(); }} style={styles.primaryButton}><Text style={styles.primaryText}>前往 KAI 统一登录</Text></Pressable>
            </View>
          ) : (
            <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} showsVerticalScrollIndicator={false}>
              {!loaded ? (
                <View style={styles.profileState}>
                  {loading ? <ActivityIndicator size="large" color={colors.primary} /> : <Ionicons name={requiresLogin ? 'lock-closed-outline' : 'cloud-offline-outline'} size={34} color={colors.primary} />}
                  <Text style={styles.profileStateTitle}>{loading ? '正在读取上架资料' : requiresLogin ? '请重新登录' : '没能读取上架资料'}</Text>
                  <Text style={styles.profileStateText}>{loading ? '请稍等。' : error ?? '请检查网络后重试，现有资料不会被修改。'}</Text>
                  {!loading ? <Pressable onPress={() => requiresLogin ? (onClose(), onLogin()) : void loadCurrentMode()} style={styles.primaryButton}><Text style={styles.primaryText}>{requiresLogin ? '重新登录' : '重新读取'}</Text></Pressable> : null}
                </View>
              ) : (
                <>
              {loading ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}
              {success ? <View style={styles.successBox}><Ionicons name="checkmark-circle" size={19} color={colors.green} /><Text style={styles.successText}>{success}</Text></View> : null}
              {error ? <View style={styles.errorBox}><Ionicons name="alert-circle-outline" size={19} color={colors.red} /><Text style={styles.errorText}>{error}</Text></View> : null}

              {mode === 'buy' ? (
                <>
                  <Text style={styles.sectionTitle}>任务类型</Text><KindPicker value={demandKind} onChange={setDemandKind} />
                  <Field label="一句话任务" value={demandTitle} onChange={setDemandTitle} placeholder="例如：两周内训练 70B 模型" />
                  <Field label="期望型号" value={productHint} onChange={setProductHint} placeholder="例如：H100 80G / 不限同级" />
                  <Field label="交付地区" value={demandRegion} onChange={setDemandRegion} placeholder="例如：华东-上海" />
                  <View style={styles.twoColumns}><View style={styles.column}><Field label="数量" value={demandQuantity} onChange={setDemandQuantity} placeholder="128" keyboardType="decimal-pad" /></View><View style={styles.column}><Field label="单位" value={demandUnit} onChange={setDemandUnit} placeholder="GPU时" /></View></View>
                  <View style={styles.twoColumns}><View style={styles.column}><Field label="几天后开始" value={startDays} onChange={setStartDays} placeholder="1" keyboardType="number-pad" /></View><View style={styles.column}><Field label="几天内完成" value={deadlineDays} onChange={setDeadlineDays} placeholder="14" keyboardType="number-pad" /></View></View>
                  <Field label="交付边界" value={demandDescription} onChange={setDemandDescription} placeholder="说明节点、互联、时段与验收要求" multiline />
                  <Pressable disabled={busy} onPress={publishDemand} style={styles.primaryButton}>{busy ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>发布真实需求任务</Text>}</Pressable>
                  {demands.length > 0 ? <Text style={styles.sectionTitle}>我的需求任务</Text> : null}
                  {demands.map((demand) => <View key={demand.id} style={styles.statusCard}><View style={styles.statusCopy}><Text style={styles.statusTitle}>{demand.title}</Text><Text style={styles.statusMeta}>{demand.quantity} {demand.capacityUnit} · {demand.region} · {demand.status === 'open' ? '匹配中' : demand.status}</Text></View>{demand.status === 'open' ? <Pressable onPress={() => removeDemand(demand)}><Text style={styles.cancelText}>取消</Text></Pressable> : null}</View>)}
                </>
              ) : null}

              {mode === 'supplier' ? (
                profile && !['rejected', 'draft'].includes(profile.status) ? (
                  <View style={styles.profileState}><Ionicons name={profile.status === 'approved' ? 'shield-checkmark' : profile.status === 'suspended' ? 'pause-circle-outline' : 'time-outline'} size={34} color={profile.status === 'approved' ? colors.green : profile.status === 'suspended' ? colors.amber : colors.primary} /><Text style={styles.profileStateTitle}>{profileStatus[profile.status]}</Text><Text style={styles.profileStateText}>{profile.legalName} · {profile.creditCode}</Text>{profile.status === 'suspended' ? <View style={styles.suspensionNotice}><Text style={styles.suspensionTitle}>暂停说明</Text><Text style={styles.suspensionText}>{profile.rejectionReason || '当前主体暂不能新增资源或挂牌。平台处理进展会通过消息通知。'}</Text></View> : null}{profile.status === 'approved' ? <Pressable onPress={() => onModeChange('sell')} style={styles.primaryButton}><Text style={styles.primaryText}>去发布闲置算力</Text></Pressable> : profile.status === 'submitted' ? <Pressable disabled={loading} onPress={() => void loadCurrentMode()} style={styles.secondaryButton}>{loading ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.secondaryText}>刷新审核状态</Text>}</Pressable> : null}</View>
                ) : (
                  <>
                    {profile?.status === 'rejected' ? <View style={styles.reviewNotice}><Ionicons name="alert-circle-outline" size={19} color={colors.red} /><View style={styles.reviewNoticeCopy}><Text style={styles.reviewNoticeTitle}>请按审核意见补充</Text><Text style={styles.reviewNoticeText}>{profile.rejectionReason || '主体资料未通过，请核对后重新提交。'}</Text></View></View> : null}
                    <Field label="企业/主体名称" value={legalName} onChange={setLegalName} placeholder="营业执照上的完整名称" />
                    <Field label="统一社会信用代码" value={creditCode} onChange={(value) => setCreditCode(value.toUpperCase().replace(/[^0-9A-Z]/gu, '').slice(0, 18))} placeholder={profile?.status === 'rejected' ? '请重新输入完整的 18 位代码' : '18 位代码'} />
                    <Field label="业务联系人" value={contactName} onChange={setContactName} placeholder="真实联系人姓名" />
                    <View style={styles.truthBox}><Ionicons name="shield-checkmark-outline" size={18} color={colors.primary} /><Text style={styles.truthText}>资料只用于主体审核；通过前不能发布资源或收取交易款项。</Text></View>
                    {!supplierFormReady ? <Text style={styles.formHint}>请填写完整主体名称、18 位统一社会信用代码和联系人。</Text> : null}
                    <Pressable disabled={busy || !supplierFormReady} onPress={registerSupplier} style={[styles.primaryButton, !supplierFormReady && styles.buttonDisabled]}>{busy ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>{profile?.status === 'rejected' ? '重新提交入驻审核' : '提交入驻审核'}</Text>}</Pressable>
                  </>
                )
              ) : null}

              {mode === 'sell' ? (
                !profile || profile.status !== 'approved' ? (
                  <View style={styles.profileState}><Ionicons name="business-outline" size={34} color={colors.primary} /><Text style={styles.profileStateTitle}>{profile ? profileStatus[profile.status] : '尚未提交资源伙伴资料'}</Text><Text style={styles.profileStateText}>完成主体审核后，才能提交资源资料核验。</Text><Pressable onPress={() => onModeChange('supplier')} style={styles.primaryButton}><Text style={styles.primaryText}>前往资源伙伴入驻</Text></Pressable></View>
                ) : (
                  <>
                    <Text style={styles.sectionTitle}>提交待核验资源</Text>
                    <View style={styles.resourceTypeLock}><View style={styles.resourceTypeIcon}><Ionicons name="hardware-chip-outline" size={20} color={colors.primary} /></View><View style={styles.resourceTypeCopy}><Text style={styles.resourceTypeTitle}>GPU 算力节点</Text><Text style={styles.resourceTypeText}>当前只开放单卡独享、按 GPU时自动交付的资源。</Text></View><Ionicons name="lock-closed" size={16} color={colors.primary} /></View>
                    <Text style={styles.fieldLabel}>资产编号类型</Text>
                    <View style={styles.identityKinds}>
                      {[['hardware_serial', '硬件序列号'], ['cloud_resource_id', '云资源 ID'], ['internal_asset_id', '企业内部编号']].map(([value, label]) => <Pressable key={value} onPress={() => setAssetIdentityKind(value as typeof assetIdentityKind)} style={[styles.identityKind, assetIdentityKind === value && styles.identityKindActive]}><Text style={[styles.identityKindText, assetIdentityKind === value && styles.identityKindTextActive]}>{label}</Text></Pressable>)}
                    </View>
                    <Field label={assetIdentityKind === 'hardware_serial' ? '设备序列号' : assetIdentityKind === 'cloud_resource_id' ? '云资源 ID' : '企业内部编号'} value={assetReference} onChange={setAssetReference} placeholder={assetIdentityKind === 'hardware_serial' ? '设备铭牌上的 SN / Serial Number' : assetIdentityKind === 'cloud_resource_id' ? '云平台实例或资源的唯一 ID' : '例如：SH-GPU-RACK03-NODE12'} />
                    <View style={styles.identityNote}><Ionicons name="finger-print-outline" size={17} color={colors.primary} /><Text style={styles.identityText}>只用于防止重复提交和核验权属。提交后不再回传或展示原值，服务端也只保存不可逆指纹。</Text></View>
                    <Field label="资源型号" value={productCode} onChange={setProductCode} placeholder="例如：NVIDIA H100 SXM5 98G" /><Field label="资源地区" value={resourceRegion} onChange={setResourceRegion} placeholder="例如：华东-上海" />
                    <View style={styles.twoColumns}><View style={styles.column}><Field label="节点 GPU 数" value={gpuCount} onChange={setGpuCount} placeholder="8" keyboardType="number-pad" /></View><View style={styles.column}><Field label="单卡显存（GB）" value={gpuMemoryGiB} onChange={setGpuMemoryGiB} placeholder="98" keyboardType="decimal-pad" /></View></View>
                    <View style={styles.twoColumns}><View style={styles.column}><Field label="可售总量（GPU时）" value={capacityTotal} onChange={setCapacityTotal} placeholder="800" keyboardType="decimal-pad" /></View><View style={styles.column}><View style={styles.lockedUnit}><Text style={styles.lockedUnitLabel}>计量单位</Text><Text style={styles.lockedUnitValue}>{capacityUnit}</Text><Text style={styles.lockedUnitHint}>1 张 GPU × 1 小时</Text></View></View></View>
                    <Text style={styles.capacityHint}>填写全部 GPU 的可售时长合计。例如 8 张卡各开放 100 小时，填写 800 GPU时。</Text>
                    <Field label="公开配置说明（可选）" value={configuration} onChange={setConfiguration} placeholder="显存、互联、网络等；不要填写密码或地址" multiline />
                    {!resourceFormReady ? <Text style={styles.formHint}>请填写资产编号、型号、地区、GPU 卡数、单卡显存和可售时长。</Text> : null}
                    <Pressable disabled={busy || !resourceFormReady} onPress={publishResource} style={[styles.primaryButton, !resourceFormReady && styles.buttonDisabled]}>{busy ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>保存资源，继续</Text>}</Pressable>
                    {createdResourceId && onOpenResourceEvidence ? <Pressable onPress={() => onOpenResourceEvidence(createdResourceId)} style={styles.materialButton}><Text style={styles.materialButtonText}>继续准备审核材料</Text><Ionicons name="arrow-forward" size={17} color={colors.primary} /></Pressable> : null}
                    {resources.length > 0 ? <Text style={styles.sectionTitle}>我的资源</Text> : null}
                    {resources.map((resource) => {
                      const nodeSummary = resource.kind === 'gpu' ? gpuNodeSummary(resource.specifications) : null;
                      const node = resourceNodeCopy(resource.deliveryReadiness);
                      return <View key={resource.id} style={styles.statusCard}><View style={styles.statusCopy}><Text style={styles.statusTitle}>{resource.productCode}</Text><Text style={styles.statusMeta}>{nodeSummary ? `${nodeSummary} · ` : ''}{compactDecimal(resource.capacityTotal)} {resource.capacityUnit} · {resource.region}</Text></View><View style={styles.resourceStates}><Text style={[styles.resourceState, resource.status === 'verified' && styles.resourceVerified]}>{resourceStatusLabel(resource)}</Text>{resource.status === 'verified' ? <Text style={[styles.nodeState, node.state === 'ready' && styles.nodeStateReady]}>节点{node.label}</Text> : null}</View></View>;
                    })}
                    {resources.some((resource) => resource.status === 'verified') ? <View style={styles.truthBox}><Ionicons name="analytics-outline" size={18} color={colors.primary} /><Text style={styles.truthText}>资料核验和节点交付状态是两件事。只有节点显示“可交付”，才能继续创建上架方案。</Text></View> : null}
                  </>
                )
              ) : null}
                </>
              )}
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.38)' }, sheet: { height: '94%', paddingHorizontal: 19, paddingTop: 10, paddingBottom: 24, borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: colors.canvas }, handle: { width: 42, height: 5, borderRadius: 3, alignSelf: 'center', backgroundColor: '#D4DDD7', marginBottom: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }, eyebrow: { color: colors.primary, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 }, title: { color: colors.ink, fontSize: 25, fontWeight: '900', marginTop: 3 }, closeButton: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, scroll: { flex: 1 }, content: { paddingBottom: 28 }, loader: { marginVertical: 16 },
  field: { marginBottom: 13 }, fieldLabel: { color: colors.ink, fontSize: 12, fontWeight: '800', marginBottom: 7 }, input: { minHeight: 52, paddingHorizontal: 14, color: colors.ink, fontSize: 14, borderWidth: 1, borderColor: colors.line, borderRadius: 16, backgroundColor: colors.surface }, multilineInput: { minHeight: 92, paddingTop: 13, textAlignVertical: 'top' },
  twoColumns: { flexDirection: 'row', gap: 10 }, column: { flex: 1 }, sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '900', marginTop: 13, marginBottom: 10 }, kindRow: { gap: 8, paddingBottom: 13 }, kindChip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }, kindChipActive: { backgroundColor: colors.primary, borderColor: colors.primary }, kindText: { color: colors.muted, fontSize: 12, fontWeight: '800' }, kindTextActive: { color: colors.surface },
  primaryButton: { minHeight: 50, marginTop: 5, marginBottom: 10, paddingHorizontal: 18, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 14, fontWeight: '900' },
  buttonDisabled: { opacity: 0.42 }, formHint: { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: -2, marginBottom: 7 },
  capacityHint: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: -5, marginBottom: 12 },
  reviewNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, padding: 13, marginBottom: 14, borderRadius: 14, backgroundColor: '#FDECEC' }, reviewNoticeCopy: { flex: 1 }, reviewNoticeTitle: { color: colors.red, fontSize: 12, fontWeight: '900' }, reviewNoticeText: { color: colors.red, fontSize: 11, lineHeight: 17, marginTop: 3 },
  secondaryButton: { minHeight: 48, marginTop: 14, paddingHorizontal: 18, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#B9D2F7', backgroundColor: colors.surface }, secondaryText: { color: colors.primary, fontSize: 13, fontWeight: '900' },
  materialButton: { minHeight: 48, marginBottom: 10, paddingHorizontal: 16, borderRadius: 16, borderWidth: 1, borderColor: '#B9D2F7', flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, materialButtonText: { color: colors.primary, fontSize: 13, fontWeight: '900' },
  successBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 13, marginBottom: 12, borderRadius: 14, backgroundColor: colors.greenSoft }, successText: { flex: 1, color: colors.greenDark, fontSize: 12, lineHeight: 18 }, errorBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 13, marginBottom: 12, borderRadius: 14, backgroundColor: '#FDECEC' }, errorText: { flex: 1, color: colors.red, fontSize: 12, lineHeight: 18 },
  loginGate: { marginTop: 30, padding: 28, alignItems: 'center', borderRadius: 24, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, gateIcon: { width: 70, height: 70, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, gateTitle: { color: colors.ink, fontSize: 19, fontWeight: '900', marginTop: 16 }, gateText: { color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 7 },
  statusCard: { minHeight: 72, flexDirection: 'row', alignItems: 'center', padding: 14, marginBottom: 9, borderRadius: 17, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }, statusCopy: { flex: 1 }, statusTitle: { color: colors.ink, fontSize: 14, fontWeight: '900' }, statusMeta: { color: colors.muted, fontSize: 10, marginTop: 4 }, cancelText: { color: colors.red, fontSize: 12, fontWeight: '800' }, resourceStates: { alignItems: 'flex-end', gap: 5 }, resourceState: { color: colors.amber, fontSize: 11, fontWeight: '900' }, resourceVerified: { color: colors.green, fontSize: 11, fontWeight: '900' }, nodeState: { color: colors.amber, fontSize: 9, fontWeight: '900' }, nodeStateReady: { color: colors.green },
  profileState: { padding: 28, alignItems: 'center', borderRadius: 22, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, profileStateTitle: { color: colors.ink, fontSize: 19, fontWeight: '900', marginTop: 13 }, profileStateText: { color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 6 }, truthBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 13, marginBottom: 10, borderRadius: 14, backgroundColor: colors.primarySoft }, truthText: { flex: 1, color: colors.primaryDark, fontSize: 11, lineHeight: 17 },
  suspensionNotice: { width: '100%', padding: 13, marginTop: 15, borderRadius: 14, backgroundColor: colors.amberSoft }, suspensionTitle: { color: colors.amber, fontSize: 11, fontWeight: '900' }, suspensionText: { color: colors.ink, fontSize: 11, lineHeight: 18, marginTop: 4 },
  identityNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, paddingHorizontal: 11, paddingVertical: 10, marginTop: -5, marginBottom: 13, borderRadius: 13, backgroundColor: colors.primarySoft }, identityText: { flex: 1, color: colors.primaryDark, fontSize: 10, lineHeight: 16 },
  identityKinds: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: -1, marginBottom: 13 }, identityKind: { paddingHorizontal: 11, paddingVertical: 8, borderWidth: 1, borderColor: colors.line, borderRadius: 999, backgroundColor: colors.surface }, identityKindActive: { borderColor: colors.primary, backgroundColor: colors.primary }, identityKindText: { color: colors.muted, fontSize: 10, fontWeight: '800' }, identityKindTextActive: { color: colors.surface },
  resourceTypeLock: { minHeight: 70, padding: 12, marginBottom: 15, borderWidth: 1, borderColor: '#B9D2F7', borderRadius: 17, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primarySoft }, resourceTypeIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, resourceTypeCopy: { flex: 1, marginHorizontal: 10 }, resourceTypeTitle: { color: colors.primaryDark, fontSize: 12, fontWeight: '900' }, resourceTypeText: { color: colors.muted, fontSize: 9, lineHeight: 15, marginTop: 3 }, lockedUnit: { minHeight: 79, marginBottom: 13, padding: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 16, backgroundColor: colors.primarySoft }, lockedUnitLabel: { color: colors.ink, fontSize: 12, fontWeight: '800' }, lockedUnitValue: { color: colors.primaryDark, fontSize: 16, fontWeight: '900', marginTop: 7 }, lockedUnitHint: { color: colors.muted, fontSize: 8, marginTop: 2 },
});
