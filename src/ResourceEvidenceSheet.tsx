import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import type { ComputeResource } from './publishing';
import {
  discardResourceEvidence,
  loadResourceEvidence,
  resumeResourceEvidenceUpload,
  submitResourceEvidence,
  uploadResourceEvidence,
  type ResourceEvidenceCategory,
  type ResourceEvidenceChecklist,
} from './resource-evidence';
import { ApiError } from './api-client';
import { resourceEvidenceCopy } from './resource-evidence-copy';
import {
  isAmbiguousMutationFailure, resourceSubmissionAccepted, resourceUploadAccepted, unknownSubmissionMessage,
} from './mutation-recovery';
import { colors } from './theme';

const categories: ReadonlyArray<Readonly<{
  key: ResourceEvidenceCategory;
  title: string;
  hint: string;
  icon: 'key-outline' | 'hardware-chip-outline' | 'pulse-outline';
}>> = [
  { key: 'ownership', title: '权属材料', hint: '设备铭牌、采购凭证或有效授权', icon: 'key-outline' },
  { key: 'configuration', title: '配置材料', hint: '控制台配置、设备信息或检测报告', icon: 'hardware-chip-outline' },
  { key: 'availability', title: '可用性材料', hint: '在线状态、可用时段或交付能力证明', icon: 'pulse-outline' },
];

const stateText = {
  missing: '未上传', uploading: '等待上传', checking: '检查中', ready: '已完成', needs_replacement: '请更换',
} as const;

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

export function ResourceEvidenceSheet({ resource, canManage, onClose, onChanged }: Readonly<{
  resource: ComputeResource | null;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}>) {
  const [checklist, setChecklist] = useState<ResourceEvidenceChecklist | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyCategory, setBusyCategory] = useState<ResourceEvidenceCategory | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploadKeys = useRef(new Map<ResourceEvidenceCategory, { signature: string; key: string }>());
  const submitKey = useRef<string | null>(null);
  const notifiedReview = useRef<string | null>(null);
  const uploadInFlightRef = useRef(false);
  const submitInFlightRef = useRef(false);

  const load = useCallback(async (quiet = false) => {
    if (!resource?.id) return;
    if (!quiet) setLoading(true);
    try {
      setChecklist(await loadResourceEvidence(resource.id));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '材料状态加载失败，请重试。');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [resource?.id]);

  useEffect(() => {
    setChecklist(null); setError(null); submitKey.current = null; notifiedReview.current = null; uploadKeys.current.clear();
    void load();
  }, [load, resource?.id]);

  useEffect(() => {
    if (!resource || !checklist) return;
    const awaitingResult = checklist.review.status === 'under_review'
      || Object.values(checklist.categories).some((item) => item.state === 'checking');
    if (!awaitingResult) return;
    const timer = setInterval(() => void load(true), 3500);
    return () => clearInterval(timer);
  }, [checklist, load, resource]);

  useEffect(() => {
    const status = checklist?.review.status;
    if (!resource || !status || !['passed', 'failed'].includes(status)) return;
    const reviewKey = `${resource.id}:${status}`;
    if (notifiedReview.current === reviewKey) return;
    notifiedReview.current = reviewKey;
    void onChanged();
  }, [checklist?.review.status, onChanged, resource]);

  const chooseFile = async (category: ResourceEvidenceCategory) => {
    if (!resource || busyCategory || submitting || uploadInFlightRef.current) return;
    uploadInFlightRef.current = true;
    setError(null);
    let selectedFile: { name: string; size: number | undefined } | null = null;
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ['image/jpeg', 'image/png', 'application/pdf'], copyToCacheDirectory: true, multiple: false,
      });
      if (picked.canceled || !picked.assets[0]) return;
      const asset = picked.assets[0];
      selectedFile = { name: asset.name, size: asset.size };
      const signature = `${asset.name}:${asset.size ?? 'unknown'}:${asset.lastModified}`;
      let saved = uploadKeys.current.get(category);
      setBusyCategory(category); setUploadProgress(0);
      const existing = checklist?.categories[category].evidence;
      const progress = (value: number) => setUploadProgress(Math.max(0, Math.min(1, value)));
      if (existing?.status === 'pending_upload') {
        try {
          await resumeResourceEvidenceUpload({ resourceId: resource.id, evidence: existing, asset, onProgress: progress });
          uploadKeys.current.delete(category);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          await load(true);
          await onChanged();
          return;
        } catch (caught) {
          if (!(caught instanceof ApiError && caught.code === 'RESOURCE_EVIDENCE_FILE_CHANGED')) throw caught;
        }
      }
      if (existing && ['pending_upload', 'rejected', 'scan_failed'].includes(existing.status)) {
        await discardResourceEvidence(resource.id, existing.id);
        saved = undefined;
      }
      const requestId = saved?.signature === signature ? saved.key : `resource-evidence-${Crypto.randomUUID()}`;
      uploadKeys.current.set(category, { signature, key: requestId });
      await uploadResourceEvidence({
        resourceId: resource.id, category, asset, requestId,
        onProgress: progress,
      });
      uploadKeys.current.delete(category);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await load(true);
      await onChanged();
    } catch (caught) {
      if (selectedFile && isAmbiguousMutationFailure(caught)) {
        try {
          const current = await loadResourceEvidence(resource.id);
          setChecklist(current);
          if (resourceUploadAccepted(current, category, selectedFile.name, selectedFile.size)) {
            uploadKeys.current.delete(category);
            setError(null);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            await onChanged();
            return;
          }
        } catch { /* Keep the same upload key so selecting the same file resumes safely. */ }
        setError('网络中断，暂时没能确认上传结果。请恢复网络后重新选择同一文件，系统会接着处理。');
      } else {
        setError(caught instanceof Error ? caught.message : '文件上传失败，请重试。');
        await load(true);
      }
    } finally {
      uploadInFlightRef.current = false;
      setBusyCategory(null); setUploadProgress(0);
    }
  };

  const submit = async () => {
    if (!resource || !checklist?.readyToSubmit || submitting || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    submitKey.current ??= `resource-evidence-submit-${Crypto.randomUUID()}`;
    setSubmitting(true); setError(null);
    try {
      await submitResourceEvidence(resource.id, submitKey.current);
      submitKey.current = null;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await load(true);
      await onChanged();
    } catch (caught) {
      if (isAmbiguousMutationFailure(caught)) {
        try {
          const current = await loadResourceEvidence(resource.id);
          setChecklist(current);
          if (resourceSubmissionAccepted(current)) {
            submitKey.current = null;
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            await onChanged();
            return;
          }
        } catch { /* Keep the original unknown result and the same idempotency key. */ }
        setError(unknownSubmissionMessage);
      } else setError(caught instanceof Error ? caught.message : '提交审核失败，请重试。');
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const closeSafely = () => {
    if (uploadInFlightRef.current) {
      Alert.alert('材料正在上传', '请等待当前文件上传完成。进度和已完成材料不会丢失。');
      return;
    }
    if (submitInFlightRef.current) {
      Alert.alert('正在确认提交结果', '请稍等，系统正在确认是否已经进入审核，避免重复提交。');
      return;
    }
    onClose();
  };

  if (!resource) return null;
  const review = checklist?.review.status;
  const editable = canManage && review === 'collecting';
  const completedCount = checklist ? Object.values(checklist.categories).filter((item) => item.state === 'ready').length : 0;
  const correctionNote = checklist?.review.correctionNote;
  const correctionNeedsAction = Boolean(correctionNote && (review === 'collecting' || review === 'failed') && !checklist?.readyToSubmit);
  const copy = resourceEvidenceCopy(
    review, correctionNote, Boolean(checklist?.readyToSubmit), completedCount, resource.verification?.failureReason,
  );

  return (
    <Modal visible animationType="slide" transparent onRequestClose={closeSafely}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.eyebrow}>资源资料核验</Text>
              <Text style={styles.title}>{copy.headerTitle}</Text>
              <Text style={styles.resourceName}>{resource.productCode} · {resource.region}</Text>
            </View>
            <Pressable accessibilityLabel="关闭资源材料" onPress={closeSafely} style={styles.closeButton}><Ionicons name="close" size={23} color={colors.ink} /></Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            {loading && !checklist ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}
            {!loading && !checklist && error ? (
              <View style={styles.loadError}>
                <Ionicons name="cloud-offline-outline" size={30} color={colors.primary} />
                <Text style={styles.loadErrorTitle}>没能读取材料状态</Text>
                <Text style={styles.loadErrorText}>{error}</Text>
                <Pressable onPress={() => void load()} style={styles.retryButton}><Text style={styles.retryText}>重新读取</Text></Pressable>
              </View>
            ) : null}
            {checklist ? (
              <>
                <View style={[styles.reviewBox, review === 'passed' && styles.reviewPassed, correctionNeedsAction && styles.reviewFailed]}>
                  <Ionicons name={review === 'passed' ? 'checkmark-circle' : review === 'under_review' ? 'time' : correctionNeedsAction ? 'alert-circle' : 'documents'} size={24} color={correctionNeedsAction ? colors.red : review === 'passed' ? colors.green : colors.primary} />
                  <View style={styles.reviewCopy}><Text style={styles.reviewTitle}>{copy.reviewTitle}</Text><Text style={styles.reviewText}>{copy.reviewText}</Text></View>
                </View>
                {copy.showFormatNote ? <Text style={styles.note}>支持 JPG、PNG、PDF，单份不超过 20MB。</Text> : null}
                {review !== 'passed' ? <View style={styles.categoryList}>
                  {categories.map((category) => {
                    const item = checklist.categories[category.key];
                    const busy = busyCategory === category.key;
                    const stateColor = item.state === 'ready' ? colors.green : item.state === 'needs_replacement' ? colors.red
                      : item.state === 'checking' ? colors.blue : colors.muted;
                    const visibleState = busy ? '上传中'
                      : item.state === 'ready' && item.reviewDecision === 'accepted' ? '已保留'
                        : item.state === 'ready' && item.reviewDecision === 'replace' ? '已更换'
                          : stateText[item.state];
                    const canChoose = editable && !busyCategory && !submitting && item.state !== 'checking'
                      && item.reviewDecision !== 'accepted';
                    const hint = item.state === 'uploading' ? '上次没有传完，重新选择同一文件即可继续' : category.hint;
                    const buttonText = item.state === 'missing' ? '选择文件' : item.state === 'uploading' ? '继续上传'
                      : item.state === 'ready' ? '更换' : '重新选择';
                    return (
                      <View key={category.key} style={styles.categoryCard}>
                        <View style={styles.categoryIcon}><Ionicons name={category.icon} size={22} color={colors.primary} /></View>
                        <View style={styles.categoryCopy}>
                          <View style={styles.categoryTitleRow}><Text style={styles.categoryTitle}>{category.title}</Text><Text style={[styles.stateText, { color: stateColor }]}>{visibleState}</Text></View>
                          <Text style={styles.categoryHint}>{hint}</Text>
                          {item.evidence ? <Text numberOfLines={1} style={styles.fileName}>{item.evidence.fileName} · {formatSize(item.evidence.sizeBytes)}</Text> : null}
                          {busy ? <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.max(5, Math.round(uploadProgress * 100))}%` }]} /></View> : null}
                        </View>
                        {canChoose ? (
                          <Pressable onPress={() => void chooseFile(category.key)} style={styles.fileButton}>
                            <Text style={styles.fileButtonText}>{buttonText}</Text>
                          </Pressable>
                        ) : item.state === 'checking' ? <ActivityIndicator size="small" color={colors.blue} /> : null}
                      </View>
                    );
                  })}
                </View> : null}
                {error ? <View style={styles.errorBox}><Ionicons name="alert-circle-outline" size={18} color={colors.red} /><Text style={styles.errorText}>{error}</Text></View> : null}
                {checklist.readyToSubmit && canManage ? (
                  <Pressable disabled={submitting} onPress={() => void submit()} style={styles.submitButton}>
                    {submitting ? <><ActivityIndicator color={colors.surface} /><Text style={styles.submitText}>正在提交并确认…</Text></> : <><Text style={styles.submitText}>提交平台审核</Text><Ionicons name="arrow-forward" size={18} color={colors.surface} /></>}
                  </Pressable>
                ) : null}
                {review === 'under_review' || review === 'passed' ? <Pressable onPress={onClose} style={styles.doneButton}><Text style={styles.doneText}>{review === 'passed' ? '查看节点接入' : '完成'}</Text></Pressable> : null}
              </>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.38)' },
  sheet: { height: '92%', paddingHorizontal: 18, paddingTop: 10, paddingBottom: 24, borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: colors.canvas },
  handle: { width: 42, height: 5, alignSelf: 'center', marginBottom: 16, borderRadius: 3, backgroundColor: '#D0D5DD' },
  header: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 14 }, headerCopy: { flex: 1 },
  eyebrow: { color: colors.primary, fontSize: 10, fontWeight: '900', letterSpacing: 1.4 }, title: { color: colors.ink, fontSize: 25, fontWeight: '900', marginTop: 4 }, resourceName: { color: colors.muted, fontSize: 11, marginTop: 5 },
  closeButton: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, content: { paddingBottom: 28 }, loader: { marginVertical: 30 },
  reviewBox: { padding: 15, borderRadius: 18, flexDirection: 'row', alignItems: 'flex-start', gap: 11, backgroundColor: colors.primarySoft }, reviewPassed: { backgroundColor: colors.greenSoft }, reviewFailed: { backgroundColor: '#FFF1F1' }, reviewCopy: { flex: 1 }, reviewTitle: { color: colors.ink, fontSize: 15, fontWeight: '900' }, reviewText: { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: 4 },
  note: { color: colors.muted, fontSize: 10, marginTop: 13, marginBottom: 9 }, categoryList: { gap: 9 }, categoryCard: { minHeight: 94, padding: 13, borderRadius: 18, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, flexDirection: 'row', alignItems: 'center' },
  categoryIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, categoryCopy: { flex: 1, marginLeft: 10, marginRight: 8 }, categoryTitleRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 }, categoryTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, stateText: { fontSize: 9, fontWeight: '900' }, categoryHint: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 3 }, fileName: { color: colors.ink, fontSize: 9, marginTop: 5 },
  fileButton: { minWidth: 64, minHeight: 40, paddingHorizontal: 10, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, fileButtonText: { color: colors.primaryDark, fontSize: 10, fontWeight: '900' }, progressTrack: { height: 4, marginTop: 7, borderRadius: 2, overflow: 'hidden', backgroundColor: colors.line }, progressFill: { height: 4, borderRadius: 2, backgroundColor: colors.primary },
  errorBox: { flexDirection: 'row', gap: 8, padding: 12, marginTop: 12, borderRadius: 14, backgroundColor: '#FFF1F1' }, errorText: { flex: 1, color: colors.red, fontSize: 11, lineHeight: 17 },
  submitButton: { minHeight: 52, marginTop: 15, borderRadius: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.primary }, submitText: { color: colors.surface, fontSize: 14, fontWeight: '900' },
  doneButton: { minHeight: 50, marginTop: 15, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }, doneText: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  loadError: { padding: 24, alignItems: 'center', borderRadius: 20, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  loadErrorTitle: { color: colors.ink, fontSize: 17, fontWeight: '900', marginTop: 12 },
  loadErrorText: { color: colors.muted, fontSize: 11, lineHeight: 17, textAlign: 'center', marginTop: 6 },
  retryButton: { minHeight: 46, marginTop: 15, paddingHorizontal: 28, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  retryText: { color: colors.surface, fontSize: 12, fontWeight: '900' },
});
