import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { CloudPaySnapshot, DeviceProduct, MarketCreditListing } from '../api';
import { creditAmount } from '../format';
import { deviceProductRegion, isSparkCampaignListing, isSparkCampaignProduct } from '../campaign';
import { colors } from '../theme';
import { isDedicatedGpuHour } from '../compute-product';
import { distributionPolicy } from '../distribution';
import { deviceMarketAvailability, deviceProductAvailability, listingAvailability, marketAvailability } from '../market-availability';
import { CloudPayKlinePanel } from '../CloudPayKlinePanel';
import {
  loadInquiryCatalog, type InquiryCatalogCandidate, type InquiryModel,
} from '../resource-inquiries';
import { inquiryCardTypeLabel } from '../inquiry-form';
import { useMarketCommerceSource, type MarketCommerceItem, type MarketCommerceOrder } from '../MarketCommerceSource';
import { stagingPurchaseGate, type StagingPurchaseGate } from '../staging-presentation';
import {
  loadSupplierInquiryCatalog, supplierCatalogCardCount, supplierCatalogInquiryCandidate,
  supplierCatalogReferenceCredit, supplierInquiryCatalogCounts, type SupplierCatalogKind,
  type SupplierInquiryCatalogItem,
} from '../honghuan-inquiry-catalog';
import { FORMAL_MARKET_FRESH_SECTION } from '../market-entry';
import {
  loadSupplierQuoteDirectory, supplierQuoteForBilling, supplierQuoteReference, type SupplierQuoteBillingMode,
  type SupplierQuoteDirectory, type SupplierQuoteDirectoryItem,
} from '../supplier-quote-directory';
import { supplierLogoAssets } from '../supplier-logo-assets';

type Props = Readonly<{
  snapshot: CloudPaySnapshot;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenPublish: () => void;
  onBuy: (listing: MarketCreditListing) => void;
  onManageOwnListing: (listing: MarketCreditListing) => void;
  onOpenSparkDetail: (product: DeviceProduct) => void;
  onOpenInquiry: (candidate: InquiryCatalogCandidate) => void;
  onOpenMyInquiries: () => void;
  onLogin: () => void;
}>;

type MarketSection = '算力租用' | '设备采购' | '预约算力';
type ComputeSource = '供应商询价' | '平台保障' | 'CloudPay K线';
const sections: MarketSection[] = ['算力租用', '预约算力', '设备采购'];
const computeSources: ComputeSource[] = ['供应商询价', '平台保障', 'CloudPay K线'];
const inquiryModels: Array<InquiryModel | null> = [null, 'A100', 'H100', 'H200', 'B200', 'B300'];
const LISTING_PAGE_SIZE = 20;
const supplierCatalogKinds: Array<Readonly<{ key: SupplierCatalogKind; label: string }>> = [
  { key: 'hourly_gpu', label: '按时算力' }, { key: 'contract_monthly', label: '整机长期租赁' },
];
const honghuanLogo = require('../../assets/suppliers/shanghai-honghuan.jpg');

export function MarketScreen({ snapshot, refreshing, onRefresh, onOpenPublish, onBuy, onManageOwnListing, onOpenSparkDetail, onOpenInquiry, onOpenMyInquiries, onLogin }: Props) {
  const [query, setQuery] = useState('');
  const [section, setSection] = useState<MarketSection>(FORMAL_MARKET_FRESH_SECTION);
  const [computeSource, setComputeSource] = useState<ComputeSource>('供应商询价');
  const [filterVisible, setFilterVisible] = useState(false);
  const [region, setRegion] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(LISTING_PAGE_SIZE);
  const [inquiryModel, setInquiryModel] = useState<InquiryModel | null>(null);
  const [inquiryCandidates, setInquiryCandidates] = useState<InquiryCatalogCandidate[]>([]);
  const [inquiryCursor, setInquiryCursor] = useState<string | null>(null);
  const [inquiryState, setInquiryState] = useState<'idle' | 'loading' | 'available' | 'error'>('idle');
  const [inquiryError, setInquiryError] = useState<string | null>(null);
  const [inquiryLoadingMore, setInquiryLoadingMore] = useState(false);
  const [inquiryReloadToken, setInquiryReloadToken] = useState(0);
  const [supplierCatalogKind, setSupplierCatalogKind] = useState<SupplierCatalogKind>('hourly_gpu');
  const [supplierCatalogItems, setSupplierCatalogItems] = useState<readonly SupplierInquiryCatalogItem[]>([]);
  const [supplierCatalogState, setSupplierCatalogState] = useState<'idle' | 'loading' | 'available' | 'error'>('idle');
  const [supplierCatalogError, setSupplierCatalogError] = useState<string | null>(null);
  const [supplierDirectoryItems, setSupplierDirectoryItems] = useState<readonly SupplierQuoteDirectoryItem[]>([]);
  const [supplierDirectoryState, setSupplierDirectoryState] = useState<'idle' | 'loading' | 'available' | 'error'>('idle');
  const [supplierDirectoryError, setSupplierDirectoryError] = useState<string | null>(null);
  const [supplierDirectorySource, setSupplierDirectorySource] = useState<SupplierQuoteDirectory['dataSource'] | null>(null);
  const commerce = useMarketCommerceSource();
  const [selectedCommerceItem, setSelectedCommerceItem] = useState<MarketCommerceItem | null>(null);
  const [commerceQuantity, setCommerceQuantity] = useState('1.00');
  const [commerceCreating, setCommerceCreating] = useState(false);
  const [commerceError, setCommerceError] = useState<string | null>(null);
  const [createdCommerceOrder, setCreatedCommerceOrder] = useState<MarketCommerceOrder | null>(null);
  const regions = useMemo(() => Array.from(new Set([
    ...snapshot.listings.map((item) => item.region),
    ...snapshot.deviceProducts.map(deviceProductRegion).filter((value): value is string => Boolean(value)),
    ...commerce.items.map((item) => item.region),
  ])).sort(), [commerce.items, snapshot.deviceProducts, snapshot.listings]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (section !== '算力租用' || computeSource !== '平台保障') return [];
    return snapshot.listings.filter((item) => item.productKind !== 'hardware_device' && !isSparkCampaignListing(item) && (!region || item.region === region)
      && (!needle || `${item.title} ${item.productCode} ${item.region}`.toLowerCase().includes(needle)))
      .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'));
  }, [computeSource, query, region, section, snapshot.listings]);
  const deviceProducts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (section !== '设备采购') return [];
    return snapshot.deviceProducts.filter((item) => isSparkCampaignProduct(item)
      && (!region || deviceProductRegion(item) === region)
      && (!needle || `${item.title} ${item.sku} ${item.supplier.displayName} 02672 spark dgx`.toLowerCase().includes(needle)));
  }, [query, region, section, snapshot.deviceProducts]);
  const commerceFiltered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (commerce.source !== 'staging' || section !== '算力租用' || computeSource !== '平台保障') return [];
    return commerce.items.filter((item) => (!region || item.region === region)
      && (!needle || `${item.title} ${item.productCode} ${item.region}`.toLowerCase().includes(needle)))
      .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'));
  }, [commerce.items, commerce.source, computeSource, query, region, section]);
  const supplierCatalogFiltered = useMemo(() => {
    if (section !== '预约算力') return [];
    const needle = query.trim().toLowerCase();
    return supplierCatalogItems.filter((item) => item.catalogKind === supplierCatalogKind
      && (!inquiryModel || item.specifications.gpu.model === inquiryModel)
      && (!needle || `${item.title} ${item.specifications.gpu.model} ${item.supplier.legalName}`.toLowerCase().includes(needle)));
  }, [computeSource, inquiryModel, query, section, supplierCatalogItems, supplierCatalogKind]);
  const supplierCatalogCounts = useMemo(
    () => supplierInquiryCatalogCounts(supplierCatalogItems), [supplierCatalogItems],
  );
  const supplierDirectoryFiltered = useMemo(() => {
    if (section !== '算力租用' || (computeSource !== '供应商询价'
      && !(computeSource === '平台保障' && !snapshot.listingCatalogOnline))) return [];
    const needle = query.trim().toLowerCase();
    return supplierDirectoryItems.filter((item) => (!inquiryModel || item.gpu.models.includes(inquiryModel as never))
      && (!needle || `${item.legalName} ${item.entityType ?? ''} ${item.locations.join(' ')} ${item.gpu.description}`.toLowerCase().includes(needle)));
  }, [computeSource, inquiryModel, query, section, snapshot.listingCatalogOnline, supplierDirectoryItems]);
  const supplierReservationFiltered = useMemo(() => {
    if (section !== '预约算力') return [];
    const billingMode: SupplierQuoteBillingMode = supplierCatalogKind === 'contract_monthly' ? 'monthly' : 'hourly';
    const needle = query.trim().toLowerCase();
    return supplierDirectoryItems.filter((item) => {
      const quote = supplierQuoteForBilling(item, billingMode);
      const amount = billingMode === 'monthly' ? quote?.referencePrice.monthlyAmount : quote?.referencePrice.hourlyAmount;
      return amount !== null && amount !== undefined
        && (!inquiryModel || item.gpu.models.includes(inquiryModel as never))
        && (!needle || `${item.legalName} ${item.entityType ?? ''} ${item.locations.join(' ')} ${item.gpu.description}`.toLowerCase().includes(needle));
    });
  }, [inquiryModel, query, section, supplierCatalogKind, supplierDirectoryItems]);
  useEffect(() => {
    if (section !== '预约算力') return;
    if (supplierCatalogKind === 'contract_monthly') {
      setInquiryCandidates([]); setInquiryCursor(null); setInquiryState('available'); setInquiryError(null);
      return;
    }
    let active = true;
    setInquiryCandidates([]); setInquiryCursor(null); setInquiryState('loading'); setInquiryError(null);
    const timer = setTimeout(() => {
      void loadInquiryCatalog({ model: inquiryModel, region, query, limit: LISTING_PAGE_SIZE }).then((result) => {
        if (!active) return;
        setInquiryCandidates(result.items); setInquiryCursor(result.nextCursor); setInquiryState('available');
      }).catch((reason) => {
        if (!active) return;
        setInquiryCandidates([]); setInquiryCursor(null); setInquiryState('error');
        setInquiryError(reason instanceof Error ? reason.message : '暂时无法读取预约目录。');
      });
    }, query.trim() ? 280 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [inquiryModel, inquiryReloadToken, query, refreshing, region, section, supplierCatalogKind]);
  useEffect(() => {
    if (section !== '预约算力') return;
    let active = true; setSupplierCatalogState('loading'); setSupplierCatalogError(null);
    void loadSupplierInquiryCatalog().then((result) => {
      if (!active) return;
      setSupplierCatalogItems(result.items); setSupplierCatalogState('available');
    }).catch((reason) => {
      if (!active) return;
      setSupplierCatalogItems([]); setSupplierCatalogState('error');
      setSupplierCatalogError('供应商目录暂时无法读取，请稍后重试。');
    });
    return () => { active = false; };
  }, [computeSource, inquiryReloadToken, refreshing, section]);
  useEffect(() => {
    if (!((section === '算力租用' && (computeSource === '供应商询价' || computeSource === '平台保障'))
      || section === '预约算力')) return;
    let active = true; setSupplierDirectoryState('loading'); setSupplierDirectoryError(null);
    void loadSupplierQuoteDirectory().then((result) => {
      if (!active) return;
      setSupplierDirectoryItems(result.items); setSupplierDirectorySource(result.dataSource); setSupplierDirectoryState('available');
    }).catch(() => {
      if (!active) return;
      setSupplierDirectoryItems([]); setSupplierDirectorySource(null); setSupplierDirectoryState('error');
      setSupplierDirectoryError('100 家供应商报价目录暂时无法读取。');
    });
    return () => { active = false; };
  }, [computeSource, inquiryReloadToken, refreshing, section]);
  useEffect(() => setVisibleCount(LISTING_PAGE_SIZE), [computeSource, inquiryModel, query, region, section, supplierCatalogKind]);
  const visibleListings = filtered.slice(0, visibleCount);
  const stagingPlatformMarket = commerce.source === 'staging' && section === '算力租用' && computeSource === '平台保障';
  const supplierRentalMarket = section === '算力租用' && computeSource === '供应商询价';
  const cloudPayKlineMarket = section === '算力租用' && computeSource === 'CloudPay K线';
  const platformDirectoryFallback = section === '算力租用' && computeSource === '平台保障'
    && !snapshot.listingCatalogOnline && supplierDirectoryState === 'available';
  const platformDemoOnly = section === '算力租用' && computeSource === '平台保障' && filtered.length > 0
    && filtered.every((item) => item.demo?.mode === 'local_e2e');
  const marketUnavailable = section === '预约算力'
    ? supplierDirectoryState === 'error' && supplierCatalogState === 'error'
      && (supplierCatalogKind === 'contract_monthly' || inquiryState === 'error')
    : (section === '设备采购' ? !snapshot.deviceCatalogOnline
    : supplierRentalMarket ? supplierDirectoryState === 'error'
    : cloudPayKlineMarket ? false
      : stagingPlatformMarket ? Boolean(commerce.error) && !platformDirectoryFallback
        : !snapshot.listingCatalogOnline && supplierDirectoryState !== 'available');
  const marketState = marketAvailability(snapshot, distributionPolicy.newOrders);
  const deviceMarketState = deviceMarketAvailability(snapshot, distributionPolicy.newOrders);

  return <View style={styles.root}>
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing || (stagingPlatformMarket && commerce.loading)} onRefresh={() => { onRefresh(); if (stagingPlatformMarket) void commerce.reload(); }} tintColor={colors.primary} />}>
      <View style={styles.heading}><View><Text style={styles.title}>资源市场</Text><Text style={styles.subtitle}>{marketUnavailable ? '目录正在同步' : section === '设备采购' ? '实物设备采购与履约' : section === '预约算力' ? '100 家供应商可预约，价格、库存与交付需询价确认' : cloudPayKlineMarket ? 'CloudPay 同源报价参考盘' : supplierRentalMarket ? '100 家供应商可申请，库存与交付需询价确认' : platformDirectoryFallback ? '平台保障目录审核中，先展示 100 家供应商候选' : platformDemoOnly ? '测试资源目录，当前仅支持查看' : '即时开通，按卡时结算'}</Text></View><Text style={styles.count}>{section === '预约算力' ? supplierDirectoryState === 'available' ? `${supplierCatalogKind === 'contract_monthly' ? '长租' : '按时'} ${supplierReservationFiltered.length} 家` : supplierCatalogState === 'available' ? `上海鸿欢 ${supplierCatalogCounts.total} 项` : '目录待确认' : cloudPayKlineMarket ? '实时行情' : supplierRentalMarket ? supplierDirectoryState === 'available' ? `${supplierDirectoryItems.length} 家` : '目录待确认' : platformDirectoryFallback ? `${supplierDirectoryItems.length} 候选` : `${(stagingPlatformMarket ? commerceFiltered.length : filtered.length) + deviceProducts.length} 项`}</Text></View>
      {!cloudPayKlineMarket ? <View style={styles.search}><Ionicons name="search-outline" size={20} color={colors.ink} /><TextInput value={query} onChangeText={setQuery} placeholder={section === '设备采购' ? '搜索 Spark、DGX、02672' : section === '预约算力' ? '搜索 GPU 型号、卡型或宽地区' : '搜索 GPU 型号、地区'} placeholderTextColor={colors.subtle} style={styles.searchInput} />{query ? <Pressable onPress={() => setQuery('')}><Ionicons name="close-circle" size={19} color={colors.subtle} /></Pressable> : null}{section !== '预约算力' && !supplierRentalMarket ? <Pressable onPress={() => setFilterVisible(true)} style={styles.filterButton}><Ionicons name="options-outline" size={18} color={colors.ink} />{region ? <View style={styles.filterDot} /> : null}</Pressable> : null}</View> : null}
      <View style={styles.sections}>{sections.map((item) => <Pressable key={item} onPress={() => { setSection(item); setRegion(null); }} style={[styles.section, section === item && styles.sectionActive]}><Text style={[styles.sectionText, section === item && styles.sectionTextActive]}>{item}</Text></Pressable>)}</View>
      {section === '算力租用' ? <><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categories}>{computeSources.map((item) => <Pressable key={item} onPress={() => setComputeSource(item)} style={[styles.category, computeSource === item && styles.categoryActive]}><Text style={[styles.categoryText, computeSource === item && styles.categoryTextActive]}>{item === '平台保障' && !snapshot.listingCatalogOnline ? '平台保障（审核中）' : item}</Text></Pressable>)}</ScrollView>{supplierRentalMarket || platformDirectoryFallback ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.modelCategories}>{[null, 'H100', 'H200', 'B300'].map((item) => <Pressable key={item ?? 'all'} onPress={() => setInquiryModel(item as InquiryModel | null)} style={[styles.modelCategory, inquiryModel === item && styles.modelCategoryActive]}><Text style={[styles.modelCategoryText, inquiryModel === item && styles.modelCategoryTextActive]}>{item ?? '全部型号'}</Text></Pressable>)}</ScrollView> : null}</> : section === '预约算力' ? <View><View style={styles.inquiryIntro}><View style={styles.inquiryIntroCopy}><Text style={styles.deviceIntroTitle}>预约算力</Text><Text style={styles.deviceIntroText}>参考卡时、库存与交付均需询价确认</Text></View><Pressable onPress={snapshot.authenticated ? onOpenMyInquiries : onLogin} style={styles.myInquiries}><Text style={styles.myInquiriesText}>我的询期</Text><Ionicons name="chevron-forward" size={14} color={colors.primary} /></Pressable></View><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categories}>{supplierCatalogKinds.map((item) => { const count = supplierDirectoryState === 'available' ? supplierDirectoryItems.length : item.key === 'hourly_gpu' ? supplierCatalogCounts.hourly : supplierCatalogCounts.monthly; return <Pressable key={item.key} onPress={() => setSupplierCatalogKind(item.key)} style={[styles.category, supplierCatalogKind === item.key && styles.categoryActive]}><Text style={[styles.categoryText, supplierCatalogKind === item.key && styles.categoryTextActive]}>{item.label}（{supplierDirectoryState === 'available' || supplierCatalogState === 'available' ? count : '待确认'}）</Text></Pressable>; })}</ScrollView><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.modelCategories}>{inquiryModels.map((item) => <Pressable key={item ?? 'all'} onPress={() => setInquiryModel(item)} style={[styles.modelCategory, inquiryModel === item && styles.modelCategoryActive]}><Text style={[styles.modelCategoryText, inquiryModel === item && styles.modelCategoryTextActive]}>{item ?? '全部型号'}</Text></Pressable>)}</ScrollView></View> : <View style={styles.deviceIntro}><Text style={styles.deviceIntroTitle}>设备采购</Text><Text style={styles.deviceIntroText}>库存、卡时价格和交付进度由平台订单统一管理</Text></View>}

      {marketUnavailable ? <View style={styles.outage}><Ionicons name="cloud-offline-outline" size={20} color={colors.amber} /><View style={styles.outageCopy}><Text style={styles.outageTitle}>{section === '预约算力' || supplierRentalMarket ? '供应商目录暂时无法读取' : '市场数据暂时无法确认'}</Text><Text style={styles.outageText}>{supplierRentalMarket ? supplierDirectoryError ?? '下拉刷新后重试。' : section === '预约算力' ? supplierCatalogError ?? inquiryError ?? '下拉刷新后重试。' : '不会把断网当成库存为零。下拉刷新后再查看价格和购买状态。'}</Text>{section === '预约算力' || supplierRentalMarket ? <Pressable onPress={() => setInquiryReloadToken((value) => value + 1)} style={styles.inlineRetry}><Text style={styles.inlineRetryText}>重新加载</Text></Pressable> : null}</View></View> : null}
      {section === '预约算力' && supplierCatalogState === 'loading' ? <View style={styles.partnerEmpty}><ActivityIndicator color={colors.primary} /><View style={styles.partnerCopy}><Text style={styles.partnerTitle}>正在读取上海鸿欢目录</Text><Text style={styles.partnerText}>仅渲染服务端返回的完整 11 项，不在本地补造资源。</Text></View></View> : null}
      {section === '预约算力' && supplierCatalogState === 'error' && supplierDirectoryState !== 'available' && inquiryState !== 'error' ? <View style={styles.pageError}><Text style={styles.pageErrorText}>{supplierCatalogError ?? '供应商目录暂时无法确认。'}</Text><Pressable onPress={() => setInquiryReloadToken((value) => value + 1)}><Text style={styles.inlineRetryText}>重新加载供应商目录</Text></Pressable></View> : null}
      {supplierRentalMarket && supplierDirectoryState === 'loading' ? <View style={styles.partnerEmpty}><ActivityIndicator color={colors.primary} /><View style={styles.partnerCopy}><Text style={styles.partnerTitle}>正在读取 100 家供应商目录</Text><Text style={styles.partnerText}>逐项校验名称、GPU 型号、参考卡时与询价状态。</Text></View></View> : null}
      {supplierRentalMarket && supplierDirectoryState === 'available' ? <View style={styles.directoryNotice}><Text style={styles.directoryNoticeTitle}>已收录 100 家 · 全部需询价确认</Text><Text style={styles.directoryNoticeText}>{supplierDirectorySource === 'live_api' ? '服务端实时目录' : '审核快照（联网后自动切回服务端）'} · 主体、库存、价格和 SLA 尚未独立验真</Text></View> : null}
      {platformDirectoryFallback ? <View style={styles.directoryNotice}><Text style={styles.directoryNoticeTitle}>平台保障候选 · 100 家待审核</Text><Text style={styles.directoryNoticeText}>以下资源尚未取得平台保障标识，不代表现货或已审核库存；完成主体、价格、交付与 SLA 审核后才会进入正式保障目录。</Text></View> : null}
      {section === '预约算力' && supplierDirectoryState === 'available' ? <View style={styles.directoryNotice}><Text style={styles.directoryNoticeTitle}>{supplierCatalogKind === 'contract_monthly' ? '整机长期租赁' : '按时算力'} · 已显示 {supplierReservationFiltered.length} 家</Text><Text style={styles.directoryNoticeText}>{supplierDirectorySource === 'live_api' ? '服务端实时目录' : '审核快照（联网后自动切回服务端）'} · 均可发布定向需求，库存与交付需供应商确认</Text></View> : null}
      {section === '预约算力' && supplierCatalogKind === 'hourly_gpu' && inquiryState === 'loading' ? <View style={styles.partnerEmpty}><ActivityIndicator color={colors.primary} /><View style={styles.partnerCopy}><Text style={styles.partnerTitle}>正在读取预约目录</Text><Text style={styles.partnerText}>每次只加载一页，不会一次渲染全部候选。</Text></View></View> : null}
      {stagingPlatformMarket && commerce.loading && !commerce.loaded ? <View style={styles.partnerEmpty}><ActivityIndicator color={colors.primary} /><View style={styles.partnerCopy}><Text style={styles.partnerTitle}>正在读取资源目录</Text><Text style={styles.partnerText}>容量、价格和卡时余额以服务端最新结果为准。</Text></View></View> : null}
      {stagingPlatformMarket && commerce.pendingConfirmation ? <View style={styles.pageError}><Text style={styles.pageErrorText}>{commerce.pendingMessage ?? '上一笔预留结果待确认，确认前不能新建。'}</Text><Pressable disabled={commerce.loading} onPress={() => void commerce.reload()}><Text style={styles.inlineRetryText}>重新确认</Text></Pressable></View> : null}
      {cloudPayKlineMarket ? <CloudPayKlinePanel refreshToken={inquiryReloadToken} /> : null}
      <View style={styles.list}>{section === '预约算力' ? <>{supplierCatalogFiltered.map((item) => <SupplierInquiryRow key={item.resourceId} item={item}
        onPress={() => onOpenInquiry(supplierCatalogInquiryCandidate(item))} />)}{supplierDirectoryState === 'available' ? supplierReservationFiltered.slice(0, visibleCount).map((item) => <SupplierDirectoryRow key={`${supplierCatalogKind}:${item.supplierId}`} item={item} billingMode={supplierCatalogKind === 'contract_monthly' ? 'monthly' : 'hourly'} onPress={onOpenPublish} />) : null}{supplierCatalogKind === 'hourly_gpu' ? inquiryCandidates.map((candidate) => <InquiryCandidateRow key={candidate.candidateId} candidate={candidate} onPress={() => onOpenInquiry(candidate)} />) : null}</> : null}{supplierRentalMarket ? supplierDirectoryFiltered.slice(0, visibleCount).map((item) => <SupplierDirectoryRow key={item.supplierId} item={item} onPress={onOpenPublish} />) : null}{deviceProducts.map((product) => <DeviceProductRow key={product.id} product={product}
        blockedReason={deviceProductAvailability(deviceMarketState, product).reason}
        onPress={() => onOpenSparkDetail(product)} />)}{platformDirectoryFallback ? supplierDirectoryFiltered.slice(0, visibleCount).map((item) => <SupplierDirectoryRow key={`platform:${item.supplierId}`} item={item} onPress={onOpenPublish} />) : null}{stagingPlatformMarket ? commerceFiltered.map((item) => <CommerceMarketRow key={item.id} item={item} availableBalance={commerce.availableBalance} mutationBlocked={commerce.pendingConfirmation ? commerce.pendingMessage ?? '预留结果待确认。' : null}
          onPress={() => { setSelectedCommerceItem(item); setCommerceQuantity('1.00'); setCommerceError(null); setCreatedCommerceOrder(null); }} />) : visibleListings.map((item) => item.demo?.mode === 'local_e2e' ? <LocalDemoMarketRow key={item.id} item={item} /> : <MarketRow key={item.id} item={item}
        blockedReason={item.ownedByCurrentSubject ? null : listingAvailability(marketState, item, isDedicatedGpuHour(item)).reason}
        onPress={item.ownedByCurrentSubject ? () => onManageOwnListing(item) : listingAvailability(marketState, item, isDedicatedGpuHour(item)).allowed ? () => onBuy(item) : undefined} />)}</View>
      {visibleCount < filtered.length ? <Pressable onPress={() => setVisibleCount((count) => count + LISTING_PAGE_SIZE)} style={styles.loadMore}><Text style={styles.loadMoreText}>继续显示</Text></Pressable> : null}
      {supplierRentalMarket && visibleCount < supplierDirectoryFiltered.length ? <Pressable onPress={() => setVisibleCount((count) => count + LISTING_PAGE_SIZE)} style={styles.loadMore}><Text style={styles.loadMoreText}>继续显示供应商（{Math.min(visibleCount, supplierDirectoryFiltered.length)} / {supplierDirectoryFiltered.length}）</Text></Pressable> : null}
      {platformDirectoryFallback && visibleCount < supplierDirectoryFiltered.length ? <Pressable onPress={() => setVisibleCount((count) => count + LISTING_PAGE_SIZE)} style={styles.loadMore}><Text style={styles.loadMoreText}>继续显示候选（{Math.min(visibleCount, supplierDirectoryFiltered.length)} / {supplierDirectoryFiltered.length}）</Text></Pressable> : null}
      {section === '预约算力' && visibleCount < supplierReservationFiltered.length ? <Pressable onPress={() => setVisibleCount((count) => count + LISTING_PAGE_SIZE)} style={styles.loadMore}><Text style={styles.loadMoreText}>继续显示资源（{Math.min(visibleCount, supplierReservationFiltered.length)} / {supplierReservationFiltered.length}）</Text></Pressable> : null}
      {section === '预约算力' && supplierCatalogKind === 'hourly_gpu' && inquiryCursor ? <Pressable disabled={inquiryLoadingMore} onPress={() => {
        if (inquiryLoadingMore) return;
        setInquiryLoadingMore(true); setInquiryError(null);
        void loadInquiryCatalog({ model: inquiryModel, region, query, cursor: inquiryCursor, limit: LISTING_PAGE_SIZE })
          .then((result) => { setInquiryCandidates((current) => [...current, ...result.items]); setInquiryCursor(result.nextCursor); })
          .catch((reason) => setInquiryError(reason instanceof Error ? reason.message : '下一页暂时无法读取。'))
          .finally(() => setInquiryLoadingMore(false));
      }} style={styles.loadMore}>{inquiryLoadingMore ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.loadMoreText}>继续加载候选</Text>}</Pressable> : null}
      {section === '预约算力' && inquiryState === 'available' && inquiryError ? <View style={styles.pageError}><Text style={styles.pageErrorText}>{inquiryError}</Text><Pressable onPress={() => setInquiryReloadToken((value) => value + 1)}><Text style={styles.inlineRetryText}>重新加载目录</Text></Pressable></View> : null}
      {section === '预约算力' && inquiryState === 'available' && supplierCatalogState === 'available'
        && (supplierCatalogKind === 'contract_monthly' || !inquiryCandidates.length) && !supplierCatalogFiltered.length && !supplierReservationFiltered.length ? <View style={styles.empty}><Ionicons name="calendar-outline" size={28} color={colors.muted} /><Text style={styles.emptyTitle}>没有匹配的预约候选</Text><Text style={styles.emptyText}>换个型号或关键词再试，公开目录不会补造候选。</Text></View> : null}
      {supplierRentalMarket && supplierDirectoryState === 'available' && !supplierDirectoryFiltered.length ? <View style={styles.empty}><Ionicons name="calendar-outline" size={28} color={colors.muted} /><Text style={styles.emptyTitle}>没有匹配的供应商资源</Text><Text style={styles.emptyText}>换个 GPU 型号或公司名称再试。</Text></View> : null}
      {section !== '预约算力' && !supplierRentalMarket && !cloudPayKlineMarket && !platformDirectoryFallback && !marketUnavailable && !(stagingPlatformMarket ? commerceFiltered.length : filtered.length) && !deviceProducts.length && !(stagingPlatformMarket && commerce.loading) ? <View style={styles.empty}><Ionicons name="search-outline" size={28} color={colors.muted} /><Text style={styles.emptyTitle}>没找到匹配资源</Text><Text style={styles.emptyText}>换个型号或地区，也可以提交定向需求。</Text><Pressable onPress={onOpenPublish} style={styles.primary}><Text style={styles.primaryText}>发布算力需求</Text></Pressable></View> : null}
    </ScrollView>
    <Modal visible={filterVisible} transparent animationType="slide" onRequestClose={() => setFilterVisible(false)}><Pressable onPress={() => setFilterVisible(false)} style={styles.backdrop}><Pressable onPress={() => undefined} style={styles.sheet}><View style={styles.handle} /><View style={styles.sheetHeading}><Text style={styles.sheetTitle}>筛选地区</Text><Pressable onPress={() => { setRegion(null); setFilterVisible(false); }}><Text style={styles.reset}>重置</Text></Pressable></View><View style={styles.regionGrid}><FilterChip label="全部地区" selected={!region} onPress={() => setRegion(null)} />{regions.map((item) => <FilterChip key={item} label={item} selected={region === item} onPress={() => setRegion(item)} />)}</View><Pressable onPress={() => setFilterVisible(false)} style={styles.primary}><Text style={styles.primaryText}>查看结果</Text></Pressable></Pressable></Pressable></Modal>
    <CommercePurchaseModal item={selectedCommerceItem} availableBalance={commerce.availableBalance} quantity={commerceQuantity}
      mutationBlocked={commerce.pendingConfirmation ? commerce.pendingMessage ?? '预留结果待确认。' : null}
      creating={commerceCreating} error={commerceError} createdOrder={createdCommerceOrder}
      onQuantityChange={(value) => { setCommerceQuantity(value); setCommerceError(null); }}
      onClose={() => { if (!commerceCreating) setSelectedCommerceItem(null); }}
      onConfirm={(gate) => {
        if (!selectedCommerceItem || !gate.quantity || gate.reason || commerceCreating) return;
        setCommerceCreating(true); setCommerceError(null);
        void commerce.createOrder(selectedCommerceItem.id, gate.quantity)
          .then(setCreatedCommerceOrder)
          .catch((reason) => setCommerceError(reason instanceof Error ? reason.message : '服务端暂时无法确认预留。'))
          .finally(() => setCommerceCreating(false));
      }} />
  </View>;
}

function SupplierInquiryRow({ item, onPress }: Readonly<{ item: SupplierInquiryCatalogItem; onPress: () => void }>) {
  const [logoFailed, setLogoFailed] = useState(false);
  const contract = item.catalogKind === 'contract_monthly';
  return <View style={styles.supplierCard}>
    <View style={styles.cardTop}>{logoFailed ? <View style={styles.supplierLogoFallback}><Text style={styles.supplierLogoFallbackText}>鸿</Text></View>
      : <Image accessibilityLabel="上海鸿欢 Logo" source={honghuanLogo} onError={() => setLogoFailed(true)} style={styles.supplierLogo} />}
      <View style={styles.cardCopy}><View style={styles.typeRow}><Text style={styles.inquiryTag}>{contract ? '整机长期租赁' : '按时算力'}</Text>{contract ? <Text style={styles.contractTag}>合同条款待确认</Text> : null}</View>
        <Text numberOfLines={1} style={styles.cardTitle}>{item.specifications.gpu.model} · {supplierCatalogCardCount(item)}</Text>
        <Text numberOfLines={1} style={styles.meta}>{item.supplier.legalName}</Text></View>
    </View>
    <Text style={styles.unverifiedDisclosure}>报价资料导入 · 未经 KAI 验真</Text>
    <View style={styles.supplierFacts}><View><Text style={styles.factLabel}>参考卡时</Text><Text style={styles.supplierPrice}>{supplierCatalogReferenceCredit(item)}</Text><Text style={styles.supplierPriceUnit}>{contract ? '/ 台月' : '/ GPU 小时'}</Text></View>
      <View style={styles.factRight}><Text style={styles.factLabel}>库存</Text><Text style={styles.factValue}>询价确认</Text><Text style={styles.factLabelSpaced}>交付</Text><Text style={styles.factValue}>询价确认</Text></View></View>
    <View style={styles.inquiryBottom}><Text style={styles.supplierNote}>{item.specifications.gpu.formFactor ?? '卡型待确认'} · 全国可申请，实际地域待确认</Text><Pressable onPress={onPress} style={styles.inquiryAction}><Text style={styles.inquiryActionText}>{contract ? '提交租赁意向' : '提交询期'}</Text><Ionicons name="arrow-forward" size={14} color={colors.surface} /></Pressable></View>
  </View>;
}

function SupplierDirectoryRow({ item, billingMode = 'hourly', onPress }: Readonly<{
  item: SupplierQuoteDirectoryItem; billingMode?: SupplierQuoteBillingMode; onPress: () => void;
}>) {
  const [logoFailed, setLogoFailed] = useState(false);
  const bundledLogo = supplierLogoAssets[item.supplierId];
  const initials = item.displayName.replace(/[（(].*$/u, '').replace(/有限公司|股份|科技|云计算|信息技术/gu, '').slice(0, 2) || '算力';
  const quote = supplierQuoteForBilling(item, billingMode);
  const longTerm = billingMode === 'monthly';
  const modelLabel = item.gpu.models.join(' / ');
  const locationLabel = item.locations.length ? item.locations.slice(0, 3).join(' · ') : '地域待确认';
  return <View style={styles.supplierCard}>
    <View style={styles.cardTop}>{bundledLogo && !logoFailed
      ? <Image accessibilityLabel={`${item.displayName} 官网核验图标`} source={bundledLogo} onError={() => setLogoFailed(true)} style={styles.supplierLogo} />
      : <View style={styles.supplierLogoFallback}><Text numberOfLines={1} style={styles.supplierDirectoryInitials}>{initials}</Text></View>}
      <View style={styles.cardCopy}><View style={styles.typeRow}><Text style={styles.inquiryTag}>{longTerm ? '整机长期租赁' : '按时算力'}</Text><Text style={styles.inquiryStatus}>未独立验真</Text></View>
        <Text numberOfLines={1} style={styles.cardTitle}>{item.displayName}</Text>
        <Text numberOfLines={1} style={styles.meta}>{modelLabel} · {locationLabel}</Text></View>
    </View>
    <Text style={styles.unverifiedDisclosure}>第 {item.sourceRow} 项 · 报价、主体、库存与 SLA 均需询价核验</Text>
    <View style={styles.supplierFacts}><View style={styles.supplierPriceColumn}><Text style={styles.factLabel}>{quote?.model ?? 'GPU'} 参考卡时</Text><Text numberOfLines={1} style={styles.supplierDirectoryPrice}>{supplierQuoteReference(item, billingMode)}</Text><Text style={styles.supplierPriceUnit}>{longTerm ? '/ 月 · 需询价确认' : '/ GPU 小时 · 需询价确认'}</Text></View>
      <View style={styles.factRight}><Text style={styles.factLabel}>库存</Text><Text style={styles.factValue}>询价确认</Text><Text style={styles.factLabelSpaced}>来源称</Text><Text numberOfLines={1} style={styles.factValue}>{item.sourceClaims.availability ?? '未说明'}</Text></View></View>
    <View style={styles.inquiryBottom}><Text numberOfLines={2} style={styles.supplierNote}>{item.entityType ?? '供应商类型待核验'} · {item.contractTerms ?? '合同条款待确认'}</Text><Pressable onPress={onPress} style={styles.inquiryAction}><Text style={styles.inquiryActionText}>{longTerm ? '发布租赁需求' : '发布定向需求'}</Text><Ionicons name="arrow-forward" size={14} color={colors.surface} /></Pressable></View>
  </View>;
}

function DeviceProductRow({ product, blockedReason, onPress }: Readonly<{ product: DeviceProduct; blockedReason: string | null; onPress: () => void }>) {
  return <View style={styles.card}>
    <View style={styles.cardTop}><View style={styles.icon}><Ionicons name="cube-outline" size={20} color={colors.ink} /></View><View style={styles.cardCopy}><View style={styles.typeRow}><Text style={styles.type}>设备采购</Text><Text style={styles.supplier}>{product.supplier.displayName}特供</Text><Text style={styles.discount}>{product.pricing.discountPercent === 20 ? '8 折' : `优惠 ${product.pricing.discountPercent}%`}</Text></View><Text style={styles.cardTitle}>{product.title}</Text><Text style={styles.meta}>{product.sku} · {product.expectedDelivery.label}</Text></View></View>
    <Text style={styles.audit}>设备商品与价格以平台商品目录为准</Text>
    <View style={styles.cardBottom}><View><Text style={styles.price}>{creditAmount(product.pricing.unitCredit)}</Text><Text style={styles.unit}>KAI 卡时 / 台</Text></View><View style={styles.stock}><Text style={styles.stockLabel}>{product.purchasable ? '实时可售' : '活动总量'}</Text><Text style={styles.stockValue}>{product.purchasable ? product.inventory.available : product.inventory.total} 台</Text></View><Pressable onPress={onPress} style={styles.rowAction}><Text style={styles.rowActionText}>查看商品</Text><Ionicons name="arrow-forward" size={14} color={colors.surface} /></Pressable></View>
    {blockedReason ? <Text style={styles.pending}>{blockedReason}</Text> : null}
  </View>;
}

function InquiryCandidateRow({ candidate, onPress }: Readonly<{ candidate: InquiryCatalogCandidate; onPress: () => void }>) {
  const mode = candidate.modes.map((item) => item === 'hourly' ? '按小时询期' : '包月询期').join(' / ');
  const observed = new Date(candidate.sourceObservedAt);
  const observedLabel = Number.isNaN(observed.getTime()) ? candidate.sourceObservedAt
    : `${observed.getFullYear()}-${String(observed.getMonth() + 1).padStart(2, '0')}-${String(observed.getDate()).padStart(2, '0')}`;
  return <View style={styles.inquiryCard}>
    <View style={styles.cardTop}><View style={styles.inquiryIcon}><Ionicons name="calendar-outline" size={20} color={colors.primary} /></View><View style={styles.cardCopy}><View style={styles.typeRow}><Text style={styles.inquiryTag}>预约候选</Text><Text style={styles.inquiryStatus}>需询期</Text></View><Text style={styles.cardTitle}>{candidate.model} · {inquiryCardTypeLabel(candidate.cardType)}</Text><Text style={styles.meta}>{candidate.region} · 待认领供应方</Text></View></View>
    <View style={styles.inquiryFacts}><View><Text style={styles.factLabel}>询期方式</Text><Text style={styles.factValue}>{mode}</Text></View><View style={styles.factRight}>{candidate.lastVerifiedAt ? <><Text style={styles.factLabel}>供应方确认日期</Text><Text style={styles.factValue}>{candidate.lastVerifiedAt.slice(0, 10)}</Text></> : <><Text style={styles.factLabel}>资料日期 {observedLabel}</Text><Text style={styles.factValue}>{candidate.verification.message || '资料待供应方确认'}</Text></>}</View></View>
    <View style={styles.inquiryBottom}><View><Text style={styles.inquiryPrice}>询期后以卡时报价</Text><Text style={styles.audit}>提交询期不生成订单，不冻结卡时</Text></View><Pressable onPress={onPress} style={styles.inquiryAction}><Text style={styles.inquiryActionText}>查看并询期</Text><Ionicons name="arrow-forward" size={14} color={colors.surface} /></Pressable></View>
  </View>;
}

function purchaseGateCopy(reason: StagingPurchaseGate['reason']) {
  if (reason === 'invalid_quantity') return '请输入大于 0 且最多两位小数的 GPU 时。';
  if (reason === 'invalid_total_precision') return '当前数量无法形成有效的卡时金额。';
  if (reason === 'capacity_exceeded') return '购买数量超过服务端当前可用容量。';
  if (reason === 'balance_unavailable') return '服务端暂时无法确认可用卡时。';
  if (reason === 'insufficient_balance') return '可用卡时不足，请先充值。';
  return null;
}

function commerceGate(item: MarketCommerceItem, availableBalance: string | null, quantityInput: string) {
  if (!item.purchasable) return {
    gate: stagingPurchaseGate({ quantityInput, unitPriceCredits: item.unitPriceCredits,
      capacityAvailable: item.capacityAvailable, availableBalance }),
    blocked: '服务端当前未开放购买。',
  };
  const gate = stagingPurchaseGate({ quantityInput, unitPriceCredits: item.unitPriceCredits,
    capacityAvailable: item.capacityAvailable, availableBalance });
  return { gate, blocked: purchaseGateCopy(gate.reason) };
}

function CommerceMarketRow({ item, availableBalance, mutationBlocked, onPress }: Readonly<{
  item: MarketCommerceItem;
  availableBalance: string | null;
  mutationBlocked: string | null;
  onPress: () => void;
}>) {
  const { blocked: gateBlocked } = commerceGate(item, availableBalance, '1.00');
  const blocked = mutationBlocked ?? gateBlocked;
  return <View style={styles.card}>
    <View style={styles.cardTop}><View style={styles.icon}><Ionicons name="hardware-chip-outline" size={20} color={colors.ink} /></View><View style={styles.cardCopy}><View style={styles.typeRow}><Text style={styles.type}>即时算力</Text></View><Text numberOfLines={1} style={styles.cardTitle}>{item.title}</Text><Text style={styles.meta}>{item.productCode} · {item.region}</Text></View></View>
    <Text style={styles.audit}>{item.auditLabel}</Text>
    <View style={styles.cardBottom}><View><Text style={styles.price}>{creditAmount(item.unitPriceCredits)}</Text><Text style={styles.unit}>KAI 卡时 / {item.capacityUnit}</Text></View><View style={styles.stock}><Text style={styles.stockLabel}>{item.inventoryLabel}</Text><Text style={styles.stockValue}>{item.capacityAvailable.replace(/\.0+$/u, '')} {item.capacityUnit}</Text></View>{blocked ? <Text style={styles.unavailable}>暂未开放</Text> : <Pressable onPress={onPress} style={styles.rowAction}><Text style={styles.rowActionText}>购买</Text><Ionicons name="arrow-forward" size={14} color={colors.surface} /></Pressable>}</View>
    {blocked ? <Text style={styles.pending}>{blocked}</Text> : null}
  </View>;
}

function CommercePurchaseModal({ item, availableBalance, quantity, mutationBlocked, creating, error, createdOrder,
  onQuantityChange, onClose, onConfirm }: Readonly<{
  item: MarketCommerceItem | null;
  availableBalance: string | null;
  quantity: string;
  mutationBlocked: string | null;
  creating: boolean;
  error: string | null;
  createdOrder: MarketCommerceOrder | null;
  onQuantityChange: (value: string) => void;
  onClose: () => void;
  onConfirm: (gate: StagingPurchaseGate) => void;
}>) {
  if (!item) return null;
  const { gate, blocked: gateBlocked } = commerceGate(item, availableBalance, quantity);
  const blocked = mutationBlocked ?? gateBlocked;
  return <Modal visible transparent animationType="slide" onRequestClose={onClose}>
    <Pressable onPress={onClose} style={styles.backdrop}><Pressable onPress={() => undefined} style={styles.purchaseSheet}>
      <View style={styles.handle} />
      {createdOrder ? <View style={styles.purchaseResult}>
        <View style={styles.purchaseSuccess}><Ionicons name="checkmark" size={28} color={colors.surface} /></View>
        <Text style={styles.purchaseTitle}>卡时预留成功</Text>
        <Text style={styles.purchaseHelp}>服务端已确认容量与卡时预留，订单号 {createdOrder.number}。</Text>
        <Pressable onPress={onClose} style={styles.primary}><Text style={styles.primaryText}>完成</Text></Pressable>
      </View> : <>
        <View style={styles.sheetHeading}><Text style={styles.sheetTitle}>确认购买算力</Text><Pressable disabled={creating} onPress={onClose}><Ionicons name="close" size={21} color={colors.ink} /></Pressable></View>
        <Text style={styles.purchaseProduct}>{item.title}</Text><Text style={styles.purchaseMeta}>{item.productCode} · {item.region}</Text>
        <View style={styles.purchaseFacts}><View><Text style={styles.factLabel}>服务端可用容量</Text><Text style={styles.factValue}>{item.capacityAvailable} {item.capacityUnit}</Text></View><View style={styles.factRight}><Text style={styles.factLabel}>可用卡时</Text><Text style={styles.factValue}>{availableBalance ?? '读取中'}</Text></View></View>
        <Text style={styles.purchaseLabel}>购买数量（{item.capacityUnit}）</Text>
        <TextInput accessibilityLabel="购买数量" value={quantity} onChangeText={onQuantityChange} keyboardType="decimal-pad" style={styles.purchaseInput} />
        <View style={styles.purchaseTotal}><Text style={styles.purchaseTotalLabel}>预计预留</Text><Text style={styles.purchaseTotalValue}>{gate.total ?? '—'} KAI 卡时</Text></View>
        {blocked ? <Text style={styles.pending}>{blocked}</Text> : null}
        {error ? <View style={styles.pageError}><Text style={styles.pageErrorText}>{error}</Text></View> : null}
        <Pressable disabled={creating || Boolean(blocked)} onPress={() => onConfirm(gate)} style={[styles.primary, (creating || Boolean(blocked)) && styles.primaryDisabled]}>{creating ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.primaryText}>由服务端确认并预留</Text>}</Pressable>
        <Text style={styles.purchaseHelp}>提交后服务端会再次校验容量与余额；未确认成功前不会宣称预留完成。</Text>
      </>}
    </Pressable></Pressable>
  </Modal>;
}

function LocalDemoMarketRow({ item }: Readonly<{ item: MarketCreditListing }>) {
  return <View style={styles.card}>
    <View style={styles.cardTop}><View style={styles.icon}><Ionicons name="hardware-chip-outline" size={20} color={colors.ink} /></View><View style={styles.cardCopy}><View style={styles.typeRow}><Text style={styles.demoTag}>测试资源</Text></View><Text numberOfLines={1} style={styles.cardTitle}>{item.title}</Text><Text style={styles.meta}>{item.productCode} · {item.region}</Text></View></View>
    <Text style={styles.demoNote}>用于核对列表、筛选和卡时信息，不进入履约和消耗。</Text>
    <View style={styles.demoFacts}><View><Text style={styles.stockLabel}>测试容量</Text><Text style={styles.stockValue}>{item.capacityTotal.replace(/\.0+$/u, '')} {item.capacityUnit}</Text></View><Text style={styles.demoClosed}>可查看详情</Text></View>
  </View>;
}

function MarketRow({ item, blockedReason, onPress }: Readonly<{ item: MarketCreditListing; blockedReason: string | null; onPress?: () => void }>) {
  const device = item.productKind === 'hardware_device';
  const enabled = Boolean(onPress);
  return <View style={styles.card}>
    <View style={styles.cardTop}><View style={styles.icon}><Ionicons name={device ? 'cube-outline' : 'hardware-chip-outline'} size={20} color={colors.ink} /></View><View style={styles.cardCopy}><View style={styles.typeRow}><Text style={styles.type}>{device ? '设备采购' : '即时算力'}</Text></View><Text numberOfLines={1} style={styles.cardTitle}>{item.title}</Text><Text style={styles.meta}>{item.productCode} · {item.region}</Text></View></View>
    <Text style={styles.audit}>{isDedicatedGpuHour(item) ? '固定分配 1 张 GPU · ' : ''}资源与价格双审通过</Text>
    <View style={styles.cardBottom}><View><Text style={styles.price}>{creditAmount(item.unitCredits)}</Text><Text style={styles.unit}>KAI 卡时 / {item.capacityUnit}</Text></View><View style={styles.stock}><Text style={styles.stockLabel}>可用</Text><Text style={styles.stockValue}>{item.capacityAvailable.replace(/\.0+$/u, '')} {item.capacityUnit}</Text></View>{enabled ? <Pressable onPress={onPress} style={styles.rowAction}><Text style={styles.rowActionText}>{item.ownedByCurrentSubject ? '管理' : device ? '查看采购' : '购买'}</Text><Ionicons name="arrow-forward" size={14} color={colors.surface} /></Pressable> : <Text style={styles.unavailable}>暂未开放</Text>}</View>
    {blockedReason ? <Text style={styles.pending}>{blockedReason}</Text> : null}
  </View>;
}

function FilterChip({ label, selected, onPress }: Readonly<{ label: string; selected: boolean; onPress: () => void }>) { return <Pressable onPress={onPress} style={[styles.regionChip, selected && styles.regionChipActive]}><Text style={[styles.regionText, selected && styles.regionTextActive]}>{label}</Text></Pressable>; }

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 16, paddingBottom: 34 }, heading: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, title: { color: colors.ink, fontSize: 25, fontWeight: '900' }, subtitle: { color: colors.muted, fontSize: 11, marginTop: 5 }, count: { color: colors.muted, fontSize: 11, marginTop: 8 },
  search: { minHeight: 48, marginTop: 15, paddingLeft: 13, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, searchInput: { flex: 1, color: colors.ink, fontSize: 13 }, filterButton: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center', borderLeftWidth: 1, borderLeftColor: colors.line }, filterDot: { position: 'absolute', right: 10, top: 10, width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary },
  sections: { flexDirection: 'row', padding: 4, marginTop: 12, borderRadius: 10, backgroundColor: '#EAF0F7' }, section: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 8 }, sectionActive: { backgroundColor: colors.surface, borderWidth: 1, borderColor: '#C9DCF6' }, sectionText: { color: colors.muted, fontSize: 12, fontWeight: '800' }, sectionTextActive: { color: colors.primary, fontWeight: '900' },
  categories: { gap: 7, paddingVertical: 12 }, category: { minHeight: 34, paddingHorizontal: 13, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, categoryActive: { borderColor: '#B7CEF4', backgroundColor: '#EDF4FF' }, categoryText: { color: colors.muted, fontSize: 11, fontWeight: '700' }, categoryTextActive: { color: colors.primary, fontWeight: '900' },
  modelCategories: { gap: 6, paddingBottom: 12 }, modelCategory: { minHeight: 28, paddingHorizontal: 10, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F2F5F9' }, modelCategoryActive: { backgroundColor: colors.primarySoft }, modelCategoryText: { color: colors.muted, fontSize: 9, fontWeight: '700' }, modelCategoryTextActive: { color: colors.primary, fontWeight: '900' },
  deviceIntro: { paddingVertical: 12 }, deviceIntroTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, deviceIntroText: { color: colors.muted, fontSize: 9, marginTop: 4 },
  inquiryIntro: { paddingTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, inquiryIntroCopy: { flex: 1 }, myInquiries: { minHeight: 36, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: '#CFE0F8' }, myInquiriesText: { color: colors.primary, fontSize: 10, fontWeight: '900' },
  list: { gap: 8 }, card: { padding: 13, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, cardTop: { flexDirection: 'row', alignItems: 'center' }, icon: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F3F5' }, cardCopy: { flex: 1, marginLeft: 10 }, typeRow: { flexDirection: 'row', gap: 7, alignItems: 'center' }, type: { color: colors.muted, fontSize: 8, fontWeight: '800' }, demoTag: { color: colors.primary, fontSize: 8, fontWeight: '900' }, demoBadge: { color: colors.amber, fontSize: 8, fontWeight: '900', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6, backgroundColor: colors.amberSoft }, demoNote: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 10 }, demoFacts: { minHeight: 48, marginTop: 11, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, demoClosed: { color: colors.muted, fontSize: 9, fontWeight: '800' }, supplier: { color: colors.muted, fontSize: 8, fontWeight: '800' }, discount: { color: colors.primary, fontSize: 8, fontWeight: '900' }, cardTitle: { color: colors.ink, fontSize: 14, fontWeight: '900', marginTop: 3 }, meta: { color: colors.muted, fontSize: 9, marginTop: 3 },
  inquiryCard: { padding: 13, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: '#D5E3F5' }, inquiryIcon: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, inquiryTag: { color: colors.primary, fontSize: 8, fontWeight: '900' }, inquiryStatus: { color: colors.amber, fontSize: 8, fontWeight: '900' }, inquiryFacts: { marginTop: 11, padding: 10, flexDirection: 'row', justifyContent: 'space-between', borderRadius: 9, backgroundColor: colors.canvas }, factRight: { alignItems: 'flex-end' }, factLabel: { color: colors.muted, fontSize: 8 }, factValue: { color: colors.ink, fontSize: 9, fontWeight: '800', marginTop: 3 }, inquiryBottom: { marginTop: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }, inquiryPrice: { color: colors.ink, fontSize: 12, fontWeight: '900' }, inquiryAction: { minHeight: 38, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 8, backgroundColor: colors.primary }, inquiryActionText: { color: colors.surface, fontSize: 10, fontWeight: '900' },
  supplierCard: { padding: 13, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: '#D5E3F5' }, supplierLogo: { width: 42, height: 42, borderRadius: 10, backgroundColor: '#F4F7FA' }, supplierLogoFallback: { width: 42, height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, supplierLogoFallbackText: { color: colors.primary, fontSize: 17, fontWeight: '900' }, contractTag: { color: colors.muted, fontSize: 8, fontWeight: '800' }, unverifiedDisclosure: { color: colors.muted, fontSize: 8, lineHeight: 13, marginTop: 9 }, supplierFacts: { marginTop: 10, padding: 11, borderRadius: 9, backgroundColor: '#F4F7FA', flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, supplierPrice: { color: colors.ink, fontSize: 16, fontWeight: '900', marginTop: 3 }, supplierPriceUnit: { color: colors.muted, fontSize: 8, marginTop: 2 }, factLabelSpaced: { color: colors.muted, fontSize: 8, marginTop: 7 }, supplierNote: { flex: 1, color: colors.muted, fontSize: 8, lineHeight: 13 },
  supplierDirectoryInitials: { color: colors.primary, fontSize: 11, fontWeight: '900', textAlign: 'center' }, supplierPriceColumn: { flex: 1, paddingRight: 8 }, supplierDirectoryPrice: { color: colors.ink, fontSize: 13, fontWeight: '900', marginTop: 3 }, directoryNotice: { marginBottom: 10, padding: 11, borderRadius: 10, backgroundColor: colors.primarySoft, borderWidth: 1, borderColor: '#CFE0F8' }, directoryNoticeTitle: { color: colors.primary, fontSize: 10, fontWeight: '900' }, directoryNoticeText: { color: colors.muted, fontSize: 8, lineHeight: 13, marginTop: 3 },
  cardBottom: { flexDirection: 'row', alignItems: 'flex-end', marginTop: 12, paddingTop: 11, borderTopWidth: 1, borderTopColor: colors.line }, price: { color: colors.ink, fontSize: 18, fontWeight: '900', marginTop: 2 }, unit: { color: colors.muted, fontSize: 8, marginTop: 2 }, stock: { flex: 1, alignItems: 'flex-end', marginRight: 10 }, stockLabel: { color: colors.muted, fontSize: 8 }, stockValue: { color: colors.ink, fontSize: 10, fontWeight: '800', marginTop: 3 }, rowAction: { minHeight: 38, paddingHorizontal: 12, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.primary }, rowActionText: { color: colors.surface, fontSize: 10, fontWeight: '900' }, unavailable: { color: colors.muted, fontSize: 9 },
  audit: { color: colors.muted, fontSize: 8, lineHeight: 13, marginTop: 9 }, loadMore: { minHeight: 44, marginTop: 10, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, loadMoreText: { color: colors.primary, fontSize: 11, fontWeight: '800' },
  pending: { color: colors.amber, fontSize: 8, marginTop: 8 },
  outage: { padding: 12, marginBottom: 10, borderRadius: 12, flexDirection: 'row', gap: 9, backgroundColor: colors.amberSoft }, outageCopy: { flex: 1 }, outageTitle: { color: colors.ink, fontSize: 11, fontWeight: '900' }, outageText: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 3 },
  inlineRetry: { minHeight: 30, marginTop: 6, alignSelf: 'flex-start', justifyContent: 'center' }, inlineRetryText: { color: colors.primary, fontSize: 9, fontWeight: '900' }, pageError: { marginTop: 9, padding: 11, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderRadius: 9, backgroundColor: colors.amberSoft }, pageErrorText: { flex: 1, color: colors.muted, fontSize: 9, marginRight: 8 },
  empty: { padding: 24, alignItems: 'center', borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, emptyTitle: { color: colors.ink, fontSize: 16, fontWeight: '900', marginTop: 10 }, emptyText: { color: colors.muted, fontSize: 10, lineHeight: 16, textAlign: 'center', marginTop: 6 }, primary: { minHeight: 46, marginTop: 15, paddingHorizontal: 18, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 12, fontWeight: '900' },
  partnerEmpty: { flexDirection: 'row', gap: 12, padding: 18, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: '#C9DCF6' }, partnerCopy: { flex: 1 }, partnerTitle: { color: colors.ink, fontSize: 14, fontWeight: '900' }, partnerText: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 5 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(17,24,39,0.30)' }, sheet: { padding: 18, paddingBottom: 28, borderTopLeftRadius: 16, borderTopRightRadius: 16, backgroundColor: colors.surface }, handle: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', backgroundColor: '#D0D5DD' }, sheetHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }, sheetTitle: { color: colors.ink, fontSize: 19, fontWeight: '900' }, reset: { color: colors.primary, fontSize: 11, fontWeight: '800' }, regionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 15 }, regionChip: { minHeight: 38, paddingHorizontal: 13, borderRadius: 8, justifyContent: 'center', backgroundColor: colors.canvas }, regionChipActive: { backgroundColor: '#EDF4FF', borderWidth: 1, borderColor: '#B7CEF4' }, regionText: { color: colors.muted, fontSize: 11 }, regionTextActive: { color: colors.primary, fontWeight: '800' },
  purchaseSheet: { padding: 18, paddingBottom: 28, borderTopLeftRadius: 20, borderTopRightRadius: 20, backgroundColor: colors.surface }, purchaseProduct: { color: colors.ink, fontSize: 15, fontWeight: '900', marginTop: 18 }, purchaseMeta: { color: colors.muted, fontSize: 10, marginTop: 5 }, purchaseFacts: { padding: 13, marginTop: 14, borderRadius: 10, flexDirection: 'row', justifyContent: 'space-between', backgroundColor: colors.canvas }, purchaseLabel: { color: colors.ink, fontSize: 11, fontWeight: '800', marginTop: 16, marginBottom: 7 }, purchaseInput: { minHeight: 50, paddingHorizontal: 13, borderWidth: 1, borderColor: colors.line, borderRadius: 9, color: colors.ink, fontSize: 20, fontWeight: '900', backgroundColor: colors.canvas }, purchaseTotal: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, marginTop: 5, borderBottomWidth: 1, borderBottomColor: colors.line }, purchaseTotalLabel: { color: colors.muted, fontSize: 10 }, purchaseTotalValue: { color: colors.ink, fontSize: 13, fontWeight: '900' }, purchaseHelp: { color: colors.muted, fontSize: 9, lineHeight: 15, textAlign: 'center', marginTop: 9 }, purchaseResult: { paddingVertical: 25, alignItems: 'center' }, purchaseSuccess: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.green }, purchaseTitle: { color: colors.ink, fontSize: 20, fontWeight: '900', marginTop: 13 }, primaryDisabled: { opacity: 0.45 },
});
