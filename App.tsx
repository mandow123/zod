import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics } from 'react-native-safe-area-context';
import { AuthSheet } from './src/AuthSheet';
import {
  loadCachedProviderState,
  loadCloudPaySnapshot,
  loadCloudPayOrder,
  markAllNotificationsRead,
  markNotificationRead,
  selectTradingSubject,
  type CloudPaySnapshot,
  type CloudPayNotification,
  type CloudPayOrder,
  type AftercareReview,
  type MarketCreditListing,
  type DeviceProduct,
} from './src/api';
import { AftercareReviewSheet } from './src/AftercareReviewSheet';
import { BottomNav, type TabKey, type WorkMode } from './src/components';
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
import { ProviderHomeScreen } from './src/screens/ProviderHomeScreen';
import { UnifiedAssetsScreen } from './src/screens/UnifiedAssetsScreen';
import { PublishScreen } from './src/screens/PublishScreen';
import { colors } from './src/theme';
import { loadWorkMode, saveWorkMode } from './src/work-mode';
import { getSupplierOffer } from './src/publishing';
import { distributionPolicy } from './src/distribution';
import { refreshAfterPendingAuthentication } from './src/auth-refresh';
import {
  providerNextNavigation, providerOfferMessageDestination, type ProviderPublishIntent,
} from './src/provider-next-navigation';
import { completeKaiAuth, isKaiAuthCallback, startKaiAuth } from './src/kai-auth';
import { SparkProductDetailSheet } from './src/SparkProductDetailSheet';
import { DeviceOrderSheet } from './src/DeviceOrderSheet';
import { CreditPayoutSheet } from './src/CreditPayoutSheet';

const FRONTEND_IDENTITY = 'KAI_CLOUD_UNIFIED_ASSETS_V2';
const initialSnapshot: CloudPaySnapshot = {
  online: false,
  loading: true,
  updatedAt: null,
  resources: [],
  listings: [],
  listingCatalogOnline: false,
  priceNotice: '正在读取 CloudPay 市场口径…',
  authenticated: false,
  user: null,
  sessionState: 'anonymous',
  notifications: [],
  unreadCount: 0,
  alipayReady: false,
  wechatReady: false,
  smsReady: false,
  pushReady: false,
  releaseReady: false,
  releaseBlockers: [],
  subjects: [],
  currentSubjectId: null,
  creditBalance: null,
  deviceProducts: [],
  deviceOrders: [],
  deviceAssets: [],
  payoutProfile: null,
  payouts: [],
  commerceError: null,
  providerWorkspace: null,
  providerWorkspaceError: null,
  providerWorkspaceCachedAt: null,
  orders: [],
  orderCursors: { buyer: null, provider: null },
  orderErrors: { buyer: null, provider: null },
  aftercareReviews: [],
  error: null,
};

function CloudPayApp() {
  const [activeTab, setActiveTab] = useState<TabKey>('home');
  const [workMode, setWorkMode] = useState<WorkMode>('consumer');
  const [workModeReady, setWorkModeReady] = useState(false);
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
  const [payoutVisible, setPayoutVisible] = useState(false);
  const [selectedReview, setSelectedReview] = useState<AftercareReview | null>(null);
  const [creditWalletVisible, setCreditWalletVisible] = useState(false);
  const [pendingNotificationId, setPendingNotificationId] = useState<string | null>(null);
  const refreshInFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const operation = (async () => {
      setRefreshing(true);
      try {
        const next = await loadCloudPaySnapshot();
        setSnapshot((current) => preserveLastKnownProviderState(current, next));
        setSelectedOrder((current) => current ? next.orders.find((item) => item.id === current.id) ?? current : null);
        setSelectedReview((current) => current ? next.aftercareReviews.find((item) => item.refundId === current.refundId) ?? current : null);
      } finally { setRefreshing(false); }
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
      if (!url || !isKaiAuthCallback(url) || handled.has(url)) return;
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
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  useEffect(() => {
    if (!workModeReady || workMode !== 'provider' || activeTab !== 'home') return;
    void refresh();
  }, [activeTab, refresh, workMode, workModeReady]);

  useEffect(() => {
    if (activeTab !== 'messages' || !snapshot.authenticated) return;
    void refresh();
  }, [activeTab, refresh, snapshot.authenticated]);

  useEffect(() => {
    if (snapshot.authenticated && snapshot.providerWorkspace?.canManage === true) return;
    setOfferWizard(null);
    setListingOfferId(null);
  }, [snapshot.authenticated, snapshot.currentSubjectId, snapshot.providerWorkspace?.canManage]);

  useEffect(() => {
    if (workMode !== 'provider' || activeTab !== 'home'
      || !snapshot.authenticated || (snapshot.providerWorkspace?.offers.underReview ?? 0) === 0) return;
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => clearInterval(timer);
  }, [activeTab, refresh, snapshot.authenticated, snapshot.providerWorkspace?.offers.underReview, workMode]);

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

  useEffect(() => {
    void loadWorkMode().then((mode) => {
      setWorkMode(mode);
      setActiveTab('home');
    }).finally(() => setWorkModeReady(true));
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

  const changeWorkMode = useCallback((mode: WorkMode) => {
    setWorkMode(mode);
    setActiveTab('profile');
    void saveWorkMode(mode);
  }, []);

  const chooseSubject = useCallback(async (subjectId: string) => {
    try {
      const selected = await selectTradingSubject(subjectId);
      setSnapshot((current) => ({
        ...current,
        currentSubjectId: selected.id,
        subjects: current.subjects.map((subject) => ({ ...subject, selected: subject.id === selected.id })),
        providerWorkspace: current.providerWorkspace?.subject.id === selected.id ? current.providerWorkspace : null,
        providerWorkspaceError: null,
        providerWorkspaceCachedAt: current.providerWorkspace?.subject.id === selected.id
          ? current.providerWorkspaceCachedAt : null,
        orders: [],
        orderCursors: { buyer: null, provider: null },
        orderErrors: { buyer: null, provider: null },
      }));
    } finally {
      await refresh();
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
        setWorkMode('provider');
        void saveWorkMode('provider');
        setActiveTab('messages');
        setSelectedOrder(await loadCloudPayOrder(message.data.orderId));
        return;
      }
      if (message.data.route === 'buyer_order' && typeof message.data.orderId === 'string') {
        setWorkMode('consumer');
        void saveWorkMode('consumer');
        setActiveTab('orders');
        setSelectedOrder(await loadCloudPayOrder(message.data.orderId));
        return;
      }
      if (message.data.route === 'provider_resource' && typeof message.data.resourceId === 'string') {
        setWorkMode('provider');
        void saveWorkMode('provider');
        setResourceToOpenId(message.data.resourceId);
        setActiveTab('resources');
        return;
      }
      if (message.data.route !== 'provider_offer' || typeof message.data.offerId !== 'string') return;
      setWorkMode('provider');
      void saveWorkMode('provider');
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
          onOpenSparkDetail={openSparkDetail}
          onManageOwnListing={(listing) => {
            setWorkMode('provider');
            void saveWorkMode('provider');
            setPublishListingToManage(listing.id);
            setActiveTab('publish');
          }} />;
      case 'assets':
        return <UnifiedAssetsScreen snapshot={snapshot} mode={workMode} refreshing={refreshing} onRefresh={refresh}
          onLogin={() => setAuthVisible(true)} onOpenCredits={() => setCreditWalletVisible(true)} onOpenOrder={setSelectedOrder}
          onOpenMarket={() => navigate('market')} onOpenProviderAssets={() => navigate('resources')} onOpenPublish={() => navigate('publish')}
          onOpenPayout={() => setPayoutVisible(true)} />;
      case 'orders':
        return <OrdersScreen snapshot={snapshot} side={workMode === 'provider' ? 'provider' : 'buyer'} refreshing={refreshing} onRefresh={refresh}
          onMarket={() => navigate(workMode === 'provider' ? 'workspace' : 'market')} onLogin={() => setAuthVisible(true)} onOpenOrder={setSelectedOrder}
          onOpenReview={setSelectedReview} />;
      case 'workspace':
        return <ProviderWorkspaceScreen
          snapshot={snapshot}
          refreshing={refreshing}
          onRefresh={refresh}
          onNext={openProviderNextAction}
          onLogin={() => setAuthVisible(true)}
          onOpenOrder={setSelectedOrder}
          onAllOrders={() => navigate('orders')}
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
      case 'profile':
        return <ProfileScreen snapshot={snapshot} mode={workMode} onModeChange={changeWorkMode}
          onSelectSubject={(subjectId) => void chooseSubject(subjectId)} onSessionChanged={refresh} onLogin={() => setAuthVisible(true)}
          onOpenPublish={() => navigate('publish')} onOpenCredits={() => setCreditWalletVisible(true)}
          onOpenOrders={() => navigate('orders')} onOpenAssets={() => navigate('assets')} onOpenMessages={() => navigate('messages')} />;
      case 'home':
      default:
        return workMode === 'provider' ? <ProviderHomeScreen snapshot={snapshot} refreshing={refreshing} onRefresh={refresh}
          onLogin={() => setAuthVisible(true)} onNext={openProviderNextAction} onOpenPublish={() => navigate('publish')}
          onOpenAssets={() => navigate('assets')} />
          : <HomeScreen snapshot={snapshot} refreshing={refreshing} onRefresh={refresh} onNavigate={navigate}
            onOpenDemand={() => setDemandComposerVisible(true)} onOpenSparkDetail={openSparkDetail}
            onOpenCredits={() => snapshot.authenticated ? setCreditWalletVisible(true) : setAuthVisible(true)} />;
    }
  })();

  if (!workModeReady) return (
    <View style={styles.launch}>
      <View style={styles.launchMark}><Text style={styles.launchMarkText}>K</Text></View>
      <Text style={styles.launchTitle}>KAI Cloud</Text>
      <ActivityIndicator color={colors.green} style={styles.launchSpinner} />
    </View>
  );

  return (
    <SafeAreaView nativeID={FRONTEND_IDENTITY} style={styles.safeArea} edges={['top', 'left', 'right']}>
      <StatusBar style="dark" />
      <View style={styles.page}>{page}</View>
      <BottomNav active={activeTab === 'orders' || activeTab === 'resources' ? 'assets' : activeTab === 'workspace' || activeTab === 'publish' ? 'home' : activeTab} mode={workMode} onChange={navigate} unread={snapshot.unreadCount} />
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
        alipayReady={snapshot.alipayReady} wechatReady={snapshot.wechatReady}
        onClose={() => setCreditWalletVisible(false)} onChanged={refresh} />
      <OrderDetailSheet order={selectedOrder} onClose={() => setSelectedOrder(null)} onChanged={refresh} />
      <AftercareReviewSheet review={selectedReview} onClose={() => setSelectedReview(null)} onChanged={refresh} />
      <SparkProductDetailSheet product={selectedSparkProduct} visible={selectedSparkProduct !== null}
        onClose={() => setSelectedSparkProduct(null)} onBuy={(product) => { setSelectedSparkProduct(null); if (snapshot.authenticated) setSelectedDeviceProduct(product); else setAuthVisible(true); }} />
      <DeviceOrderSheet product={selectedDeviceProduct} balance={snapshot.creditBalance} authenticated={snapshot.authenticated}
        onClose={() => setSelectedDeviceProduct(null)} onLogin={() => { setSelectedDeviceProduct(null); setAuthVisible(true); }}
        onNeedCredits={() => { setSelectedDeviceProduct(null); setCreditWalletVisible(true); }}
        onCreated={() => refresh()} />
      <CreditPayoutSheet visible={payoutVisible} balance={snapshot.creditBalance} profile={snapshot.payoutProfile}
        onClose={() => setPayoutVisible(false)} onCreated={() => refresh()} />
    </SafeAreaView>
  );
}

function preserveLastKnownProviderState(current: CloudPaySnapshot, next: CloudPaySnapshot): CloudPaySnapshot {
  const sameAccount = Boolean(current.user && next.user && current.user.id === next.user.id);
  if (!sameAccount || !next.authenticated) return next;
  const sameSubject = !next.currentSubjectId || next.currentSubjectId === current.currentSubjectId;
  const workspaceMatchesSubject = !next.currentSubjectId
    || current.providerWorkspace?.subject.id === next.currentSubjectId;
  const currentBuyerOrders = current.orders.filter((order) => order.side === 'buyer');
  const currentProviderOrders = current.orders.filter((order) => order.side === 'provider');
  const nextBuyerOrders = next.orders.filter((order) => order.side === 'buyer');
  const nextProviderOrders = next.orders.filter((order) => order.side === 'provider');
  return {
    ...next,
    deviceProducts: next.commerceError && sameSubject ? current.deviceProducts : next.deviceProducts,
    deviceOrders: next.commerceError && sameSubject ? current.deviceOrders : next.deviceOrders,
    deviceAssets: next.commerceError && sameSubject ? current.deviceAssets : next.deviceAssets,
    payoutProfile: next.commerceError && sameSubject ? current.payoutProfile : next.payoutProfile,
    payouts: next.commerceError && sameSubject ? current.payouts : next.payouts,
    providerWorkspace: next.providerWorkspace
      ?? (next.providerWorkspaceError && workspaceMatchesSubject ? current.providerWorkspace : null),
    providerWorkspaceCachedAt: next.providerWorkspace
      ? next.providerWorkspaceCachedAt
      : next.providerWorkspaceError && workspaceMatchesSubject && current.providerWorkspace
        ? current.providerWorkspaceCachedAt ?? current.updatedAt?.toISOString() ?? null
        : null,
    orders: [
      ...(next.orderErrors.buyer && sameSubject ? currentBuyerOrders : nextBuyerOrders),
      ...(next.orderErrors.provider && sameSubject ? currentProviderOrders : nextProviderOrders),
    ],
    orderCursors: {
      buyer: next.orderErrors.buyer && sameSubject ? current.orderCursors.buyer : next.orderCursors.buyer,
      provider: next.orderErrors.provider && sameSubject ? current.orderCursors.provider : next.orderCursors.provider,
    },
  };
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
  launch: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas },
  launchMark: { width: 72, height: 72, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.green },
  launchMarkText: { color: colors.surface, fontSize: 34, fontWeight: '900' },
  launchTitle: { color: colors.ink, fontSize: 23, fontWeight: '900', marginTop: 16 },
  launchSpinner: { marginTop: 18 },
});
