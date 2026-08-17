import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet,
  Text, TextInput, View,
} from 'react-native';
import { ApiError } from './api-client';
import {
  createOfferDraft, createOfferRevision, getOfferDraft, getOfferRevision, listOfferDrafts, listSupplierListings,
  listSupplierOffers, loadSupplierWorkspace,
  getSupplierOffer, saveOfferDraft, saveOfferRevision, submitOfferDraft, submitOfferRevision, type ComputeResource,
  type OfferRevisionDraft, type OfferWizardDraft, type OfferWizardPayload, type OfferWizardStep,
} from './publishing';
import {
  draftSaveAccepted, isAmbiguousMutationFailure, revisionSubmissionAccepted, unknownSubmissionMessage, wizardSubmissionAccepted,
} from './mutation-recovery';
import { colors } from './theme';
import { compactDecimal, creditAmount } from './format';
import {
  commonDeliveryTerms, draftPriceEvidence, normalizeCreditInput, shouldClearFormErrorOnEdit,
  validateOfferWizardStep,
} from './offer-wizard-form';
import { dedicatedGpuServiceTitle, gpuNodeSummary, nodeGpuCount } from './compute-product';
import { resourceIsDeliverable } from './resource-delivery-readiness';

type Form = {
  title: string;
  serviceMode: NonNullable<OfferWizardPayload['serviceMode']>;
  minimumQuantity: string;
  availability: string;
  delivery: string;
  acceptance: string;
  refund: string;
  cleanup: string;
  suggestedUnitCredits: string;
  priceComponents: string;
  evidenceType: 'contract' | 'invoice' | 'market_quote' | 'cost_breakdown';
  evidenceSource: string;
  evidenceSummary: string;
};

const emptyForm: Form = {
  title: '', serviceMode: 'dedicated', minimumQuantity: '1', availability: '', delivery: '', acceptance: '',
  refund: '', cleanup: '', suggestedUnitCredits: '', priceComponents: '', evidenceType: 'contract',
  evidenceSource: '', evidenceSummary: '',
};

const steps: Array<{ key: OfferWizardStep; label: string; caption: string }> = [
  { key: 'service', label: '服务', caption: '怎么卖' },
  { key: 'terms', label: '边界', caption: '怎么交付' },
  { key: 'price', label: '价格', caption: '凭什么值' },
  { key: 'review', label: '确认', caption: '进入双审' },
];

const evidenceOptions: Array<{ value: Form['evidenceType']; label: string }> = [
  { value: 'contract', label: '成交合同' }, { value: 'invoice', label: '发票' },
  { value: 'market_quote', label: '市场报价' }, { value: 'cost_breakdown', label: '成本拆分' },
];

type EditableOfferDraft = OfferWizardDraft | OfferRevisionDraft;

function formFromDraft(draft: EditableOfferDraft): Form {
  const payload = draft.payload;
  const evidence = payload.priceEvidence?.[0];
  const value = (record: Record<string, unknown> | undefined, key: string) => typeof record?.[key] === 'string' ? String(record[key]) : '';
  return {
    ...emptyForm,
    title: payload.title ? dedicatedGpuServiceTitle(payload.title) : '', serviceMode: 'dedicated', minimumQuantity: payload.minimumQuantity ?? '1',
    availability: value(payload.sla, 'availability'), delivery: value(payload.deliveryTerms, 'summary'),
    acceptance: value(payload.acceptanceTerms, 'summary'), refund: value(payload.refundTerms, 'summary'),
    cleanup: value(payload.cleanupTerms, 'summary'), suggestedUnitCredits: payload.suggestedUnitCredits ?? '',
    priceComponents: value(payload.priceComponents, 'summary'), evidenceType: evidence?.type ?? 'contract',
    evidenceSource: evidence?.source ?? '', evidenceSummary: evidence?.summary ?? '',
  };
}

function payloadFromForm(form: Form, capacityUnit: string, previous: OfferWizardPayload = {}): OfferWizardPayload {
  const record = (original: Record<string, unknown> | undefined, key: string, value: string) => {
    const next = { ...original };
    if (value.trim()) next[key] = value.trim(); else delete next[key];
    return next;
  };
  const firstEvidence = previous.priceEvidence?.[0];
  return {
    title: form.title, serviceMode: 'dedicated', nativeUnit: capacityUnit, minimumQuantity: form.minimumQuantity,
    sla: record(previous.sla, 'availability', form.availability),
    deliveryTerms: record(previous.deliveryTerms, 'summary', form.delivery),
    acceptanceTerms: record(previous.acceptanceTerms, 'summary', form.acceptance),
    refundTerms: record(previous.refundTerms, 'summary', form.refund),
    cleanupTerms: record(previous.cleanupTerms, 'summary', form.cleanup),
    suggestedUnitCredits: form.suggestedUnitCredits,
    priceComponents: record(record(previous.priceComponents, 'summary', form.priceComponents), 'proposedUnitCredits', form.suggestedUnitCredits),
    priceEvidence: [
      ...draftPriceEvidence(form.evidenceType, form.evidenceSource, form.evidenceSummary, firstEvidence),
      ...(previous.priceEvidence?.slice(1) ?? []),
    ],
  };
}

function isRevisionDraft(value: EditableOfferDraft): value is OfferRevisionDraft {
  return 'offerId' in value && typeof value.offerId === 'string';
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
    result[key] = stableValue((value as Record<string, unknown>)[key]);
    return result;
  }, {});
}

function draftHasChanges(draft: EditableOfferDraft, step: OfferWizardStep, payload: OfferWizardPayload) {
  return draft.currentStep !== step || JSON.stringify(stableValue(draft.payload)) !== JSON.stringify(stableValue(payload));
}

async function saveDefaultOfferTitle(draft: OfferWizardDraft, resource: ComputeResource) {
  if (draft.payload.title?.trim()) return draft;
  const form = { ...formFromDraft(draft), title: dedicatedGpuServiceTitle(resource.productCode), serviceMode: 'dedicated' as const };
  return saveOfferDraft(draft.id, {
    expectedVersion: draft.version,
    currentStep: draft.currentStep,
    payload: payloadFromForm(form, draft.resource.capacityUnit, draft.payload),
  });
}

function serviceSummary(form: Form) {
  return /(?:单卡|整卡).*独享/u.test(form.title) ? form.title : `${form.title} · 单卡独享`;
}

function Field({ label, value, onChange, placeholder, multiline = false, decimal = false, hint }: Readonly<{
  label: string; value: string; onChange: (value: string) => void; placeholder: string; multiline?: boolean; decimal?: boolean; hint?: string;
}>) {
  return <View style={styles.field}>
    <View style={styles.fieldHeading}><Text style={styles.fieldLabel}>{label}</Text>{hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}</View>
    <TextInput
      accessibilityLabel={label} testID={`offer-field-${label}`}
      value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={colors.subtle}
      keyboardType={decimal ? 'decimal-pad' : 'default'} multiline={multiline}
      returnKeyType={multiline ? 'default' : 'done'} submitBehavior={multiline ? 'newline' : 'blurAndSubmit'}
      style={[styles.input, multiline && styles.multiline]} maxLength={multiline ? 1000 : 120}
    />
  </View>;
}

export function OfferWizardSheet({ visible, resumeDraftId, initialResourceId, revisionOfferId, onClose, onSubmitted }: Readonly<{
  visible: boolean; resumeDraftId?: string | null; initialResourceId?: string | null; revisionOfferId?: string | null;
  onClose: () => void; onSubmitted: () => void | Promise<void>;
}>) {
  const [loading, setLoading] = useState(false);
  const [resources, setResources] = useState<ComputeResource[]>([]);
  const [verifiedResourceCount, setVerifiedResourceCount] = useState(0);
  const [deliverableResourceCount, setDeliverableResourceCount] = useState(0);
  const [draft, setDraftState] = useState<EditableOfferDraft | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [step, setStep] = useState<OfferWizardStep>('service');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'conflict' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reload, setReload] = useState(0);
  const hydratedRef = useRef(false);
  const draftRef = useRef<EditableOfferDraft | null>(null);
  const desiredRef = useRef<{ step: OfferWizardStep; payload: OfferWizardPayload } | null>(null);
  const savingRef = useRef(false);
  const drainPromiseRef = useRef<Promise<EditableOfferDraft | null> | null>(null);
  const submitAttemptRef = useRef<{ fingerprint: string; requestId: string; expectedVersion: number } | null>(null);
  const submitInFlightRef = useRef(false);
  const formScrollRef = useRef<ScrollView>(null);

  const setDraft = useCallback((value: EditableOfferDraft | null) => {
    draftRef.current = value;
    setDraftState(value);
  }, []);

  const hydrate = useCallback((value: EditableOfferDraft) => {
    hydratedRef.current = false;
    setDraft(value); setForm(formFromDraft(value)); setStep(value.currentStep); setSaveState('saved');
    requestAnimationFrame(() => { hydratedRef.current = true; });
  }, [setDraft]);

  useEffect(() => {
    if (!visible) {
      hydratedRef.current = false; desiredRef.current = null; setDraft(null); setForm(emptyForm); setError(null); setSaveState('idle');
      submitAttemptRef.current = null; submitInFlightRef.current = false; setClosing(false);
      return;
    }
    setLoading(true); setError(null); setResources([]); setVerifiedResourceCount(0); setDeliverableResourceCount(0);
    if (revisionOfferId) {
      void createOfferRevision(revisionOfferId, `offer-revision-${Crypto.randomUUID()}`)
        .then(hydrate)
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '没有读取到需要修改的上架方案。'))
        .finally(() => setLoading(false));
      return;
    }
    void Promise.all([loadSupplierWorkspace(), listOfferDrafts(), listSupplierOffers(), listSupplierListings()])
      .then(async ([workspace, drafts, offers, listings]) => {
        const verified = workspace.resources.filter((item) => item.status === 'verified');
        const deliverable = verified.filter((item) => resourceIsDeliverable(item.deliveryReadiness));
        setVerifiedResourceCount(verified.length);
        setDeliverableResourceCount(deliverable.length);
        const occupiedResourceIds = new Set([
          ...drafts.map((item) => item.resourceId),
          ...offers.map((item) => item.resourceId),
          ...listings.filter((item) => ['active', 'paused', 'sold_out'].includes(item.status))
            .map((item) => item.resourceId),
        ]);
        setResources(deliverable.filter((resource) => !occupiedResourceIds.has(resource.id)));
        if (resumeDraftId) { hydrate(await getOfferDraft(resumeDraftId)); return; }
        if (initialResourceId) {
          const existing = drafts.find((item) => item.resourceId === initialResourceId);
          if (existing) { hydrate(existing); return; }
          const resource = deliverable.find((item) => item.id === initialResourceId);
          if (!resource) throw new Error(verified.some((item) => item.id === initialResourceId)
            ? '这项资源的资料已核验，但节点还不可交付。节点恢复后再创建上架方案。'
            : '这项资源的资料尚未通过核验，不能创建上架方案。');
          const created = await createOfferDraft(resource.id, `wizard-create-${Crypto.randomUUID()}`);
          hydrate(await saveDefaultOfferTitle(created, resource));
          return;
        }
        if (drafts[0]) hydrate(drafts[0]);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '暂时无法读取上架草稿。'))
      .finally(() => setLoading(false));
  }, [hydrate, initialResourceId, reload, resumeDraftId, revisionOfferId, setDraft, visible]);

  const drain = useCallback((): Promise<EditableOfferDraft | null> => {
    if (drainPromiseRef.current) return drainPromiseRef.current;
    if (!draftRef.current) return Promise.resolve(null);
    const pending = Promise.resolve().then(async () => {
      savingRef.current = true;
      let failed = false;
      try {
        while (desiredRef.current && draftRef.current) {
          const desired = desiredRef.current; desiredRef.current = null; setSaveState('saving');
          const current = draftRef.current;
          try {
            const saved = isRevisionDraft(current)
              ? await saveOfferRevision(current.offerId, {
                expectedVersion: current.version, currentStep: desired.step, payload: desired.payload,
              })
              : await saveOfferDraft(current.id, {
              expectedVersion: current.version, currentStep: desired.step, payload: desired.payload,
              });
            setDraft(saved); setSaveState('saved');
          } catch (reason) {
            const uncertain = isAmbiguousMutationFailure(reason) || (reason instanceof ApiError && reason.status === 409);
            if (uncertain) {
              try {
                const latest = isRevisionDraft(current)
                  ? await getOfferRevision(current.offerId)
                  : await getOfferDraft(current.id);
                if (draftSaveAccepted(current, desired, latest)) {
                  setDraft(latest); setSaveState('saved');
                  continue;
                }
                if (reason instanceof ApiError && reason.status === 409) {
                  desiredRef.current = null;
                  setSaveState('conflict');
                  setError('这份方案已经更新，请重新打开后继续。');
                  failed = true;
                  break;
                }
              } catch { /* The form stays in memory and can be retried explicitly. */ }
            }
            desiredRef.current = null;
            setSaveState('error');
            setError(isAmbiguousMutationFailure(reason)
              ? '网络中断，当前内容仍在页面。恢复网络后点“未保存”重试。'
              : reason instanceof Error ? reason.message : '暂时没有保存成功，请再试一次。');
            failed = true;
            break;
          }
        }
        return failed ? null : draftRef.current;
      } finally {
        savingRef.current = false;
      }
    }).finally(() => {
      drainPromiseRef.current = null;
      if (desiredRef.current) queueMicrotask(() => { void drain(); });
    });
    drainPromiseRef.current = pending;
    return pending;
  }, [setDraft]);

  const flush = useCallback(async () => {
    let latest = draftRef.current;
    do {
      latest = await drain();
      if (!latest) return null;
    } while (desiredRef.current || drainPromiseRef.current);
    return latest;
  }, [drain]);

  const retrySave = useCallback(() => {
    const current = draftRef.current;
    if (!current || savingRef.current || saveState === 'conflict') return;
    desiredRef.current = {
      step,
      payload: payloadFromForm(form, current.resource.capacityUnit, current.payload),
    };
    setError(null); setSaveState('idle'); void drain();
  }, [drain, form, saveState, step]);

  useEffect(() => {
    if (!visible || !draft || !hydratedRef.current || saveState === 'conflict') return;
    const payload = payloadFromForm(form, draft.resource.capacityUnit, draft.payload);
    if (!draftHasChanges(draft, step, payload)) { setSaveState('saved'); return; }
    desiredRef.current = { step, payload };
    setSaveState('idle');
    const timer = setTimeout(() => { void drain(); }, 850);
    return () => clearTimeout(timer);
  }, [draft?.id, drain, form, step, visible]);

  useEffect(() => {
    if (!visible || !draft || !hydratedRef.current) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' || !draftRef.current || !hydratedRef.current) return;
      const payload = payloadFromForm(form, draft.resource.capacityUnit, draft.payload);
      if (!draftHasChanges(draftRef.current, step, payload)) return;
      desiredRef.current = { step, payload };
      void drain();
    });
    return () => subscription.remove();
  }, [draft, drain, form, step, visible]);

  const exitWithoutSaving = useCallback(() => {
    if (submitInFlightRef.current) return;
    desiredRef.current = null;
    submitAttemptRef.current = null;
    hydratedRef.current = false;
    onClose();
  }, [onClose]);

  const reloadLatest = useCallback(async () => {
    const current = draftRef.current;
    if (!current || loading || submitInFlightRef.current) return;
    desiredRef.current = null;
    submitAttemptRef.current = null;
    hydratedRef.current = false;
    setLoading(true); setError(null);
    try {
      const latest = isRevisionDraft(current)
        ? await getOfferRevision(current.offerId)
        : await getOfferDraft(current.id);
      hydrate(latest);
    } catch (reason) {
      setSaveState('conflict');
      setError(reason instanceof Error ? reason.message : '暂时没能读取最新方案，请再试一次。');
    } finally {
      setLoading(false);
    }
  }, [hydrate, loading]);

  const promptConflictResolution = useCallback(() => {
    Alert.alert('这份方案已更新', '当前页面的内容不会自动覆盖最新版本。你可以重新读取，或者直接退出。', [
      { text: '继续留在此页', style: 'cancel' },
      { text: '退出不覆盖', style: 'destructive', onPress: exitWithoutSaving },
      { text: '重新读取', onPress: () => { void reloadLatest(); } },
    ]);
  }, [exitWithoutSaving, reloadLatest]);

  const closeSafely = useCallback(async () => {
    if (closing || submitInFlightRef.current) return;
    if (!draftRef.current || !hydratedRef.current) { onClose(); return; }
    if (saveState === 'conflict') {
      promptConflictResolution();
      return;
    }
    setClosing(true); setError(null);
    const payload = payloadFromForm(form, draftRef.current.resource.capacityUnit, draftRef.current.payload);
    if (!draftHasChanges(draftRef.current, step, payload)) { onClose(); return; }
    desiredRef.current = { step, payload };
    const saved = await flush();
    if (!saved) {
      setClosing(false);
      Alert.alert('还没有保存成功', '请检查网络后再关闭，当前填写内容仍保留在页面中。');
      return;
    }
    onClose();
  }, [closing, flush, form, onClose, promptConflictResolution, saveState, step]);

  const chooseResource = async (resource: ComputeResource) => {
    if (!resourceIsDeliverable(resource.deliveryReadiness)) {
      setError('节点尚未达到可交付状态，现在不能创建上架方案。');
      return;
    }
    setLoading(true); setError(null);
    try {
      const created = await createOfferDraft(resource.id, `wizard-create-${Crypto.randomUUID()}`);
      hydrate(await saveDefaultOfferTitle(created, resource));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法创建上架草稿。'); }
    finally { setLoading(false); }
  };

  const index = steps.findIndex((item) => item.key === step);
  const update = <Key extends keyof Form>(key: Key, value: Form[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (shouldClearFormErrorOnEdit(saveState)) setError(null);
  };
  const validation = validateOfferWizardStep(step, form);

  const next = () => {
    if (validation) { setError(validation); return; }
    const target = steps[Math.min(index + 1, steps.length - 1)]!.key;
    Keyboard.dismiss(); setError(null); setStep(target);
    requestAnimationFrame(() => formScrollRef.current?.scrollTo({ y: 0, animated: false }));
    if (draftRef.current) {
      desiredRef.current = { step: target, payload: payloadFromForm(form, draftRef.current.resource.capacityUnit, draftRef.current.payload) };
      setSaveState('idle'); void drain();
    }
    void Haptics.selectionAsync();
  };
  const previous = () => {
    const target = steps[Math.max(index - 1, 0)]!.key;
    Keyboard.dismiss(); setError(null); setStep(target);
    requestAnimationFrame(() => formScrollRef.current?.scrollTo({ y: 0, animated: false }));
    if (draftRef.current) {
      desiredRef.current = { step: target, payload: payloadFromForm(form, draftRef.current.resource.capacityUnit, draftRef.current.payload) };
      setSaveState('idle'); void drain();
    }
  };

  const useCommonTerms = () => {
    if (!draft) return;
    const terms = commonDeliveryTerms(draft.resource.name);
    setForm((current) => ({ ...current, ...terms }));
    setError(null); void Haptics.selectionAsync();
  };

  const submit = async () => {
    if (!draft || submitInFlightRef.current) return;
    if (savingRef.current) { setError('正在保存最新内容，保存完成后再确认提交。'); return; }
    submitInFlightRef.current = true;
    setSubmitting(true); setError(null);
    const submitPayload = payloadFromForm(form, draft.resource.capacityUnit, draft.payload);
    const fingerprint = JSON.stringify(submitPayload);
    let submittedDraft: EditableOfferDraft | null = null;
    const showSubmitted = () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('已提交', revision
        ? '修改已经提交，资源和价格会重新审核，结果会发到消息里。'
        : '资源和价格会分别审核，结果会发到消息里。', [{
        text: '知道了', onPress: () => { onClose(); void onSubmitted(); },
      }]);
    };
    try {
      const existingAttempt = submitAttemptRef.current?.fingerprint === fingerprint ? submitAttemptRef.current : null;
      let latest = draftRef.current;
      if (!existingAttempt) {
        desiredRef.current = { step: 'review', payload: submitPayload };
        latest = await flush();
      }
      if (!latest) return;
      submittedDraft = latest;
      const requestId = existingAttempt?.requestId
        ?? `${isRevisionDraft(latest) ? 'revision' : 'wizard'}-submit-${Crypto.randomUUID()}`;
      const expectedVersion = existingAttempt?.expectedVersion ?? latest.version;
      submitAttemptRef.current = { fingerprint, requestId, expectedVersion };
      if (isRevisionDraft(latest)) {
        await submitOfferRevision(latest.offerId, expectedVersion, requestId);
      } else {
        await submitOfferDraft(latest.id, expectedVersion, requestId);
      }
      showSubmitted();
    } catch (reason) {
      if (submittedDraft && isAmbiguousMutationFailure(reason)) {
        try {
          const accepted = isRevisionDraft(submittedDraft)
            ? revisionSubmissionAccepted(submittedDraft, await getSupplierOffer(submittedDraft.offerId))
            : wizardSubmissionAccepted(await getOfferDraft(submittedDraft.id));
          if (accepted) { showSubmitted(); return; }
        } catch { /* Keep the original unknown result and the same idempotency key. */ }
        setError(unknownSubmissionMessage);
      } else setError(reason instanceof Error ? reason.message : '提交审核失败，请稍后重试。');
    }
    finally { submitInFlightRef.current = false; setSubmitting(false); }
  };

  const revision = draft && isRevisionDraft(draft) ? draft : null;
  const currentResource = draft ? resources.find((resource) => resource.id === draft.resourceId) : null;
  const currentNodeGpuCount = currentResource ? nodeGpuCount(currentResource.specifications) : null;
  const handleRequestClose = () => {
    if (Keyboard.isVisible()) { Keyboard.dismiss(); return; }
    void closeSafely();
  };
  return <Modal visible={visible} animationType="slide" transparent onRequestClose={handleRequestClose}>
    <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <View><Text style={styles.eyebrow}>算力上架</Text><Text style={styles.title}>{revisionOfferId ? '修改上架方案' : '上架方案'}</Text></View>
          <View style={styles.headerActions}>
            {draft ? <Pressable accessibilityLabel={saveState === 'error' ? '重新保存上架方案' : '上架方案保存状态'} disabled={saveState !== 'error'} onPress={retrySave} style={[styles.savePill, saveState === 'error' || saveState === 'conflict' ? styles.savePillError : null]}>
              <Ionicons name={saveState === 'saving' ? 'cloud-upload-outline' : saveState === 'saved' ? 'cloud-done-outline' : 'ellipse-outline'} size={14} color={saveState === 'error' || saveState === 'conflict' ? colors.red : saveState === 'saved' ? colors.green : colors.primary} />
              <Text style={[styles.saveText, saveState === 'error' || saveState === 'conflict' ? styles.saveTextError : null]}>{saveState === 'saving' ? '保存中' : saveState === 'saved' ? '已保存' : saveState === 'conflict' ? '版本冲突' : saveState === 'error' ? '未保存' : '待保存'}</Text>
            </Pressable> : null}
            <Pressable accessibilityLabel="保存并退出上架方案" disabled={closing || submitting} onPress={() => void closeSafely()} style={[styles.close, (closing || submitting) && styles.buttonDisabled]}>
              {closing ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name="close" size={23} color={colors.ink} />}
            </Pressable>
          </View>
        </View>

        {loading ? <View style={styles.center}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>正在读取上架进度…</Text></View> : null}
        {!loading && !draft ? <ScrollView contentContainerStyle={styles.resourceContent}>
          <View style={styles.resourceHero}><Ionicons name="cube-outline" size={30} color={colors.primary} /><Text style={styles.resourceTitle}>选择可交付的资源</Text><Text style={styles.resourceCaption}>资料已核验且节点在线后，才能创建上架方案。</Text></View>
          {error ? <ErrorBox text={error} /> : null}
          {error ? <Pressable onPress={() => setReload((value) => value + 1)} style={styles.retryButton}><Text style={styles.retryText}>重新读取</Text></Pressable> : null}
          {resources.map((resource) => {
            const nodeSummary = resource.kind === 'gpu' ? gpuNodeSummary(resource.specifications) : null;
            return <Pressable key={resource.id} onPress={() => void chooseResource(resource)} style={styles.resourceCard}>
              <View style={styles.resourceIcon}><Text style={styles.resourceInitial}>{resource.productCode.slice(0, 1)}</Text></View>
              <View style={styles.resourceCopy}><Text style={styles.resourceName}>{resource.productCode}</Text><Text style={styles.resourceMeta}>{resource.region}{nodeSummary ? ` · ${nodeSummary}` : ''} · 可售总量 {compactDecimal(resource.capacityTotal)} {resource.capacityUnit}</Text></View>
              <Ionicons name="arrow-forward-circle" size={25} color={colors.primary} />
            </Pressable>;
          })}
          {resources.length === 0 && !error ? <View style={styles.empty}><Ionicons name={deliverableResourceCount > 0 ? 'storefront-outline' : verifiedResourceCount > 0 ? 'cloud-offline-outline' : 'shield-outline'} size={30} color={colors.amber} /><Text style={styles.emptyTitle}>{deliverableResourceCount > 0 ? '可交付资源都有上架任务' : verifiedResourceCount > 0 ? '节点还没准备好' : '还没有资料已核验的资源'}</Text><Text style={styles.emptyText}>{deliverableResourceCount > 0 ? '请从上架进度继续草稿、审核或挂牌管理，不需要重复创建方案。' : verifiedResourceCount > 0 ? '资料已核验，但节点尚未显示“可交付”。请先完成节点接入和在线检查。' : '资源资料通过核验后，还需要节点在线才能填写上架方案。'}</Text></View> : null}
        </ScrollView> : null}

        {!loading && draft ? <>
          <View style={styles.stepBar}>{steps.map((item, itemIndex) => <View key={item.key} style={styles.stepItem}>
            <View style={[styles.stepDot, itemIndex <= index && styles.stepDotActive]}>{itemIndex < index ? <Ionicons name="checkmark" size={12} color={colors.surface} /> : <Text style={[styles.stepNumber, itemIndex <= index && styles.stepNumberActive]}>{itemIndex + 1}</Text>}</View>
            <Text style={[styles.stepLabel, itemIndex === index && styles.stepLabelActive]}>{item.label}</Text>
          </View>)}</View>
          <ScrollView ref={formScrollRef} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} showsVerticalScrollIndicator={false}>
            <View style={styles.assetStrip}><View><Text style={styles.assetEyebrow}>资料已核验</Text><Text style={styles.assetName}>{draft.resource.name}</Text></View><Text style={styles.assetUnit}>{draft.resource.capacityUnit}</Text></View>
            {revision?.reviewFeedback.map((feedback) => feedback.returnStep === step || step === 'review' ? (
              <View key={`${feedback.kind}-${feedback.returnStep}`} style={styles.feedbackBox}>
                <View style={styles.feedbackTop}><Ionicons name="chatbox-ellipses-outline" size={18} color={colors.red} /><Text style={styles.feedbackTitle}>{feedback.kind === 'price' ? '价格审核意见' : '资源审核意见'}</Text></View>
                <Text style={styles.feedbackReason}>{feedback.reason ?? '请按审核要求修改这一部分。'}</Text>
                {feedback.summary ? <Text style={styles.feedbackSummary}>{feedback.summary}</Text> : null}
              </View>
            ) : null)}
            {error && saveState !== 'conflict' ? <ErrorBox text={error} /> : null}
            {saveState === 'conflict' ? <View style={styles.conflictBox}>
              <View style={styles.conflictHeading}><Ionicons name="git-compare-outline" size={19} color={colors.red} /><Text style={styles.conflictTitle}>这份方案已在其他位置更新</Text></View>
              <Text style={styles.conflictText}>为了不覆盖最新内容，当前页面已停止保存。重新读取会放弃本页未保存内容。</Text>
              {error ? <Text style={styles.conflictDetail}>{error}</Text> : null}
              <View style={styles.conflictActions}>
                <Pressable accessibilityRole="button" accessibilityLabel="退出且不覆盖最新方案" onPress={exitWithoutSaving} style={styles.conflictExit}><Text style={styles.conflictExitText}>退出不覆盖</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="重新读取最新方案" disabled={loading} onPress={() => void reloadLatest()} style={[styles.conflictReload, loading && styles.buttonDisabled]}>{loading ? <ActivityIndicator size="small" color={colors.surface} /> : <Text style={styles.conflictReloadText}>重新读取</Text>}</Pressable>
              </View>
            </View> : null}

            {step === 'service' ? <>
              <SectionHeading icon="sparkles-outline" title="服务信息" caption="填写买方实际购买和使用的服务规格。" />
              <Field label="服务名称" value={form.title} onChange={(value) => update('title', value)} placeholder="例如：NVIDIA H100 SXM5 单卡独享" />
              <Text style={styles.fieldLabel}>交付形态</Text>
              <View style={styles.deliveryLock}>
                <View style={styles.deliveryLockIcon}><Ionicons name="hardware-chip-outline" size={21} color={colors.primary} /></View>
                <View style={styles.deliveryLockCopy}><Text style={styles.deliveryLockTitle}>单卡独享</Text><Text style={styles.deliveryLockText}>每个订单固定分配 1 张 GPU；买方填写的是使用时长。</Text></View>
                <Ionicons name="lock-closed" size={17} color={colors.primary} />
              </View>
              {currentNodeGpuCount ? <Text style={styles.nodeHint}>这台节点有 {currentNodeGpuCount} 张 GPU，可同时承接 {currentNodeGpuCount} 个单卡订单。</Text> : null}
              <Field label="最小起售量" value={form.minimumQuantity} onChange={(value) => update('minimumQuantity', value)} placeholder="1" decimal hint={draft.resource.capacityUnit} />
            </> : null}

            {step === 'terms' ? <>
              <SectionHeading icon="git-branch-outline" title="交付条款" caption="确认自动开通、计费、退款和数据清理规则。" />
              <View style={styles.templateBox}><View style={styles.templateCopy}><Text style={styles.templateTitle}>使用平台交付规则</Text><Text style={styles.templateText}>带入当前自动开通与按实耗结算规则，再核对资源实际能力。</Text></View><Pressable accessibilityLabel="填入平台交付规则" onPress={useCommonTerms} style={styles.templateButton}><Text style={styles.templateButtonText}>填入规则</Text></Pressable></View>
              <Field label="开通保障" value={form.availability} onChange={(value) => update('availability', value)} placeholder="确认空闲 GPU 后锁单，未完成开通不计费" multiline />
              <Field label="交付方式" value={form.delivery} onChange={(value) => update('delivery', value)} placeholder="付款后自动开通，5 分钟内完成健康检查" multiline />
              <Field label="验收规则" value={form.acceptance} onChange={(value) => update('acceptance', value)} placeholder="以已核验配置、节点健康检查和平台计量为准" multiline />
              <Field label="计费与退款" value={form.refund} onChange={(value) => update('refund', value)} placeholder="开通失败全额退回，使用中按实际有效分钟结算" multiline />
              <Field label="数据清理" value={form.cleanup} onChange={(value) => update('cleanup', value)} placeholder="停止后撤销凭据，48 小时内清理工作数据" multiline />
            </> : null}

            {step === 'price' ? <>
              <SectionHeading icon="analytics-outline" title="卡时定价与审核材料" caption="填写期望卡时单价，最终挂牌价由平台审核确认。" />
              <Field label={`卡时单价 / ${draft.resource.capacityUnit}`} value={form.suggestedUnitCredits} onChange={(value) => update('suggestedUnitCredits', normalizeCreditInput(value))} placeholder="例如：31.20" decimal hint="KAI 卡时" />
              <View style={styles.priceCard}><View><Text style={styles.priceLabel}>申请审核单价</Text>{form.suggestedUnitCredits ? <Text style={styles.priceValue}>{creditAmount(form.suggestedUnitCredits)} <Text style={styles.priceUnit}>KAI 卡时</Text></Text> : <Text style={styles.priceEmpty}>填写期望的卡时单价</Text>}</View><View style={styles.auditPill}><Ionicons name="time-outline" size={14} color={colors.amber} /><Text style={styles.auditText}>等待价格审核</Text></View><Text style={styles.conversion}>平台将结合资源配置、交付能力和审核材料锁定最终卡时单价</Text></View>
              <Field label="价格构成" value={form.priceComponents} onChange={(value) => update('priceComponents', value)} placeholder="说明设备折旧、电力、网络、运维与税费是否包含" multiline />
              <Text style={styles.fieldLabel}>核价凭证</Text><View style={styles.chips}>{evidenceOptions.map((option) => <Pressable key={option.value} onPress={() => update('evidenceType', option.value)} style={[styles.chip, form.evidenceType === option.value && styles.chipActive]}><Text style={[styles.chipText, form.evidenceType === option.value && styles.chipTextActive]}>{option.label}</Text></Pressable>)}</View>
              <Field label="凭证来源" value={form.evidenceSource} onChange={(value) => update('evidenceSource', value)} placeholder="例如：近三个月同型号成交合同" />
              <Field label="凭证说明" value={form.evidenceSummary} onChange={(value) => update('evidenceSummary', value)} placeholder="说明时间、地区、型号与本次报价的可比性" multiline />
            </> : null}

            {step === 'review' ? <>
              <SectionHeading icon="shield-checkmark-outline" title="提交审核" caption="资源与价格分别审核；需要补充时会说明具体项目。" />
              <ReviewRow label="服务" value={serviceSummary(form)} />
              <ReviewRow label="起售" value={`${compactDecimal(form.minimumQuantity)} ${draft.resource.capacityUnit}`} />
              <ReviewRow label="交付边界" value="自动开通、健康检查、按实耗结算和数据清理已确认" />
              <ReviewRow label="申请审核单价" value={`${form.suggestedUnitCredits ? creditAmount(form.suggestedUnitCredits) : '—'} KAI 卡时 / ${draft.resource.capacityUnit}；最终以审核结果为准`} />
              <ReviewRow label="核价凭证" value={`${evidenceOptions.find((item) => item.value === form.evidenceType)?.label ?? '凭证'} · ${form.evidenceSource.trim() || '未填写来源'}`} />
              <ReviewRow label="凭证说明" value={form.evidenceSummary.trim() || '未填写说明'} />
              <View style={styles.auditMap}><View style={styles.auditNode}><Ionicons name="hardware-chip-outline" size={22} color={colors.primary} /><Text style={styles.auditNodeTitle}>资源审核</Text><Text style={styles.auditNodeText}>核对配置、控制权、容量和交付能力</Text></View><View style={styles.auditDivider} /><View style={styles.auditNode}><Ionicons name="calculator-outline" size={22} color={colors.primary} /><Text style={styles.auditNodeTitle}>价格审核</Text><Text style={styles.auditNodeText}>核对卡时价格构成与凭证，确定最终挂牌单价</Text></View></View>
            </> : null}
          </ScrollView>
          <View style={styles.footer}>
            {index > 0 ? <Pressable onPress={previous} style={styles.secondaryButton}><Ionicons name="arrow-back" size={18} color={colors.ink} /><Text style={styles.secondaryText}>上一步</Text></Pressable> : <View />}
            {index < steps.length - 1 ? <Pressable onPress={next} style={styles.nextButton}><Text style={styles.nextText}>下一步 · {steps[index + 1]!.label}</Text><Ionicons name="arrow-forward" size={18} color={colors.surface} /></Pressable> : (
              <Pressable disabled={submitting || saveState === 'conflict' || saveState === 'saving'} onPress={() => void submit()} style={[styles.footerSubmit, (submitting || saveState === 'conflict' || saveState === 'saving') && styles.buttonDisabled]}>
                {submitting ? <><ActivityIndicator color={colors.surface} /><Text style={styles.submitText}>正在提交并确认…</Text></> : <><Text style={styles.submitText}>{revision ? '提交修改，重新审核' : '提交审核'}</Text><Ionicons name="arrow-forward" size={18} color={colors.surface} /></>}
              </Pressable>
            )}
          </View>
        </> : null}
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

function SectionHeading({ icon, title, caption }: Readonly<{ icon: 'sparkles-outline' | 'git-branch-outline' | 'analytics-outline' | 'shield-checkmark-outline'; title: string; caption: string }>) {
  return <View style={styles.sectionHeading}><View style={styles.sectionIcon}><Ionicons name={icon} size={22} color={colors.primary} /></View><View style={styles.sectionCopy}><Text style={styles.sectionTitle}>{title}</Text><Text style={styles.sectionCaption}>{caption}</Text></View></View>;
}
function ReviewRow({ label, value }: Readonly<{ label: string; value: string }>) { return <View style={styles.reviewRow}><Text style={styles.reviewLabel}>{label}</Text><Text style={styles.reviewValue}>{value}</Text></View>; }
function ErrorBox({ text }: Readonly<{ text: string }>) { return <View style={styles.errorBox}><Ionicons name="alert-circle-outline" size={18} color={colors.red} /><Text style={styles.errorText}>{text}</Text></View>; }

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.42)' }, sheet: { height: '96%', backgroundColor: colors.canvas, borderTopLeftRadius: 30, borderTopRightRadius: 30, overflow: 'hidden' }, handle: { width: 42, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 9, backgroundColor: '#D0D5DD' },
  header: { minHeight: 72, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, eyebrow: { color: colors.primary, fontSize: 9, fontWeight: '900', letterSpacing: 1.5 }, title: { color: colors.ink, fontSize: 25, fontWeight: '900', marginTop: 3 }, headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 }, close: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  savePill: { height: 32, paddingHorizontal: 10, borderRadius: 999, flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.primarySoft }, savePillError: { backgroundColor: '#FDECEC' }, saveText: { color: colors.primary, fontSize: 10, fontWeight: '900' }, saveTextError: { color: colors.red }, center: { flex: 1, alignItems: 'center', justifyContent: 'center' }, loadingText: { color: colors.muted, fontSize: 12, marginTop: 10 },
  stepBar: { paddingHorizontal: 12, paddingVertical: 9, flexDirection: 'row', borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }, stepItem: { flex: 1, alignItems: 'center' }, stepDot: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E6ECF4' }, stepDotActive: { backgroundColor: colors.primary }, stepNumber: { color: colors.muted, fontSize: 9, fontWeight: '900' }, stepNumberActive: { color: colors.surface }, stepLabel: { color: colors.muted, fontSize: 10, fontWeight: '800', marginTop: 4 }, stepLabelActive: { color: colors.primary },
  content: { padding: 17, paddingBottom: 30 }, assetStrip: { minHeight: 62, paddingHorizontal: 14, marginBottom: 19, borderRadius: 18, borderWidth: 1, borderColor: '#D5E5FA', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.primarySoft }, assetEyebrow: { color: colors.primary, fontSize: 8, fontWeight: '900', letterSpacing: 1.2 }, assetName: { color: colors.ink, fontSize: 14, fontWeight: '900', marginTop: 3 }, assetUnit: { color: colors.primaryDark, fontSize: 11, fontWeight: '800' },
  sectionHeading: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 19 }, sectionIcon: { width: 45, height: 45, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, sectionCopy: { flex: 1, marginLeft: 11 }, sectionTitle: { color: colors.ink, fontSize: 20, fontWeight: '900' }, sectionCaption: { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: 4 },
  field: { marginBottom: 14 }, fieldHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }, fieldLabel: { color: colors.ink, fontSize: 12, fontWeight: '900', marginBottom: 7 }, fieldHint: { color: colors.primary, fontSize: 9, fontWeight: '800' }, input: { minHeight: 52, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.line, borderRadius: 16, color: colors.ink, fontSize: 14, backgroundColor: colors.surface }, multiline: { minHeight: 84, paddingTop: 13, textAlignVertical: 'top' }, chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 15 }, chip: { paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1, borderColor: colors.line, borderRadius: 999, backgroundColor: colors.surface }, chipActive: { borderColor: colors.primary, backgroundColor: colors.primary }, chipText: { color: colors.muted, fontSize: 11, fontWeight: '800' }, chipTextActive: { color: colors.surface },
  templateBox: { minHeight: 74, padding: 13, marginBottom: 16, borderRadius: 18, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primarySoft }, templateCopy: { flex: 1, paddingRight: 10 }, templateTitle: { color: colors.primaryDark, fontSize: 12, fontWeight: '900' }, templateText: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 3 }, templateButton: { minHeight: 42, paddingHorizontal: 13, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, templateButtonText: { color: colors.surface, fontSize: 10, fontWeight: '900' },
  deliveryLock: { minHeight: 72, padding: 13, marginBottom: 8, borderWidth: 1, borderColor: '#B9D2F7', borderRadius: 18, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primarySoft }, deliveryLockIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, deliveryLockCopy: { flex: 1, marginHorizontal: 11 }, deliveryLockTitle: { color: colors.primaryDark, fontSize: 13, fontWeight: '900' }, deliveryLockText: { color: colors.muted, fontSize: 9, lineHeight: 15, marginTop: 3 }, nodeHint: { color: colors.primary, fontSize: 9, lineHeight: 15, marginBottom: 15 },
  priceCard: { minHeight: 118, padding: 16, marginBottom: 15, borderRadius: 20, borderWidth: 1, borderColor: '#D5E5FA', backgroundColor: colors.surface }, priceLabel: { color: colors.primary, fontSize: 9, fontWeight: '900', letterSpacing: 1.1 }, priceValue: { color: colors.primaryDark, fontSize: 27, fontWeight: '900', marginTop: 6 }, priceEmpty: { color: colors.ink, fontSize: 15, fontWeight: '800', marginTop: 13 }, priceUnit: { fontSize: 12, color: colors.primary }, auditPill: { position: 'absolute', right: 14, top: 14, paddingHorizontal: 9, paddingVertical: 6, flexDirection: 'row', gap: 5, borderRadius: 999, backgroundColor: '#FFF4D4' }, auditText: { color: colors.amber, fontSize: 9, fontWeight: '900' }, conversion: { color: colors.muted, fontSize: 9, marginTop: 10 },
  reviewRow: { minHeight: 67, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line }, reviewLabel: { color: colors.primary, fontSize: 9, fontWeight: '900', letterSpacing: 1.1 }, reviewValue: { color: colors.ink, fontSize: 13, fontWeight: '800', lineHeight: 19, marginTop: 5 }, auditMap: { flexDirection: 'row', alignItems: 'stretch', marginTop: 18, padding: 14, borderRadius: 20, backgroundColor: colors.primarySoft }, auditNode: { flex: 1 }, auditNodeTitle: { color: colors.primaryDark, fontSize: 12, fontWeight: '900', marginTop: 7 }, auditNodeText: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 4 }, auditDivider: { width: 1, marginHorizontal: 11, backgroundColor: '#B9D2F7' }, submitButton: { minHeight: 54, marginTop: 18, borderRadius: 17, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, submitText: { color: colors.surface, fontSize: 14, fontWeight: '900' }, buttonDisabled: { opacity: 0.5 },
  footer: { minHeight: 74, paddingHorizontal: 17, paddingTop: 10, paddingBottom: 10, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.surface, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, secondaryButton: { height: 48, paddingHorizontal: 14, borderRadius: 15, flexDirection: 'row', gap: 7, alignItems: 'center', backgroundColor: colors.canvas }, secondaryText: { color: colors.ink, fontSize: 12, fontWeight: '900' }, nextButton: { height: 48, paddingHorizontal: 18, borderRadius: 15, flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: colors.primary }, nextText: { color: colors.surface, fontSize: 12, fontWeight: '900' },
  footerSubmit: { height: 48, paddingHorizontal: 17, borderRadius: 15, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  errorBox: { padding: 12, marginBottom: 14, borderRadius: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#FDECEC' }, errorText: { flex: 1, color: colors.red, fontSize: 11, lineHeight: 17 },
  conflictBox: { padding: 14, marginBottom: 16, borderWidth: 1, borderColor: '#F2C9C9', borderRadius: 18, backgroundColor: '#FFF7F7' },
  conflictHeading: { flexDirection: 'row', alignItems: 'center', gap: 8 }, conflictTitle: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '900' },
  conflictText: { color: colors.muted, fontSize: 10, lineHeight: 17, marginTop: 8 }, conflictDetail: { color: colors.red, fontSize: 10, lineHeight: 16, marginTop: 6 },
  conflictActions: { flexDirection: 'row', gap: 9, marginTop: 13 }, conflictExit: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#E8B6B6', borderRadius: 14, backgroundColor: colors.surface }, conflictExitText: { color: colors.red, fontSize: 11, fontWeight: '900' },
  conflictReload: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: colors.primary }, conflictReloadText: { color: colors.surface, fontSize: 11, fontWeight: '900' },
  feedbackBox: { padding: 14, marginBottom: 16, borderWidth: 1, borderColor: '#F2C9C9', borderRadius: 17, backgroundColor: '#FFF7F7' },
  feedbackTop: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  feedbackTitle: { color: colors.red, fontSize: 12, fontWeight: '900' },
  feedbackReason: { color: colors.ink, fontSize: 13, lineHeight: 20, fontWeight: '700', marginTop: 9 },
  feedbackSummary: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 6 },
  resourceContent: { padding: 18, paddingBottom: 30 }, resourceHero: { padding: 21, marginBottom: 16, borderRadius: 23, backgroundColor: colors.primarySoft }, resourceTitle: { color: colors.primaryDark, fontSize: 21, fontWeight: '900', marginTop: 13 }, resourceCaption: { color: colors.muted, fontSize: 11, lineHeight: 18, marginTop: 6 }, resourceCard: { minHeight: 82, padding: 13, marginBottom: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 20, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface }, resourceIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, resourceInitial: { color: colors.surface, fontSize: 21, fontWeight: '900' }, resourceCopy: { flex: 1, marginLeft: 12 }, resourceName: { color: colors.ink, fontSize: 14, fontWeight: '900' }, resourceMeta: { color: colors.muted, fontSize: 10, marginTop: 4 }, empty: { alignItems: 'center', padding: 26, borderRadius: 22, backgroundColor: colors.surface }, emptyTitle: { color: colors.ink, fontSize: 16, fontWeight: '900', marginTop: 12 }, emptyText: { color: colors.muted, fontSize: 11, lineHeight: 18, textAlign: 'center', marginTop: 6 },
  retryButton: { minHeight: 46, marginBottom: 14, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, retryText: { color: colors.surface, fontSize: 12, fontWeight: '900' },
});
