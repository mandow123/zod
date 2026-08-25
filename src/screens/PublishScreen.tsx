import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CloudPaySnapshot } from '../api';
import { ApiError } from '../api-client';
import { Card } from '../components';
import { PublishFlowSheet, type PublishMode } from '../PublishFlowSheet';
import { ListingManageSheet } from '../ListingManageSheet';
import { abandonOfferDraft, getSupplierOffer, listOfferDrafts, listSupplierListings, listSupplierOffers, resubmitExpiredOffer, type CreditListing, type OfferTemplate, type OfferWizardDraft } from '../publishing';
import { draftAbandonAccepted, isAmbiguousMutationFailure, offerReauditAccepted } from '../mutation-recovery';
import { loadProviderReadCache, saveProviderProgressCache } from '../provider-read-cache';
import { colors, ledgerActionButton, ledgerActionText } from '../theme';
import { creditAmount } from '../format';

type Intent = 'buy' | 'sell' | 'supplier';
type SupplierStatus = NonNullable<NonNullable<CloudPaySnapshot['providerWorkspace']>['supplier']>['status'];
const UNIFIED_PUBLISH_IDENTITY = 'KAI_CLOUD_UNIFIED_PROVIDER_PUBLISH_V2';

type Mission = Readonly<{
  mode: Intent;
  number: string;
  tag: string;
  title: string;
  caption: string;
  icon: 'flash-outline' | 'leaf-outline' | 'server-outline' | 'business-outline';
  colors: readonly [string, string];
}>;

const resourceMission: Mission = {
  mode: 'sell', number: '01', tag: '算力资源', title: '添加算力资源',
  caption: '登记 GPU 数量、单卡显存和可售总量。', icon: 'server-outline', colors: ['#E8F2FF', '#F8FBFF'],
};

function onboardingMission(status: SupplierStatus): Mission {
  if (status === 'submitted') return {
    mode: 'supplier', number: '01', tag: '入驻审核', title: '查看审核进度',
    caption: '审核通过后即可添加资源。', icon: 'business-outline', colors: ['#E8F2FF', '#F8FBFF'],
  };
  if (status === 'rejected') return {
    mode: 'supplier', number: '01', tag: '补充资料', title: '继续完成入驻',
    caption: '按审核意见修改后重新提交。', icon: 'business-outline', colors: ['#E8F2FF', '#F8FBFF'],
  };
  if (status === 'suspended') return {
    mode: 'supplier', number: '01', tag: '资格状态', title: '查看暂停原因',
    caption: '当前不能新增资源或挂牌。', icon: 'business-outline', colors: ['#E8F2FF', '#F8FBFF'],
  };
  return {
    mode: 'supplier', number: '01', tag: '资源方入驻', title: '成为资源伙伴',
    caption: '提交主体资料，通过后即可添加资源。', icon: 'business-outline', colors: ['#E8F2FF', '#F8FBFF'],
  };
}

type OfferWizardTarget = Readonly<{ resumeDraftId?: string; resourceId?: string; revisionOfferId?: string }>;

export function PublishScreen({ snapshot, onLogin, onWorkspaceChanged, onOpenOfferWizard, onOpenListing, onOpenResourceEvidence, openIntent, onIntentOpened, revealOfferId, onOfferRevealed, revealListingId, onListingRevealed }: Readonly<{
  snapshot: CloudPaySnapshot;
  onLogin: () => void;
  onWorkspaceChanged: () => void | Promise<void>;
  onOpenOfferWizard: (target?: OfferWizardTarget) => void;
  onOpenListing: (offerId: string) => void;
  onOpenResourceEvidence: (resourceId: string) => void;
  openIntent: Intent | null;
  onIntentOpened: () => void;
  revealOfferId: string | null;
  onOfferRevealed: () => void;
  revealListingId: string | null;
  onListingRevealed: () => void;
}>) {
  const scrollRef = useRef<ScrollView>(null);
  const progressOffsetsRef = useRef(new Map<string, number>());
  const mountedRef = useRef(true);
  const progressRequestRef = useRef(0);
  const progressLoadedRef = useRef(false);
  const progressSubjectRef = useRef<string | null>(null);
  const progressIdentityRef = useRef<{ accountId: string; subjectId: string } | null>(null);
  const draftsRef = useRef<OfferWizardDraft[]>([]);
  const offersRef = useRef<OfferTemplate[]>([]);
  const listingsRef = useRef<CreditListing[]>([]);
  const [mode, setMode] = useState<PublishMode | null>(null);
  const [resumeAfterLogin, setResumeAfterLogin] = useState<Intent | null>(null);
  const [drafts, setDrafts] = useState<OfferWizardDraft[]>([]);
  const [offers, setOffers] = useState<OfferTemplate[]>([]);
  const [listings, setListings] = useState<CreditListing[]>([]);
  const [progressState, setProgressState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [progressError, setProgressError] = useState<string | null>(null);
  const [progressCachedAt, setProgressCachedAt] = useState<string | null>(null);
  const [progressRefreshing, setProgressRefreshing] = useState(false);
  const [managedListingId, setManagedListingId] = useState<string | null>(null);
  const [reauditingOfferId, setReauditingOfferId] = useState<string | null>(null);
  const [abandoningDraftId, setAbandoningDraftId] = useState<string | null>(null);
  const supplierStatus = snapshot.providerWorkspace?.supplier?.status ?? null;
  const canManage = snapshot.providerWorkspace?.canManage === true;
  const readOnly = snapshot.authenticated && !canManage;
  const providerApproved = snapshot.authenticated && supplierStatus === 'approved';
  const missions: readonly Mission[] = providerApproved
    ? [resourceMission]
    : [onboardingMission(supplierStatus ?? 'draft')];
  const visibleOffers = offers.filter((offer) => !listings.some((listing) => listing.offerId === offer.id
    && ['active', 'paused', 'sold_out'].includes(listing.status)));
  const progressCount = drafts.length + visibleOffers.length + listings.length;
  const hasOfferUnderReview = offers.some((offer) => offer.status === 'under_review');
  const progressWritable = canManage && snapshot.online && snapshot.sessionState === 'authenticated' && !snapshot.providerWorkspaceError
    && progressState === 'ready' && !progressRefreshing && !progressError && !progressCachedAt;

  const loadProgress = useCallback(async () => {
    const requestId = ++progressRequestRef.current;
    setProgressRefreshing(true);
    if (!progressLoadedRef.current) setProgressState('loading');
    if (!progressLoadedRef.current) setProgressError(null);
    let [draftResult, offerResult, listingResult] = await Promise.allSettled([
      listOfferDrafts(), listSupplierOffers(), listSupplierListings(),
    ]);
    const recoverTemporaryFailure = async <T,>(result: PromiseSettledResult<T>, read: () => Promise<T>) => {
      if (result.status === 'fulfilled'
        || !(result.reason instanceof ApiError)
        || ![500, 502, 503, 504].includes(result.reason.status)) return result;
      try { return { status: 'fulfilled', value: await read() } as PromiseFulfilledResult<T>; }
      catch (reason) { return { status: 'rejected', reason } as PromiseRejectedResult; }
    };
    draftResult = await recoverTemporaryFailure(draftResult, listOfferDrafts);
    offerResult = await recoverTemporaryFailure(offerResult, listSupplierOffers);
    listingResult = await recoverTemporaryFailure(listingResult, listSupplierListings);
    if (!mountedRef.current || requestId !== progressRequestRef.current) return;
    setProgressRefreshing(false);
    const failures: string[] = [];
    let successCount = 0;
    const nextDrafts = draftResult.status === 'fulfilled' ? draftResult.value : draftsRef.current;
    const nextOffers = offerResult.status === 'fulfilled' ? offerResult.value : offersRef.current;
    const nextListings = listingResult.status === 'fulfilled' ? listingResult.value : listingsRef.current;
    if (draftResult.status === 'fulfilled') { draftsRef.current = nextDrafts; setDrafts(nextDrafts); successCount += 1; }
    else failures.push('草稿');
    if (offerResult.status === 'fulfilled') { offersRef.current = nextOffers; setOffers(nextOffers); successCount += 1; }
    else failures.push('审核');
    if (listingResult.status === 'fulfilled') { listingsRef.current = nextListings; setListings(nextListings); successCount += 1; }
    else failures.push('挂牌');
    if (successCount > 0) {
      progressLoadedRef.current = true;
      setProgressState('ready');
      setProgressError(failures.length > 0 ? `${failures.join('、')}记录暂时没更新，其他内容仍可使用。` : null);
      if (failures.length === 0) setProgressCachedAt(null);
      const identity = progressIdentityRef.current;
      if (identity) void saveProviderProgressCache(identity.accountId, identity.subjectId, {
        drafts: nextDrafts, offers: nextOffers, listings: nextListings,
      });
      return;
    }
    if (progressLoadedRef.current) {
      setProgressState('ready');
      setProgressError('这次没有更新成功，当前仍显示上一次结果。');
      return;
    }
    const reasons = [draftResult, offerResult, listingResult]
      .flatMap((result) => result.status === 'rejected' && result.reason instanceof Error ? [result.reason.message] : []);
    setProgressState('error');
    setProgressError(reasons[0] ?? '上架进度读取失败，请重试。');
  }, []);

  useEffect(() => () => {
    mountedRef.current = false;
    progressRequestRef.current += 1;
  }, []);

  useEffect(() => {
    if (!snapshot.authenticated) {
      progressRequestRef.current += 1;
      progressLoadedRef.current = false;
      progressSubjectRef.current = null;
      progressIdentityRef.current = null;
      draftsRef.current = []; offersRef.current = []; listingsRef.current = [];
      setDrafts([]); setOffers([]); setListings([]); setProgressState('idle'); setProgressError(null); setProgressCachedAt(null); setProgressRefreshing(false); return;
    }
    const accountId = snapshot.user?.id;
    const subjectId = snapshot.currentSubjectId ?? snapshot.providerWorkspace?.subject.id ?? null;
    if (!accountId || !subjectId) return;
    if (progressSubjectRef.current !== subjectId) {
      progressRequestRef.current += 1;
      progressLoadedRef.current = false;
      progressSubjectRef.current = subjectId;
      const identity = { accountId, subjectId };
      progressIdentityRef.current = identity;
      draftsRef.current = []; offersRef.current = []; listingsRef.current = [];
      setDrafts([]); setOffers([]); setListings([]); setProgressCachedAt(null);
      void loadProviderReadCache(accountId, subjectId).then((cached) => {
        if (!mountedRef.current || progressIdentityRef.current !== identity || !cached?.progress) return;
        draftsRef.current = cached.progress.drafts;
        offersRef.current = cached.progress.offers;
        listingsRef.current = cached.progress.listings;
        setDrafts(cached.progress.drafts);
        setOffers(cached.progress.offers);
        setListings(cached.progress.listings);
        progressLoadedRef.current = true;
        setProgressState('ready');
        setProgressCachedAt(cached.savedAt);
        setProgressError(null);
      }).finally(() => {
        if (mountedRef.current && progressIdentityRef.current === identity) void loadProgress();
      });
      return;
    }
    void loadProgress();
  }, [loadProgress, snapshot.authenticated, snapshot.currentSubjectId, snapshot.providerWorkspace?.listings.paused,
    snapshot.providerWorkspace?.listings.scheduled, snapshot.providerWorkspace?.listings.scheduledPaused, snapshot.providerWorkspace?.listings.selling,
    snapshot.providerWorkspace?.listings.soldOut, snapshot.providerWorkspace?.resume?.updatedAt, snapshot.providerWorkspace?.subject.id,
    snapshot.user?.id]);

  useEffect(() => {
    if (!snapshot.authenticated || !hasOfferUnderReview) return;
    const timer = setInterval(() => {
      void loadProgress();
    }, 10_000);
    return () => clearInterval(timer);
  }, [hasOfferUnderReview, loadProgress, snapshot.authenticated, snapshot.currentSubjectId]);

  useEffect(() => {
    if (!revealOfferId || !offers.some((offer) => offer.id === revealOfferId)) return;
    const timer = setTimeout(() => {
      scrollRef.current?.scrollTo({ y: Math.max((progressOffsetsRef.current.get(revealOfferId) ?? 0) - 16, 0), animated: true });
      onOfferRevealed();
    }, 250);
    return () => clearTimeout(timer);
  }, [offers, onOfferRevealed, revealOfferId]);

  useEffect(() => {
    if (!revealListingId || !listings.some((listing) => listing.id === revealListingId)) return;
    const timer = setTimeout(() => {
      scrollRef.current?.scrollTo({ y: Math.max((progressOffsetsRef.current.get(revealListingId) ?? 0) - 16, 0), animated: true });
      if (canManage) setManagedListingId(revealListingId);
      onListingRevealed();
    }, 250);
    return () => clearTimeout(timer);
  }, [canManage, listings, onListingRevealed, revealListingId]);

  useEffect(() => {
    if (!snapshot.authenticated || !resumeAfterLogin) return;
    if (canManage) setMode(resumeAfterLogin);
    setResumeAfterLogin(null);
  }, [canManage, resumeAfterLogin, snapshot.authenticated]);

  useEffect(() => {
    if (!openIntent || !snapshot.authenticated) return;
    if (canManage) setMode(openIntent);
    onIntentOpened();
  }, [canManage, onIntentOpened, openIntent, snapshot.authenticated]);

  useEffect(() => {
    if (!canManage) {
      setMode(null);
      setManagedListingId(null);
    }
  }, [canManage]);

  const openMission = (intent: Intent) => {
    void Haptics.selectionAsync();
    if (!snapshot.authenticated) {
      setResumeAfterLogin(intent);
      onLogin();
      return;
    }
    if (!canManage) return;
    if (providerApproved && !progressWritable) {
      showSyncRequired();
      return;
    }
    setMode(intent);
  };

  const showSyncRequired = () => {
    Alert.alert('先同步最新状态', '当前显示的是上次保存的上架数据。网络恢复并同步完成后即可继续操作。', [
      { text: '知道了' },
      { text: '立即同步', onPress: () => void synchronizeAll() },
    ]);
  };

  const synchronizeAll = async () => {
    await onWorkspaceChanged();
    await loadProgress();
  };

  const withFreshProgress = (action: () => void) => {
    if (!canManage) return;
    if (!progressWritable) { showSyncRequired(); return; }
    action();
  };

  const closeFlow = () => {
    setMode(null);
    void onWorkspaceChanged();
  };

  const confirmReaudit = (offer: OfferTemplate) => {
    if (!canManage) return;
    Alert.alert(
      '重新提交双审？',
      '将使用当前方案和价格材料重新发起资源审与价格审。审核通过后，需要重新选择容量和时段上架。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '确认提交',
          onPress: () => {
            setReauditingOfferId(offer.id);
            void (async () => {
              const finish = async (updatedOffer: OfferTemplate) => {
                const nextOffers = offersRef.current.map((item) => item.id === offer.id ? updatedOffer : item);
                const nextListings = await listSupplierListings();
                offersRef.current = nextOffers; listingsRef.current = nextListings;
                setOffers(nextOffers); setListings(nextListings);
                const identity = progressIdentityRef.current;
                if (identity) await saveProviderProgressCache(identity.accountId, identity.subjectId, {
                  drafts: draftsRef.current, offers: nextOffers, listings: nextListings,
                });
                await onWorkspaceChanged();
                Alert.alert('已提交', '资源审和价格审已重新开始。');
              };
              try {
                const result = await resubmitExpiredOffer(offer.id, offer.version);
                await finish(result.offer);
              } catch (error) {
                if (isAmbiguousMutationFailure(error)) {
                  try {
                    const current = await getSupplierOffer(offer.id);
                    if (offerReauditAccepted(offer, current)) { await finish(current); return; }
                  } catch { /* Keep the result unknown and refresh the whole progress view. */ }
                }
                Alert.alert('暂时没能确认', isAmbiguousMutationFailure(error)
                  ? '网络中断，正在重新读取上架进度，请确认状态后再操作。'
                  : error instanceof Error ? error.message : '请刷新后重试。');
                void loadProgress();
              } finally { setReauditingOfferId(null); }
            })();
          },
        },
      ],
    );
  };

  const confirmAbandonDraft = (draft: OfferWizardDraft) => {
    if (!canManage) return;
    Alert.alert(
      '放弃这份上架草稿？',
      '草稿会从工作台移除，资料已核验的资源不会删除；节点可交付时仍可重新创建方案。',
      [
        { text: '继续保留', style: 'cancel' },
        {
          text: '放弃草稿', style: 'destructive',
          onPress: () => {
            setAbandoningDraftId(draft.id);
            const finish = async () => {
              const nextDrafts = draftsRef.current.filter((item) => item.id !== draft.id);
              draftsRef.current = nextDrafts;
              setDrafts(nextDrafts);
              const identity = progressIdentityRef.current;
              if (identity) await saveProviderProgressCache(identity.accountId, identity.subjectId, {
                drafts: nextDrafts, offers: offersRef.current, listings: listingsRef.current,
              });
              await onWorkspaceChanged();
            };
            void abandonOfferDraft(draft.id, draft.version).then(finish).catch(async (error: unknown) => {
              if (isAmbiguousMutationFailure(error)) {
                try {
                  if (draftAbandonAccepted(draft.id, await listOfferDrafts())) { await finish(); return; }
                } catch { /* Keep the result unknown and reload below. */ }
              }
              Alert.alert('没有放弃成功', error instanceof Error ? error.message : '请同步最新状态后重试。');
              void loadProgress();
            }).finally(() => setAbandoningDraftId(null));
          },
        },
      ],
    );
  };

  return (
    <View nativeID={UNIFIED_PUBLISH_IDENTITY} style={styles.root}>
      <ScrollView ref={scrollRef} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {providerApproved ? (
          <View style={styles.listingSection}>
            <View style={styles.sectionHeading}><View><Text style={styles.sectionTitle}>上架进度</Text><Text style={styles.sectionCaption}>草稿、审核和挂牌</Text></View><Pressable accessibilityRole="button" accessibilityLabel="刷新上架进度" disabled={progressRefreshing} onPress={() => void loadProgress()} style={styles.progressRefresh}><Text style={styles.sectionCount}>{progressState === 'ready' ? `${progressCount} 项` : '—'}</Text>{progressRefreshing ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name="refresh" size={16} color={colors.primary} />}</Pressable></View>
            {readOnly ? <View style={styles.readOnlyNotice}><Ionicons name="eye-outline" size={18} color={colors.primary} /><Text style={styles.readOnlyText}>当前主体为查看权限。你可以查看进度和审核信息，编辑与提交由管理员完成。</Text></View> : null}
            {progressState === 'loading' ? <Card style={styles.progressLoadCard}><ActivityIndicator color={colors.primary} /><Text style={styles.progressLoadText}>正在读取上架进度</Text></Card> : null}
            {progressState === 'error' ? <Card style={styles.progressLoadCard}><Ionicons name="cloud-offline-outline" size={28} color={colors.primary} /><Text style={styles.progressLoadTitle}>没能读取上架进度</Text><Text style={styles.progressLoadText}>{progressError}</Text><Pressable onPress={() => void loadProgress()} style={styles.retryButton}><Text style={styles.retryText}>重新读取</Text></Pressable></Card> : null}
            {progressState === 'ready' ? <>
            {progressError || progressCachedAt || snapshot.providerWorkspaceError ? <View style={styles.syncNotice}><Ionicons name="sync-outline" size={17} color={colors.amber} /><Text style={styles.syncNoticeText}>{progressError ?? (progressCachedAt ? `当前显示${cachedProgressTime(progressCachedAt)}保存的上架状态，${progressRefreshing ? '正在同步最新记录。' : readOnly ? '同步后可查看最新记录。' : '同步完成后可继续管理。'}` : '工作台状态暂时没有同步，当前页面仅供查看。')}</Text><Pressable disabled={progressRefreshing} onPress={() => void synchronizeAll()}><Text style={styles.syncRetry}>{progressRefreshing ? '同步中' : '再试一次'}</Text></Pressable></View> : null}
            {drafts.map((draft) => (
              <Card key={draft.id} style={styles.progressCard}>
                <View style={styles.progressTop}><View style={styles.progressIcon}><Ionicons name="create-outline" size={20} color={colors.primary} /></View><View style={styles.progressCopy}><Text style={styles.progressTitle}>{draft.payload.title || draft.resource.name}</Text><Text style={styles.progressMeta}>上架草稿 · {wizardStepLabel[draft.currentStep]}</Text></View><View style={styles.draftPill}><Text style={styles.draftPillText}>草稿</Text></View></View>
                {canManage ? <View style={styles.draftActions}>
                  <Pressable accessibilityRole="button" accessibilityLabel={`放弃${draft.payload.title || draft.resource.name}上架草稿`} disabled={abandoningDraftId === draft.id} onPress={() => withFreshProgress(() => confirmAbandonDraft(draft))} style={[styles.abandonDraftButton, (!progressWritable || abandoningDraftId === draft.id) && styles.staleAction]}><Ionicons name="trash-outline" size={15} color={colors.red} /><Text style={styles.abandonDraftText}>{abandoningDraftId === draft.id ? '正在放弃' : '放弃'}</Text></Pressable>
                  <Pressable disabled={abandoningDraftId === draft.id} onPress={() => withFreshProgress(() => onOpenOfferWizard({ resumeDraftId: draft.id }))} style={[styles.continueButton, (!progressWritable || abandoningDraftId === draft.id) && styles.staleAction]}><Text style={styles.continueText}>继续填写</Text><Ionicons name="arrow-forward" size={15} color={colors.surface} /></Pressable>
                </View> : null}
              </Card>
            ))}
            {visibleOffers.map((offer) => (
              <View key={offer.id} onLayout={(event) => progressOffsetsRef.current.set(offer.id, event.nativeEvent.layout.y)}>
              <Card style={styles.progressCard}>
                <View style={styles.progressTop}><View style={styles.progressIcon}><Ionicons name="shield-checkmark-outline" size={20} color={colors.primary} /></View><View style={styles.progressCopy}><Text style={styles.progressTitle}>{offer.title}</Text><Text style={styles.progressMeta}>{offerStatusLabel[offer.status]}</Text></View><View style={[styles.offerPill, offer.status === 'approved' && styles.successPill, ['changes_requested', 'rejected'].includes(offer.status) && styles.attentionPill]}><Text style={[styles.offerPillText, offer.status === 'approved' && styles.successPillText, ['changes_requested', 'rejected'].includes(offer.status) && styles.attentionText]}>{offerStatusLabel[offer.status]}</Text></View></View>
                <View style={styles.auditRows}>
                  <AuditState label="资源审" status={offer.audits.resource?.status ?? null} />
                  <AuditState label="价格审" status={offer.audits.price?.status ?? null} />
                </View>
                {['changes_requested', 'rejected'].includes(offer.status) ? (
                  <>
                    <Text style={styles.revisionHelp}>{revisionReason(offer)}</Text>
                    {canManage ? <Pressable onPress={() => withFreshProgress(() => onOpenOfferWizard({ revisionOfferId: offer.id }))} style={[styles.revisionButton, !progressWritable && styles.staleAction]}>
                      <Text style={styles.revisionText}>按意见修改</Text><Ionicons name="arrow-forward" size={15} color={colors.surface} />
                    </Pressable> : null}
                  </>
                ) : null}
                {canManage && offer.status === 'approved' && !listings.some((listing) => listing.offerId === offer.id && ['active', 'paused', 'sold_out'].includes(listing.status)) ? <Pressable onPress={() => withFreshProgress(() => onOpenListing(offer.id))} style={[styles.publishListingButton, !progressWritable && styles.staleAction]}><Text style={styles.publishListingText}>发布可售容量</Text><Ionicons name="arrow-forward" size={15} color={colors.surface} /></Pressable> : null}
                {offer.status === 'expired' ? (
                  <>
                    <Text style={styles.expiredHelp}>审核有效期已结束，原挂牌不会继续销售。</Text>
                    {canManage ? <Pressable
                      disabled={reauditingOfferId === offer.id}
                      onPress={() => withFreshProgress(() => confirmReaudit(offer))}
                      style={[styles.reauditButton, reauditingOfferId === offer.id && styles.disabledButton]}
                    >
                      <Text style={styles.reauditText}>{reauditingOfferId === offer.id ? '正在提交…' : '重新提交双审'}</Text>
                      <Ionicons name="refresh" size={15} color={colors.surface} />
                    </Pressable> : null}
                  </>
                ) : null}
              </Card></View>
            ))}
            {listings.map((listing) => {
              const linkedOffer = offers.find((offer) => offer.id === listing.offerId);
              const scheduled = listing.sellingStage === 'scheduled' || listing.sellingStage === 'scheduled_paused';
              return <View key={listing.id} onLayout={(event) => {
                progressOffsetsRef.current.set(listing.id, event.nativeEvent.layout.y);
                progressOffsetsRef.current.set(listing.offerId, event.nativeEvent.layout.y);
              }}><Card style={styles.progressCard}>
                <View style={styles.progressTop}><View style={styles.progressIcon}><Ionicons name={scheduled ? 'calendar-outline' : 'storefront-outline'} size={20} color={colors.primary} /></View><View style={styles.progressCopy}><Text style={styles.progressTitle}>{linkedOffer?.title ?? '算力挂牌'}</Text><Text style={styles.progressMeta}>{scheduled ? `${shortDate(listing.startsAt)} ${listing.sellingStage === 'scheduled' ? '自动生效' : '原定生效'}` : `${compact(listing.capacityTotal)} ${listing.capacityUnit} · ${creditAmount(listing.unitCredits)} KAI 卡时`}</Text></View><View style={[styles.livePill, listing.sellingStage !== 'selling' && styles.inactivePill, listing.sellingStage === 'scheduled' && styles.scheduledPill]}><Text style={[styles.livePillText, listing.sellingStage !== 'selling' && styles.inactivePillText, listing.sellingStage === 'scheduled' && styles.scheduledPillText]}>{listingStageLabel[listing.sellingStage]}</Text></View></View>
                <View style={styles.stockSummary}>
                  <View><Text style={styles.stockLabel}>{scheduled ? '上架容量' : '可售'}</Text><Text style={styles.stockValue}>{compact(listing.capacityAvailable)} {listing.capacityUnit}</Text></View>
                  <View><Text style={styles.stockLabel}>已预留</Text><Text style={styles.stockValue}>{compact(listing.capacityReserved)} {listing.capacityUnit}</Text></View>
                  <View><Text style={styles.stockLabel}>已售</Text><Text style={styles.stockValue}>{compact(listing.capacitySold)} {listing.capacityUnit}</Text></View>
                </View>
                <View style={styles.selloutEstimate}><Text style={styles.selloutEstimateLabel}>满售预计成交额</Text><Text style={styles.selloutEstimateValue}>{creditAmount(listing.selloutEstimate.grossCredits)} KAI 卡时</Text><Text style={styles.selloutEstimateHint}>{listing.selloutEstimate.disclosure}</Text></View>
                <View style={styles.listingWindow}><Text style={styles.listingWindowLabel}>{scheduled ? '排期时段' : '可售时段'}</Text><Text style={styles.listingWindowValue}>{shortDate(listing.startsAt)} — {shortDate(listing.expiresAt)}</Text></View>
                {canManage ? <Pressable onPress={() => withFreshProgress(() => setManagedListingId(listing.id))} style={[styles.manageButton, !progressWritable && styles.staleAction]}><Text style={styles.manageText}>{progressWritable ? '管理挂牌' : '同步后管理'}</Text><Ionicons name={progressWritable ? 'settings-outline' : 'cloud-offline-outline'} size={16} color={colors.primary} /></Pressable> : null}
              </Card></View>;
            })}
            {progressCount === 0 ? <Text style={styles.emptyProgress}>还没有上架方案。</Text> : null}
            {canManage ? <Pressable onPress={() => withFreshProgress(() => onOpenOfferWizard())} style={[styles.newOfferButton, !progressWritable && styles.staleAction]}><Ionicons name="add" size={19} color={colors.surface} /><Text style={styles.newOfferText}>新建上架方案</Text></Pressable> : null}
            </> : null}
          </View>
        ) : null}

        {!readOnly ? <><Text style={styles.eyebrow}>{providerApproved ? '添加资源' : '资源方入驻'}</Text>
        <Text style={styles.hero}>{providerApproved ? '发布新的算力' : supplierStatus === 'submitted' ? '等待入驻审核' : '先完成资源方入驻'}</Text>
        <Text style={styles.lead}>{providerApproved ? '添加资源，资料核验与节点在线检查完成后再上架。' : '一个账号即可使用算力和提供算力。'}</Text>

        <View style={styles.cards}>
          {missions.map((mission) => (
            <Pressable key={mission.mode} onPress={() => openMission(mission.mode)}>
              <LinearGradient colors={mission.colors} style={styles.card}>
                <Text style={styles.number}>{mission.number}</Text>
                <View style={styles.iconBox}><Ionicons name={mission.icon} size={34} color={colors.primary} /></View>
                <View style={styles.copy}>
                  <View style={styles.tag}><Text style={styles.tagText}>{mission.tag}</Text></View>
                  <Text style={styles.title}>{mission.title}</Text>
                  <Text style={styles.caption}>{mission.caption}</Text>
                </View>
                <View style={styles.arrow}><Ionicons name="arrow-forward" size={26} color={colors.ink} /></View>
              </LinearGradient>
            </Pressable>
          ))}
        </View></> : !providerApproved ? <View style={styles.standaloneReadOnly}><Ionicons name="eye-outline" size={24} color={colors.primary} /><Text style={styles.standaloneReadOnlyTitle}>当前为查看权限</Text><Text style={styles.standaloneReadOnlyText}>你可以查看这个主体的状态，入驻和上架内容由管理员编辑。</Text></View> : null}
      </ScrollView>

      <PublishFlowSheet
        mode={canManage ? mode : null}
        authenticated={snapshot.authenticated}
        onModeChange={setMode}
        onClose={closeFlow}
        onLogin={() => { setMode(null); onLogin(); }}
        onOpenResourceEvidence={(resourceId) => { setMode(null); onOpenResourceEvidence(resourceId); }}
      />
      <ListingManageSheet
        listing={listings.find((item) => item.id === managedListingId) ?? null}
        title={offers.find((offer) => offer.id === listings.find((item) => item.id === managedListingId)?.offerId)?.title ?? '算力挂牌'}
        readOnly={!canManage || !progressWritable}
        onClose={() => setManagedListingId(null)}
        onUpdated={(updated) => {
          const nextListings = listingsRef.current.map((item) => item.id === updated.id ? updated : item);
          listingsRef.current = nextListings;
          setListings(nextListings);
          const identity = progressIdentityRef.current;
          if (identity) void saveProviderProgressCache(identity.accountId, identity.subjectId, {
            drafts: draftsRef.current, offers: offersRef.current, listings: nextListings,
          });
          void onWorkspaceChanged();
        }}
      />
    </View>
  );
}

const wizardStepLabel: Record<OfferWizardDraft['currentStep'], string> = { service: '服务信息', terms: '交付条款', price: '价格材料', review: '提交确认' };
const offerStatusLabel: Record<OfferTemplate['status'], string> = {
  draft: '草稿', under_review: '双审中', changes_requested: '需补充', approved: '双审通过', rejected: '未通过', suspended: '已暂停', expired: '审核已到期',
};
const listingStageLabel: Record<CreditListing['sellingStage'], string> = { scheduled: '待生效', scheduled_paused: '排期已暂停', selling: '销售中', paused: '已暂停', sold_out: '已售罄', expired: '已到期', withdrawn: '已下架', suspended: '已停用' };
function shortDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
function cachedProgressTime(value: string | null) {
  if (!value) return '上次';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '上次';
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
function compact(value: string) { return value.replace(/\.0+$/u, '').replace(/(\.\d*?)0+$/u, '$1'); }
const auditStatusLabel: Record<NonNullable<OfferTemplate['audits']['resource']>['status'], string> = {
  pending: '审核中', approved: '已通过', changes_requested: '需补充', rejected: '未通过', expired: '已过期', cancelled: '已取消',
};
function AuditState({ label, status }: Readonly<{ label: string; status: NonNullable<OfferTemplate['audits']['resource']>['status'] | null }>) {
  const color = status === 'approved' ? colors.green : status === 'changes_requested' || status === 'rejected' ? colors.red : colors.amber;
  return <View style={styles.auditRow}><View style={[styles.auditDot, { backgroundColor: color }]} /><Text style={styles.auditLabel}>{label}</Text><Text style={[styles.auditStatus, { color }]}>{status ? auditStatusLabel[status] : '等待提交'}</Text></View>;
}
function revisionReason(offer: OfferTemplate) {
  const audit = [offer.audits.resource, offer.audits.price].find((item) => item && ['changes_requested', 'rejected'].includes(item.status));
  return audit?.decisionReason ?? (offer.status === 'rejected' ? '请按审核意见修改后重新提交。' : '还有内容需要补充。');
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  content: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 150 },
  eyebrow: { color: colors.primary, fontSize: 12, fontWeight: '900', letterSpacing: 1.2 },
  hero: { color: colors.ink, fontSize: 32, lineHeight: 43, fontWeight: '900', letterSpacing: -1.2, marginTop: 14 },
  lead: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 10, marginBottom: 20 },
  cards: { gap: 12 },
  card: { minHeight: 166, paddingHorizontal: 18, paddingVertical: 19, borderRadius: 24, borderWidth: 1, borderColor: '#D5E5FA', flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  number: { position: 'absolute', right: 18, top: 2, color: 'rgba(15,31,46,0.055)', fontSize: 72, lineHeight: 88, fontWeight: '900' },
  iconBox: { width: 66, height: 66, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.78)' },
  copy: { flex: 1, marginLeft: 15, paddingRight: 4 },
  tag: { alignSelf: 'flex-start', paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.82)' },
  tagText: { color: colors.primaryDark, fontSize: 11, fontWeight: '900' },
  title: { color: colors.ink, fontSize: 21, lineHeight: 28, fontWeight: '900', marginTop: 9 },
  caption: { color: colors.muted, fontSize: 12, lineHeight: 19, marginTop: 5 },
  arrow: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.82)' },
  listingSection: { marginTop: 24 }, sectionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }, sectionTitle: { color: colors.ink, fontSize: 21, fontWeight: '900' }, sectionCaption: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 5, maxWidth: 280 }, progressRefresh: { minWidth: 68, minHeight: 44, paddingHorizontal: 11, borderRadius: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: colors.primarySoft }, sectionCount: { color: colors.primary, fontSize: 11, fontWeight: '900' },
  progressLoadCard: { minHeight: 150, padding: 22, alignItems: 'center', justifyContent: 'center' }, progressLoadTitle: { color: colors.ink, fontSize: 16, fontWeight: '900', marginTop: 10 }, progressLoadText: { color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 8 }, retryButton: { minHeight: 46, marginTop: 14, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', ...ledgerActionButton }, retryText: { ...ledgerActionText, fontSize: 13, fontWeight: '900' },
  syncNotice: { minHeight: 48, marginBottom: 10, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.primarySoft }, syncNoticeText: { flex: 1, color: colors.muted, fontSize: 11, lineHeight: 17 }, syncRetry: { color: colors.primary, fontSize: 11, fontWeight: '900' },
  readOnlyNotice: { minHeight: 58, marginBottom: 10, paddingHorizontal: 13, paddingVertical: 11, borderRadius: 15, flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: colors.primarySoft }, readOnlyText: { flex: 1, color: colors.ink, fontSize: 11, lineHeight: 17 },
  standaloneReadOnly: { marginTop: 42, padding: 24, borderRadius: 22, alignItems: 'center', backgroundColor: colors.surface }, standaloneReadOnlyTitle: { color: colors.ink, fontSize: 17, fontWeight: '900', marginTop: 10 }, standaloneReadOnlyText: { color: colors.muted, fontSize: 11, lineHeight: 18, textAlign: 'center', marginTop: 6 },
  progressCard: { padding: 14, marginBottom: 10 }, progressTop: { flexDirection: 'row', alignItems: 'center' }, progressIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, progressCopy: { flex: 1, marginLeft: 10 }, progressTitle: { color: colors.ink, fontSize: 14, fontWeight: '900' }, progressMeta: { color: colors.muted, fontSize: 12, marginTop: 4 }, draftPill: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.primarySoft }, draftPillText: { color: colors.primary, fontSize: 11, fontWeight: '900' }, offerPill: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.primarySoft }, offerPillText: { color: colors.amber, fontSize: 11, fontWeight: '900' }, successPill: { backgroundColor: colors.greenSoft }, successPillText: { color: colors.green }, attentionPill: { backgroundColor: '#FDECEC' }, attentionText: { color: colors.red }, draftActions: { marginTop: 12, flexDirection: 'row', gap: 8 }, abandonDraftButton: { minHeight: 46, paddingHorizontal: 16, borderRadius: 13, borderWidth: 1, borderColor: '#F3CACA', flexDirection: 'row', gap: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF7F7' }, abandonDraftText: { color: colors.red, fontSize: 12, fontWeight: '900' }, continueButton: { minHeight: 46, flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', ...ledgerActionButton }, continueText: { ...ledgerActionText, fontSize: 13, fontWeight: '900' },
  auditRows: { marginTop: 12, paddingTop: 11, borderTopWidth: 1, borderTopColor: colors.line, flexDirection: 'row', gap: 18 }, auditRow: { flexDirection: 'row', alignItems: 'center' }, auditDot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 }, auditLabel: { color: colors.ink, fontSize: 12, fontWeight: '800' }, auditStatus: { fontSize: 12, fontWeight: '900', marginLeft: 6 }, emptyProgress: { color: colors.muted, fontSize: 12, textAlign: 'center', paddingVertical: 18 }, newOfferButton: { minHeight: 52, marginTop: 3, borderRadius: 17, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, newOfferText: { color: colors.surface, fontSize: 14, fontWeight: '900' },
  publishListingButton: { minHeight: 46, marginTop: 12, borderRadius: 13, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, publishListingText: { color: colors.surface, fontSize: 13, fontWeight: '900' }, livePill: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.greenSoft }, livePillText: { color: colors.green, fontSize: 11, fontWeight: '900' }, inactivePill: { backgroundColor: colors.primarySoft }, inactivePillText: { color: colors.amber }, scheduledPill: { backgroundColor: '#E7F1FF' }, scheduledPillText: { color: colors.blue }, selloutEstimate: { marginTop: 12, padding: 12, borderRadius: 14, backgroundColor: colors.primarySoft }, selloutEstimateLabel: { color: colors.muted, fontSize: 10 }, selloutEstimateValue: { color: colors.primary, fontSize: 17, fontWeight: '900', marginTop: 4 }, selloutEstimateHint: { color: colors.muted, fontSize: 10, marginTop: 5 }, listingWindow: { marginTop: 12, paddingTop: 11, borderTopWidth: 1, borderBottomColor: colors.line, borderTopColor: colors.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, listingWindowLabel: { color: colors.muted, fontSize: 11 }, listingWindowValue: { color: colors.ink, fontSize: 11, fontWeight: '800' },
  expiredHelp: { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: 11 }, reauditButton: { minHeight: 46, marginTop: 9, borderRadius: 13, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, reauditText: { color: colors.surface, fontSize: 13, fontWeight: '900' }, disabledButton: { opacity: 0.55 },
  revisionHelp: { color: colors.red, fontSize: 11, lineHeight: 17, marginTop: 11 },
  revisionButton: { minHeight: 46, marginTop: 9, borderRadius: 13, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  revisionText: { color: colors.surface, fontSize: 13, fontWeight: '900' },
  staleAction: { opacity: 0.55 },
  stockSummary: { marginTop: 12, padding: 12, borderRadius: 13, flexDirection: 'row', justifyContent: 'space-between', backgroundColor: colors.canvas }, stockLabel: { color: colors.muted, fontSize: 11 }, stockValue: { color: colors.ink, fontSize: 12, fontWeight: '900', marginTop: 4 }, manageButton: { minHeight: 46, marginTop: 9, paddingHorizontal: 3, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, manageText: { color: colors.primary, fontSize: 12, fontWeight: '900' },
});
