import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, StyleSheet, View } from 'react-native';
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
import { BottomNav, type TabKey } from './src/components';
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
import { refreshAfterPendingAuthentication } from './src/auth-refresh';
import {
  providerNextNavigation, providerOfferMessageDestination, type ProviderPublishIntent,
} from './src/provider-next-navigation';
import { completeKaiAuth, isKaiAuthCallback, startKaiAuth } from './src/kai-auth';
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

const FRONTEND_IDENTITY = 'KAI_CLOUD_UNIFIED_ASSETS_V2';

function CloudPayApp() {
  const [activeTab, setActiveTab] = useState<TabKey>('home');
  const [orderSide, setOrderSide] = useState<'buyer' | 'provider'>('buyer');
  const [snapshot, setSnapshot] = useState<CloudPaySnapshot>(initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [authVisible, setAuthVisible] = useState(false);
  const [kaiAuthBusy, setKaiAuthBusy] = useState(false);
  const [kaiAuthError, setKaiAuthError] = useState<string | null>(null);
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
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshGeneration = useRef(0);

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

  useEffect(() => {
    let active = true;
    const handled = new Set<string>();
    const handleUrl = async (url: string | null) => {
      if (!url || handled.has(url)) return;
      const referralToken = parseCreatorReferralToken(url);
      if (referralToken) {
        handled.add(url);
        setPendingReferralToken(referralToken);
        return;
      }
      if (!isKaiAuthCallback(url)) return;
      handled.add(url);
      setAuthVisible(true);
      setKaiAuthBusy(true);
      setKaiAuthError(null);
      try {
        if (await completeKaiAuth(url)) {
          await refreshAfterAuthentication();
          if (active) setAuthVisible(false);
        }
      } catch (reason) {
        if (active) setKaiAuthError(reason instanceof Error ? reason.message : '统一身份登录失败，请重试。');
      } finally {
        if (active) setKaiAuthBusy(false);
      }
    };
    void Linking.getInitialURL().then(handleUrl);
    const subscription = Linking.addEventListener('url', ({ url }) => { void handleUrl(url); });
    return () => { active = false; subscription.remove(); };
  }, [refreshAfterAuthentication]);

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

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

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

  const navigate = useCallback((tab: TabKey) => {
    void Haptics.selectionAsync();
    setActiveTab(tab);
  }, []);

  const openProviderNextAction = useCallback(async (route: string, entityId: string | null) => {
    const destination = providerNextNavigation(route, entityId);
    navigate(destination.tab);
    if (destination.orderId) {
      try {
        setSelectedOrder(await loadCloudPayOrder(destination.orderId));
      } catch (caught) {
        Alert.alert('没能打开订单', caught instanceof Error ? caught.message : '请稍后重试。');
      }
    }
    if (destination.resourceId) setResourceToOpenId(destination.resourceId);
    if (destination.offerResourceId) setOfferWizard({ resourceId: destination.offerResourceId });
    if (destination.publishIntent) setPublishIntentToOpen(destination.publishIntent);
    if (destination.resumeDraftId) setOfferWizard({ resumeDraftId: destination.resumeDraftId });
    if (destination.revisionOfferId) {
      const resumeDraft = snapshot.providerWorkspace?.resume?.kind === 'wizard_draft'
        && snapshot.providerWorkspace.resume.id === destination.revisionOfferId;
      setOfferWizard(resumeDraft
        ? { resumeDraftId: destination.revisionOfferId }
        : { revisionOfferId: destination.revisionOfferId });
    }
    if (destination.revealOfferId) setPublishOfferToReveal(destination.revealOfferId);
    if (destination.listingOfferId) setListingOfferId(destination.listingOfferId);
    if (destination.manageListingId) setPublishListingToManage(destination.manageListingId);
  }, [navigate, snapshot.providerWorkspace?.resume]);

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
      if (message.data.route === 'provider_order' && typeof message.data.orderId === 'string') {
        setActiveTab('messages');
        setSelectedOrder(await loadCloudPayOrder(message.data.orderId));
        return;
      }
      if (message.data.route === 'buyer_order' && typeof message.data.orderId === 'string') {
        setActiveTab('orders');
        setSelectedOrder(await loadCloudPayOrder(message.data.orderId));
        return;
      }
      if (message.data.route === 'provider_resource' && typeof message.data.resourceId === 'string') {
        setResourceToOpenId(message.data.resourceId);
        setActiveTab('resources');
        return;
      }
      if (message.data.route !== 'provider_offer' || typeof message.data.offerId !== 'string') return;
      setActiveTab('publish');
      const offer = await getSupplierOffer(message.data.offerId);
      const destination = providerOfferMessageDestination(offer.status);
      if (destination === 'revision') {
        setOfferWizard({ revisionOfferId: message.data.offerId });
        return;
      }
      if (destination === 'listing') {
        setListingOfferId(message.data.offerId);
        return;
      }
      setPublishOfferToReveal(message.data.offerId);
    } catch (reason) {
      Alert.alert('暂时无法打开', reason instanceof Error ? reason.message : '请稍后再试。');
      await refresh();
    }
  }, [markRead, refresh, snapshot.currentSubjectId]);

  useEffect(() => {
    const captureNotification = (response: Notifications.NotificationResponse | null) => {
      const notificationId = response?.notification.request.content.data?.notificationId;
      if (typeof notificationId !== 'string') return;
      setPendingNotificationId(notificationId);
      setActiveTab('messages');
    };
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      captureNotification(response);
      if (response) void Notifications.clearLastNotificationResponseAsync();
    });
    const subscription = Notifications.addNotificationResponseReceivedListener(captureNotification);
    return () => subscription.remove();
  }, []);

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
    switch (activeTab) {
      case 'market':
        return <MarketScreen snapshot={snapshot} refreshing={refreshing} onRefresh={refresh}
          onOpenPublish={() => setDemandComposerVisible(true)} onBuy={setSelectedListing}
          onOpenSparkDetail={openSparkDetail} onLogin={() => setAuthVisible(true)}
          onManageOwnListing={(listing) => {
            setPublishListingToManage(listing.id);
            setActiveTab('publish');
          }} />;
      case 'assets':
        return <UnifiedAssetsScreen snapshot={snapshot} refreshing={refreshing} onRefresh={refresh}
          onLogin={() => setAuthVisible(true)} onOpenCredits={() => navigate('credits')} onOpenOrder={(orderId) => void loadCloudPayOrder(orderId).then(setSelectedOrder).catch((reason) => Alert.alert('没能打开订单', reason instanceof Error ? reason.message : '请稍后重试。'))}
          onOpenDeviceOrder={(orderId) => void loadDeviceOrder(orderId).then(setSelectedDeviceOrder).catch((reason) => Alert.alert('没能打开订单', reason instanceof Error ? reason.message : '请稍后重试。'))}
          onOpenMarket={() => navigate('market')} onOpenProviderAssets={(resourceId) => { setResourceToOpenId(resourceId ?? null); navigate('resources'); }} onOpenPublish={() => navigate('publish')}
          onOpenPayout={() => setPayoutVisible(true)} />;
      case 'credits':
        return <CreditScreen snapshot={snapshot} refreshing={refreshing} onRefresh={refresh}
          onLogin={() => setAuthVisible(true)} onOpenWallet={() => setCreditWalletVisible(true)}
          onOpenPayout={() => setPayoutVisible(true)} />;
      case 'orders':
        return <OrdersScreen snapshot={snapshot} side={orderSide} refreshing={refreshing} onRefresh={refresh}
          onMarket={() => navigate(orderSide === 'provider' ? 'workspace' : 'market')} onLogin={() => setAuthVisible(true)} onOpenOrder={setSelectedOrder}
          onOpenReview={setSelectedReview} />;
      case 'workspace':
        return <ProviderWorkspaceScreen
          snapshot={snapshot}
          refreshing={refreshing}
          onRefresh={refresh}
          onNext={openProviderNextAction}
          onLogin={() => setAuthVisible(true)}
          onOpenOrder={setSelectedOrder}
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
        return <ProfileScreen snapshot={snapshot}
          onSelectSubject={(subjectId) => void chooseSubject(subjectId)} onSessionChanged={refresh} onLogin={() => setAuthVisible(true)}
          onOpenQualification={() => { setPublishIntentToOpen('supplier'); navigate('publish'); }} onOpenCredits={() => navigate('credits')}
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
      <View style={styles.page}>{page}</View>
      <BottomNav active={activeTab === 'orders' || activeTab === 'resources' || activeTab === 'credits' || activeTab === 'assets' || activeTab === 'creator' ? 'profile' : activeTab === 'workspace' ? 'publish' : activeTab} onChange={navigate} unread={snapshot.unreadCount} />
      <AuthSheet
        visible={authVisible}
        onClose={() => { setAuthVisible(false); setKaiAuthError(null); }}
        onSignedIn={refreshAfterAuthentication}
        kaiAuthBusy={kaiAuthBusy}
        kaiAuthError={kaiAuthError}
        onKaiAuthStart={async (documents) => {
          setKaiAuthError(null);
          try { await startKaiAuth({
            termsVersion: documents.terms.version,
            privacyVersion: documents.privacy.version,
          }); }
          catch (reason) {
            setKaiAuthError(reason instanceof Error ? reason.message : '无法打开统一身份登录。');
          }
        }}
      />
      <PublishFlowSheet
        mode={demandComposerVisible ? 'buy' : null}
        authenticated={snapshot.authenticated}
        onModeChange={() => undefined}
        onClose={() => setDemandComposerVisible(false)}
        onLogin={() => { setDemandComposerVisible(false); setAuthVisible(true); }}
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
          setSelectedOrder(order);
          void refresh().catch(() => undefined);
        }}
      />
      <CreditWalletSheet visible={creditWalletVisible} balance={snapshot.creditBalance}
        onClose={() => setCreditWalletVisible(false)} onChanged={refresh}
        onOpenSupport={() => { setCreditWalletVisible(false); navigate('messages'); }} />
      <OrderDetailSheet order={selectedOrder} onClose={() => setSelectedOrder(null)} onChanged={refresh} />
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
      <CloudPayApp />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.canvas },
  page: { flex: 1 },
});
