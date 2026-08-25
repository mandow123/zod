import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics } from 'react-native-safe-area-context';
import { AuthSheet } from './src/AuthSheet';
import {
  loadCachedProviderState,
  loadCloudPaySnapshot,
  loadCloudPayOrder,
  loadDeviceOrder,
  markAllNotificationsRead,
  markNotificationRead,
  selectTradingSubject,
  type CloudPaySnapshot,
  type CloudPayNotification,
  type CloudPayOrder,
  type AftercareReview,
  type MarketCreditListing,
  type DeviceProduct,
  type DeviceOrder,
} from './src/api';
import { AftercareReviewSheet } from './src/AftercareReviewSheet';
import { BottomNav } from './src/components';
import { OfferWizardSheet } from './src/OfferWizardSheet';
import { OrderDetailSheet } from './src/OrderDetailSheet';
import { MarketOrderSheet } from './src/MarketOrderSheet';
import { CreditWalletSheet } from './src/CreditWalletSheet';
import { ListingPublishSheet } from './src/ListingPublishSheet';
import { PublishFlowSheet } from './src/PublishFlowSheet';
import { HomeScreen } from './src/screens/HomeScreen';
import { MarketScreen } from './src/screens/MarketScreen';
import { MessagesScreen } from './src/screens/MessagesScreen';
import { OrdersScreen } from './src/screens/OrdersScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { ProviderResourcesScreen } from './src/screens/ProviderResourcesScreen';
import { ProviderWorkspaceScreen } from './src/screens/ProviderWorkspaceScreen';
import { UnifiedAssetsScreen } from './src/screens/UnifiedAssetsScreen';
import { PublishScreen } from './src/screens/PublishScreen';
import { colors } from './src/theme';
import { getSupplierOffer } from './src/publishing';
import { distributionPolicy } from './src/distribution';
import {
  promoteStoredAuthentication,
  publishStoredAuthentication,
  refreshAfterPendingAuthentication,
} from './src/auth-refresh';
import type { ProviderPublishIntent } from './src/provider-next-navigation';
import {
  acceptVerifiedKaiConsents,
  cancelVerifiedKaiAuth,
  completeKaiAuth,
  isKaiAuthCallback,
  kaiAuthProgressMessage,
  loadKaiAuthProgress,
  resumeVerifiedKaiAuth,
  startKaiAuth,
  KaiLegalDocumentsChangedError,
  type KaiAuthProgress,
} from './src/kai-auth';
import { SparkProductDetailSheet } from './src/SparkProductDetailSheet';
import { DeviceOrderSheet } from './src/DeviceOrderSheet';
import { DeviceOrderDetailSheet } from './src/DeviceOrderDetailSheet';
import { CreditPayoutSheet } from './src/CreditPayoutSheet';
import { beginSubjectTransition, initialSnapshot, mergeSnapshot } from './src/snapshot-state';
import { CreditScreen } from './src/screens/CreditScreen';
import { deviceProductAvailability, marketAvailability } from './src/market-availability';
import { CreatorCollaborationScreen } from './src/screens/CreatorCollaborationScreen';
import { CreatorRewardSheet } from './src/CreatorRewardSheet';
import {
  attributeCreatorReferral, consumeCreatorRewardEvent, loadCreatorRewardEvents,
  parseCreatorReferralToken, type CreatorRewardEvent,
} from './src/creator-commissions';
import { InquiryComposerSheet } from './src/InquiryComposerSheet';
import { MyInquiriesSheet } from './src/MyInquiriesSheet';
import type { InquiryCatalogCandidate } from './src/resource-inquiries';
import { startKaiOidcRevocationRetry } from './src/kai-revocation-queue';
import { loadSession, reconcileCommittedKaiOidcSession, type StoredSession } from './src/session';
import { StagingDemoShell } from './src/StagingDemoShell';
import { StagingEnvironmentBanner } from './src/StagingEnvironmentBanner';
import { LocalQixiangPreviewShell } from './src/LocalQixiangPreviewShell';
import {
  messageNavigationIntent,
  providerNextIntent,
  resolveProviderOfferMessageIntent,
  type AppNavigationIntent,
  type OrderSide,
} from './src/core/app-navigation-intents';
import { useAppLifecycle } from './src/core/use-app-lifecycle';
import { primaryTabFor, type AppRouteKey } from './src/navigation';
import { normalizeMobileRoute } from './src/feature-flags';

const FRONTEND_IDENTITY = 'KAI_CLOUD_UNIFIED_ASSETS_V2';
const APP_LIFECYCLE_ADAPTERS = {
  linking: Linking,
  appState: AppState,
  notifications: Notifications,
} as const;

function CloudPayApp() {
  const [activeTab, setActiveTab] = useState<AppRouteKey>('home');
  const [orderSide, setOrderSide] = useState<OrderSide>('buyer');
  const [snapshot, setSnapshot] = useState<CloudPaySnapshot>(initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [authVisible, setAuthVisible] = useState(false);
  const [kaiAuthBusy, setKaiAuthBusy] = useState(false);
  const [kaiAuthError, setKaiAuthError] = useState<string | null>(null);
  const [kaiAuthProgress, setKaiAuthProgress] = useState<KaiAuthProgress | null>(null);
  const [kaiAuthRestoring, setKaiAuthRestoring] = useState(false);
  const [demandComposerVisible, setDemandComposerVisible] = useState(false);
  const [resourceToOpenId, setResourceToOpenId] = useState<string | null>(null);
  const [offerWizard, setOfferWizard] = useState<null | Readonly<{
    resumeDraftId?: string;
    resourceId?: string;
    revisionOfferId?: string;
  }>>(null);
  const [listingOfferId, setListingOfferId] = useState<string | null>(null);
  const [publishOfferToReveal, setPublishOfferToReveal] = useState<string | null>(null);
  const [publishListingToManage, setPublishListingToManage] = useState<string | null>(null);
  const [publishIntentToOpen, setPublishIntentToOpen] = useState<ProviderPublishIntent | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<CloudPayOrder | null>(null);
  const [selectedOrderSource, setSelectedOrderSource] = useState<'formal' | 'staging'>('formal');
  const [selectedListing, setSelectedListing] = useState<MarketCreditListing | null>(null);
  const [selectedSparkProduct, setSelectedSparkProduct] = useState<DeviceProduct | null>(null);
  const [selectedDeviceProduct, setSelectedDeviceProduct] = useState<DeviceProduct | null>(null);
  const [selectedDeviceOrder, setSelectedDeviceOrder] = useState<DeviceOrder | null>(null);
  const [payoutVisible, setPayoutVisible] = useState(false);
  const [selectedReview, setSelectedReview] = useState<AftercareReview | null>(null);
  const [creditWalletVisible, setCreditWalletVisible] = useState(false);
  const [creatorReward, setCreatorReward] = useState<CreatorRewardEvent | null>(null);
  const [pendingReferralToken, setPendingReferralToken] = useState<string | null>(null);
  const [pendingNotificationId, setPendingNotificationId] = useState<string | null>(null);
  const [selectedInquiryCandidate, setSelectedInquiryCandidate] = useState<InquiryCatalogCandidate | null>(null);
  const [myInquiriesVisible, setMyInquiriesVisible] = useState(false);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshGeneration = useRef(0);
  const handledUrls = useRef(new Set<string>());

  const refresh = useCallback(async (force = false) => {
    if (refreshInFlight.current && !force) return refreshInFlight.current;
    const generation = ++refreshGeneration.current;
    const operation = (async () => {
      setRefreshing(true);
      try {
        const next = await loadCloudPaySnapshot();
        if (generation !== refreshGeneration.current) return;
        setSnapshot((current) => mergeSnapshot(current, next));
        setSelectedOrder((current) => current ? next.orders.find((item) => item.id === current.id) ?? current : null);
        setSelectedReview((current) => current ? next.aftercareReviews.find((item) => item.refundId === current.refundId) ?? current : null);
      } finally {
        if (generation === refreshGeneration.current) setRefreshing(false);
      }
    })();
    refreshInFlight.current = operation;
    try { await operation; } finally {
      if (refreshInFlight.current === operation) refreshInFlight.current = null;
    }
  }, []);

  const refreshAfterAuthentication = useCallback(async () => {
    await refreshAfterPendingAuthentication(refreshInFlight.current, refresh);
  }, [refresh]);

  const publishKaiSession = useCallback(async (session: StoredSession) => {
    await publishStoredAuthentication(
      refreshInFlight.current,
      session,
      (stored) => setSnapshot((current) => promoteStoredAuthentication(current, stored.user)),
      () => refresh(true),
    );
  }, [refresh]);

  const restoreKaiAuthStatus = useCallback(async () => {
    try {
      if (await loadSession()) {
        setKaiAuthProgress(null);
        return;
      }
      const progress = await loadKaiAuthProgress();
      setKaiAuthProgress(progress);
    } catch (reason) {
      setKaiAuthError(reason instanceof Error ? reason.message : '账号验证状态无法安全读取。');
    }
  }, []);

  useEffect(() => { void restoreKaiAuthStatus(); }, [restoreKaiAuthStatus]);

  const restoreStoredKaiSession = useCallback(async () => {
    try {
      const stored = await loadSession();
      if (!stored) return;
      const session = await reconcileCommittedKaiOidcSession(stored);
      await publishKaiSession(session);
      setKaiAuthProgress(null);
    } catch (reason) {
      setKaiAuthError(reason instanceof Error ? reason.message : '登录状态无法安全读取。');
    }
  }, [publishKaiSession]);

  useEffect(() => { void restoreStoredKaiSession(); }, [restoreStoredKaiSession]);

  const handleUrl = useCallback(async (url: string | null, isActive: () => boolean) => {
    if (!url || handledUrls.current.has(url)) return;
    const referralToken = parseCreatorReferralToken(url);
    if (referralToken) {
      handledUrls.current.add(url);
      setPendingReferralToken(referralToken);
      return;
    }
    if (!isKaiAuthCallback(url)) return;
    handledUrls.current.add(url);
    setAuthVisible(true);
    setKaiAuthBusy(true);
    setKaiAuthError(null);
    try {
      const progress = await completeKaiAuth(url);
      if (isActive() && progress) setKaiAuthProgress(progress);
    } catch (reason) {
      if (isActive()) setKaiAuthError(reason instanceof Error ? reason.message : '统一身份登录失败，请重试。');
    } finally {
      if (isActive()) setKaiAuthBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!authVisible || kaiAuthBusy) return;
    let active = true;
    setKaiAuthRestoring(true);
    void resumeVerifiedKaiAuth().then((progress) => {
      if (active && progress) setKaiAuthProgress(progress);
    }).catch((reason) => {
      if (active) setKaiAuthError(reason instanceof Error ? reason.message : '账号验证状态无法恢复。');
    }).finally(() => { if (active) setKaiAuthRestoring(false); });
    return () => { active = false; };
  }, [authVisible, kaiAuthBusy]);

  useEffect(() => {
    if (!pendingReferralToken) return;
    if (!snapshot.authenticated) { setAuthVisible(true); return; }
    const token = pendingReferralToken;
    setPendingReferralToken(null);
    void attributeCreatorReferral(token).then(() => {
      setAuthVisible(false);
      Alert.alert('推广关系已确认', '完成订单后，返佣将按规则进入达人合作记录。');
    }).catch((reason) => {
      Alert.alert('推广链接暂不可用', reason instanceof Error ? reason.message : '请重新打开推广链接。');
    });
  }, [pendingReferralToken, snapshot.authenticated]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => startKaiOidcRevocationRetry((message) => {
    Alert.alert('登录安全提醒', message);
  }), []);

  const handleAppActive = useCallback(() => {
    void refresh();
    void restoreStoredKaiSession();
    void restoreKaiAuthStatus();
  }, [refresh, restoreKaiAuthStatus, restoreStoredKaiSession]);

  useEffect(() => {
    if (activeTab !== 'messages' || !snapshot.authenticated) return;
    void refresh();
  }, [activeTab, refresh, snapshot.authenticated]);

  useEffect(() => {
    let active = true;
    if (!snapshot.authenticated) { setCreatorReward(null); return () => { active = false; }; }
    void loadCreatorRewardEvents(1).then((events) => {
      if (active) setCreatorReward((current) => current ?? events[0] ?? null);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [snapshot.authenticated, snapshot.currentSubjectId]);

  useEffect(() => {
    if (snapshot.authenticated && snapshot.providerWorkspace?.canManage === true) return;
    setOfferWizard(null);
    setListingOfferId(null);
  }, [snapshot.authenticated, snapshot.currentSubjectId, snapshot.providerWorkspace?.canManage]);

  useEffect(() => {
    let active = true;
    void loadCachedProviderState().then((cached) => {
      if (!active || !cached) return;
      setSnapshot((current) => current.loading && !current.authenticated ? {
        ...current,
        authenticated: true,
        user: cached.user,
        sessionState: 'offline',
        subjects: [cached.workspace.subject],
        currentSubjectId: cached.subjectId,
        providerWorkspace: cached.workspace,
        providerWorkspaceCachedAt: cached.cachedAt,
      } : current);
    });
    return () => { active = false; };
  }, []);

  const navigate = useCallback((tab: AppRouteKey) => {
    setActiveTab(normalizeMobileRoute(tab));
  }, []);

  const executeNavigationIntent = useCallback(async (intent: AppNavigationIntent) => {
    switch (intent.kind) {
      case 'navigate':
        setActiveTab(normalizeMobileRoute(intent.tab));
        return;
      case 'open-order':
        setOrderSide(intent.side);
        setSelectedOrderSource('formal');
        setActiveTab(intent.tab);
        setSelectedOrder(await loadCloudPayOrder(intent.orderId));
        return;
      case 'open-resource':
        setActiveTab('resources');
        setResourceToOpenId(intent.resourceId);
        return;
      case 'open-offer-wizard':
        setActiveTab('publish');
        setOfferWizard(intent.offerWizard);
        return;
      case 'open-publish-intent':
        setActiveTab('publish');
        setPublishIntentToOpen(intent.publishIntent);
        return;
      case 'reveal-offer':
        setActiveTab('publish');
        setPublishOfferToReveal(intent.offerId);
        return;
      case 'publish-listing':
        setActiveTab('publish');
        setListingOfferId(intent.offerId);
        return;
      case 'manage-listing':
        setActiveTab('publish');
        setPublishListingToManage(intent.listingId);
    }
  }, []);

  const openProviderNextAction = useCallback(async (route: string, entityId: string | null) => {
    const canResumeRevisionDraft = snapshot.providerWorkspace?.resume?.kind === 'wizard_draft'
      && snapshot.providerWorkspace.resume.id === entityId;
    try {
      await executeNavigationIntent(providerNextIntent(route, entityId, canResumeRevisionDraft));
    } catch (caught) {
      Alert.alert('没能打开订单', caught instanceof Error ? caught.message : '请稍后重试。');
    }
  }, [executeNavigationIntent, snapshot.providerWorkspace?.resume]);

  const openProviderWorkspaceNextAction = useCallback((route: string, entityId: string | null) => {
    void Haptics.selectionAsync();
    return openProviderNextAction(route, entityId);
  }, [openProviderNextAction]);

  const chooseSubject = useCallback(async (subjectId: string) => {
    try {
      const selected = await selectTradingSubject(subjectId);
      refreshGeneration.current += 1;
      setSnapshot((current) => beginSubjectTransition(current, selected.id));
      setSelectedOrder(null);
      setSelectedReview(null);
      setSelectedListing(null);
      setSelectedSparkProduct(null);
      setSelectedDeviceProduct(null);
      setSelectedDeviceOrder(null);
      setPayoutVisible(false);
      setCreditWalletVisible(false);
      setCreatorReward(null);
      setOfferWizard(null);
      setListingOfferId(null);
      setPublishOfferToReveal(null);
      setPublishListingToManage(null);
      setResourceToOpenId(null);
    } finally {
      await refresh(true);
    }
  }, [refresh]);

  const markRead = useCallback(async (notificationId: string) => {
    setSnapshot((current) => {
      const target = current.notifications.find((item) => item.id === notificationId);
      if (!target || target.read) return current;
      return {
        ...current,
        unreadCount: Math.max(0, current.unreadCount - 1),
        notifications: current.notifications.map((item) => item.id === notificationId
          ? { ...item, read: true, readAt: new Date().toISOString() }
          : item),
      };
    });
    try {
      await markNotificationRead(notificationId);
    } catch {
      await refresh();
    }
  }, [refresh]);

  const markAllRead = useCallback(async () => {
    setSnapshot((current) => ({
      ...current,
      unreadCount: 0,
      notifications: current.notifications.map((item) => ({
        ...item, read: true, readAt: item.readAt ?? new Date().toISOString(),
      })),
    }));
    try {
      await markAllNotificationsRead();
    } catch {
      await refresh();
    }
  }, [refresh]);

  const openSparkDetail = useCallback((product: DeviceProduct) => {
    setSelectedSparkProduct(product);
  }, []);

  const openMessage = useCallback(async (message: CloudPayNotification) => {
    try {
      if (!message.read) await markRead(message.id);
      const subjectId = typeof message.data.subjectId === 'string' ? message.data.subjectId : null;
      if (subjectId && subjectId !== snapshot.currentSubjectId) {
        await selectTradingSubject(subjectId);
        await refresh();
      }
      const directIntent = messageNavigationIntent(message);
      if (directIntent) {
        await executeNavigationIntent(directIntent);
        return;
      }
      if (message.data.route !== 'provider_offer' || typeof message.data.offerId !== 'string') return;
      const intent = await resolveProviderOfferMessageIntent(
        message.data.offerId,
        () => setActiveTab('publish'),
        async (offerId) => (await getSupplierOffer(offerId)).status,
      );
      await executeNavigationIntent(intent);
    } catch (reason) {
      Alert.alert('暂时无法打开', reason instanceof Error ? reason.message : '请稍后再试。');
      await refresh();
    }
  }, [executeNavigationIntent, markRead, refresh, snapshot.currentSubjectId]);

  const captureNotification = useCallback((response: Notifications.NotificationResponse | null) => {
    const notificationId = response?.notification.request.content.data?.notificationId;
    if (typeof notificationId !== 'string') return;
    setPendingNotificationId(notificationId);
    setActiveTab('messages');
  }, []);

  useAppLifecycle({
    onUrl: handleUrl,
    onAppActive: handleAppActive,
    onNotificationResponse: captureNotification,
  }, APP_LIFECYCLE_ADAPTERS);

  useEffect(() => {
    if (!pendingNotificationId || snapshot.loading) return;
    const message = snapshot.notifications.find((item) => item.id === pendingNotificationId);
    if (!message) {
      if (snapshot.authenticated) setPendingNotificationId(null);
      return;
    }
    setPendingNotificationId(null);
    void openMessage(message);
  }, [openMessage, pendingNotificationId, snapshot.authenticated, snapshot.loading, snapshot.notifications]);

  const page = (() => {
    switch (normalizeMobileRoute(activeTab)) {
      case 'market':
        return <MarketScreen snapshot={snapshot} refreshing={refreshing} onRefresh={refresh}
          onOpenPublish={() => setDemandComposerVisible(true)} onBuy={setSelectedListing}
          onOpenSparkDetail={openSparkDetail} onLogin={() => setAuthVisible(true)}
          onOpenInquiry={setSelectedInquiryCandidate} onOpenMyInquiries={() => setMyInquiriesVisible(true)}
          onManageOwnListing={(listing) => {
            setPublishListingToManage(listing.id);
            setActiveTab('publish');
          }} />;
      case 'assets':
        return <UnifiedAssetsScreen snapshot={snapshot} refreshing={refreshing} onRefresh={refresh}
          onLogin={() => setAuthVisible(true)} onOpenCredits={() => navigate('credits')} onOpenOrder={(orderId) => void loadCloudPayOrder(orderId).then((order) => { setSelectedOrderSource('formal'); setSelectedOrder(order); }).catch((reason) => Alert.alert('没能打开订单', reason instanceof Error ? reason.message : '请稍后重试。'))}
          onOpenDeviceOrder={(orderId) => void loadDeviceOrder(orderId).then(setSelectedDeviceOrder).catch((reason) => Alert.alert('没能打开订单', reason instanceof Error ? reason.message : '请稍后重试。'))}
          onOpenMarket={() => navigate('market')} onOpenProviderAssets={(resourceId) => { setResourceToOpenId(resourceId ?? null); navigate('resources'); }} onOpenPublish={() => navigate('publish')}
          onOpenPayout={() => setPayoutVisible(true)} />;
      case 'credits':
        return <CreditScreen snapshot={snapshot} refreshing={refreshing} onRefresh={refresh}
          onLogin={() => setAuthVisible(true)} onOpenWallet={() => setCreditWalletVisible(true)}
          onOpenPayout={() => setPayoutVisible(true)} />;
      case 'orders':
        return <OrdersScreen snapshot={snapshot} side={orderSide} refreshing={refreshing} onRefresh={refresh}
          onMarket={() => navigate(orderSide === 'provider' ? 'workspace' : 'market')} onLogin={() => setAuthVisible(true)}
          onOpenOrder={(order) => { setSelectedOrderSource('formal'); setSelectedOrder(order); }}
          onOpenStagingOrder={(order) => { setSelectedOrderSource('staging'); setSelectedOrder(order); }}
          onOpenReview={setSelectedReview} />;
      case 'workspace':
        return <ProviderWorkspaceScreen
          snapshot={snapshot}
          refreshing={refreshing}
          onRefresh={refresh}
          onNext={openProviderWorkspaceNextAction}
          onLogin={() => setAuthVisible(true)}
          onOpenOrder={(order) => { setSelectedOrderSource('formal'); setSelectedOrder(order); }}
          onOpenDeviceOrder={setSelectedDeviceOrder}
          onAllOrders={() => { setOrderSide('provider'); navigate('orders'); }}
        />;
      case 'resources':
        return <ProviderResourcesScreen
          snapshot={snapshot}
          refreshing={refreshing}
          onRefresh={refresh}
          onAdd={() => navigate('publish')}
          onNext={openProviderNextAction}
          onLogin={() => setAuthVisible(true)}
          openResourceId={resourceToOpenId}
          onOpenHandled={() => setResourceToOpenId(null)}
        />;
      case 'publish':
        return <PublishScreen
          snapshot={snapshot}
          onLogin={() => setAuthVisible(true)}
          onWorkspaceChanged={refresh}
          onOpenOfferWizard={(options) => setOfferWizard(options ?? {})}
          onOpenListing={(offerId) => setListingOfferId(offerId)}
          onOpenResourceEvidence={(resourceId) => { setResourceToOpenId(resourceId); navigate('resources'); }}
          openIntent={publishIntentToOpen}
          onIntentOpened={() => setPublishIntentToOpen(null)}
          revealOfferId={publishOfferToReveal}
          onOfferRevealed={() => setPublishOfferToReveal(null)}
          revealListingId={publishListingToManage}
          onListingRevealed={() => setPublishListingToManage(null)}
        />;
      case 'messages':
        return <MessagesScreen snapshot={snapshot} refreshing={refreshing} onRefresh={refresh} onMarkRead={markRead}
          onMarkAllRead={markAllRead} onOpenMessage={(message) => void openMessage(message)} onOpenProfile={() => navigate('profile')} />;
      case 'creator':
        return <CreatorCollaborationScreen snapshot={snapshot} onLogin={() => setAuthVisible(true)}
          onTransferred={(event) => { setCreatorReward(event); void refresh(); }} />;
      case 'profile':
        return <ProfileScreen snapshot={snapshot} kaiAuthProgress={snapshot.authenticated ? null : kaiAuthProgress}
          onSelectSubject={(subjectId) => void chooseSubject(subjectId)} onSessionChanged={refresh} onLogin={() => setAuthVisible(true)}
          onOpenQualification={() => { setPublishIntentToOpen('supplier'); navigate('publish'); }} onOpenCredits={() => navigate('credits')}
          onOpenWallet={() => setCreditWalletVisible(true)}
          onOpenOrders={() => { setOrderSide('buyer'); navigate('orders'); }} onOpenAssets={() => navigate('assets')}
          onOpenCreatorCollaboration={() => navigate('creator')}
          onOpenPayout={() => setPayoutVisible(true)}
          onOpenMessages={() => navigate('messages')} />;
      case 'home':
      default:
        return <HomeScreen snapshot={snapshot} refreshing={refreshing} onRefresh={refresh} onNavigate={navigate}
            onOpenDemand={() => setDemandComposerVisible(true)} onOpenSparkDetail={openSparkDetail}
            onOpenCredits={() => navigate('credits')} />;
    }
  })();

  const selectedSparkAvailability = selectedSparkProduct
    ? deviceProductAvailability(marketAvailability(snapshot, distributionPolicy.newOrders), selectedSparkProduct)
    : { allowed: false, reason: null };
  const selectedDeviceAvailability = selectedDeviceProduct
    ? deviceProductAvailability(marketAvailability(snapshot, distributionPolicy.newOrders), selectedDeviceProduct)
    : { allowed: false, reason: null };

  return (
    <SafeAreaView nativeID={FRONTEND_IDENTITY} style={styles.safeArea} edges={['top', 'left', 'right']}>
      <StatusBar style="dark" />
      <StagingEnvironmentBanner />
      <View style={styles.page}>{page}</View>
      {!snapshot.authenticated && kaiAuthProgress ? <Pressable
        accessibilityRole="button"
        accessibilityLabel="继续完成账号连接"
        onPress={() => setAuthVisible(true)}
        style={styles.authStatusBar}
      >
        <View style={styles.authStatusDot} />
        <Text numberOfLines={2} style={styles.authStatusText}>{kaiAuthProgressMessage(kaiAuthProgress)}</Text>
        <Text style={styles.authStatusAction}>继续</Text>
      </Pressable> : null}
      <BottomNav active={primaryTabFor[activeTab]} onChange={navigate} unread={snapshot.unreadCount} />
      <AuthSheet
        visible={authVisible}
        onClose={() => { setAuthVisible(false); setKaiAuthError(null); }}
        onSignedIn={refreshAfterAuthentication}
        kaiAuthBusy={kaiAuthBusy || kaiAuthRestoring}
        kaiAuthError={kaiAuthError}
        kaiAuthProgress={kaiAuthProgress}
        onKaiAuthStart={async () => {
          setKaiAuthError(null);
          setKaiAuthBusy(true);
          try {
            const progress = await startKaiAuth();
            if (progress) setKaiAuthProgress(progress);
          }
          catch (reason) {
            setKaiAuthError(reason instanceof Error ? reason.message : '无法打开统一身份登录。');
            await restoreKaiAuthStatus();
          } finally {
            setKaiAuthBusy(false);
          }
        }}
        onKaiPlatformRetry={async () => {
          setKaiAuthError(null);
          setKaiAuthBusy(true);
          try {
            const progress = await resumeVerifiedKaiAuth();
            if (!progress) throw new Error('KAI 账号验证已过期，请重新登录。');
            setKaiAuthProgress(progress);
          } finally {
            setKaiAuthBusy(false);
          }
        }}
        onKaiConsent={async (documents) => {
          setKaiAuthError(null);
          try {
            const session = await acceptVerifiedKaiConsents(documents);
            await publishKaiSession(session);
            setKaiAuthProgress(null);
            setAuthVisible(false);
          } catch (reason) {
            if (reason instanceof KaiLegalDocumentsChangedError) {
              setKaiAuthProgress({
                kind: 'consent_required', reason: 'legal_consent_required',
                lastAttemptAt: new Date().toISOString(), documents: reason.documents,
              });
            } else await restoreKaiAuthStatus();
            throw reason;
          }
        }}
        onKaiAuthCancel={async () => {
          setKaiAuthError(null);
          await cancelVerifiedKaiAuth();
          setKaiAuthProgress(null);
        }}
      />
      <PublishFlowSheet
        mode={demandComposerVisible ? 'buy' : null}
        authenticated={snapshot.authenticated}
        onModeChange={() => undefined}
        onClose={() => setDemandComposerVisible(false)}
        onLogin={() => { setDemandComposerVisible(false); setAuthVisible(true); }}
      />
      <InquiryComposerSheet
        candidate={selectedInquiryCandidate}
        visible={selectedInquiryCandidate !== null}
        authenticated={snapshot.authenticated}
        onLogin={() => { setSelectedInquiryCandidate(null); setAuthVisible(true); }}
        onClose={() => setSelectedInquiryCandidate(null)}
        onSubmitted={() => undefined}
      />
      <MyInquiriesSheet
        visible={myInquiriesVisible}
        authenticated={snapshot.authenticated}
        onLogin={() => { setMyInquiriesVisible(false); setAuthVisible(true); }}
        onClose={() => setMyInquiriesVisible(false)}
      />
      <OfferWizardSheet
        visible={offerWizard !== null}
        resumeDraftId={offerWizard?.resumeDraftId}
        initialResourceId={offerWizard?.resourceId}
        revisionOfferId={offerWizard?.revisionOfferId}
        onClose={() => { setOfferWizard(null); void refresh(); }}
        onSubmitted={refresh}
      />
      <ListingPublishSheet
        visible={listingOfferId !== null}
        offerId={listingOfferId}
        onClose={() => setListingOfferId(null)}
        onPublished={refresh}
      />
      <MarketOrderSheet
        listing={distributionPolicy.newOrders ? selectedListing : null}
        balance={snapshot.creditBalance}
        authenticated={snapshot.authenticated}
        onClose={() => setSelectedListing(null)}
        onLogin={() => { setSelectedListing(null); setAuthVisible(true); }}
        onNeedCredits={() => { setSelectedListing(null); setCreditWalletVisible(true); }}
        onCreated={(order) => {
          setSelectedOrderSource('formal');
          setSelectedOrder(order);
          void refresh().catch(() => undefined);
        }}
      />
      {snapshot.authenticated || distributionPolicy.stagingDemo ? <CreditWalletSheet
        visible={creditWalletVisible}
        balance={snapshot.creditBalance}
        qixiangCapability={snapshot.qixiangTopupCapability}
        userId={snapshot.user?.id ?? null}
        subjectId={snapshot.currentSubjectId}
        onClose={() => setCreditWalletVisible(false)} onChanged={refresh}
        onOpenSupport={() => { setCreditWalletVisible(false); navigate('messages'); }}
      /> : null}
      <OrderDetailSheet order={selectedOrder} source={selectedOrderSource} onClose={() => setSelectedOrder(null)} onChanged={refresh} />
      <AftercareReviewSheet review={selectedReview} onClose={() => setSelectedReview(null)} onChanged={refresh} />
      <SparkProductDetailSheet product={selectedSparkProduct} visible={selectedSparkProduct !== null}
        purchaseAllowed={selectedSparkAvailability.allowed} blockedReason={selectedSparkAvailability.reason}
        onClose={() => setSelectedSparkProduct(null)} onBuy={(product) => { setSelectedSparkProduct(null); if (snapshot.authenticated) setSelectedDeviceProduct(product); else setAuthVisible(true); }} />
      <DeviceOrderSheet product={selectedDeviceProduct} balance={snapshot.creditBalance} authenticated={snapshot.authenticated}
        purchaseAllowed={selectedDeviceAvailability.allowed} blockedReason={selectedDeviceAvailability.reason}
        onClose={() => setSelectedDeviceProduct(null)} onLogin={() => { setSelectedDeviceProduct(null); setAuthVisible(true); }}
        onNeedCredits={() => { setSelectedDeviceProduct(null); setCreditWalletVisible(true); }}
        onCreated={() => refresh()} />
      <DeviceOrderDetailSheet order={selectedDeviceOrder}
        product={selectedDeviceOrder ? snapshot.deviceProducts.find((item) => item.id === selectedDeviceOrder.productId) ?? null : null}
        onClose={() => setSelectedDeviceOrder(null)} onChanged={refresh} />
      <CreditPayoutSheet visible={payoutVisible} balance={snapshot.creditBalance} profile={snapshot.payoutProfile}
        onClose={() => setPayoutVisible(false)} onCreated={() => refresh()} />
      <CreatorRewardSheet event={creatorReward}
        onClose={() => {
          const event = creatorReward; setCreatorReward(null);
          if (event) void consumeCreatorRewardEvent(event.eventId).catch(() => undefined);
        }}
        onOpenMarket={() => {
          const event = creatorReward; setCreatorReward(null); navigate('market');
          if (event) void consumeCreatorRewardEvent(event.eventId).catch(() => undefined);
        }} />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <LocalQixiangPreviewShell><StagingDemoShell><CloudPayApp /></StagingDemoShell></LocalQixiangPreviewShell>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.canvas },
  page: { flex: 1 },
  authStatusBar: { minHeight: 48, marginHorizontal: 12, marginBottom: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 13, flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: colors.primarySoft, borderWidth: 1, borderColor: '#C9DDF7' },
  authStatusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
  authStatusText: { flex: 1, color: colors.primaryDark, fontSize: 10, lineHeight: 14, fontWeight: '700' },
  authStatusAction: { color: colors.primary, fontSize: 10, fontWeight: '900' },
});
