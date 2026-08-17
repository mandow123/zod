import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { CloudPaySnapshot, DeviceProduct, MarketCreditListing } from '../api';
import { creditAmount } from '../format';
import { deviceProductRegion, isSparkCampaignListing, isSparkCampaignProduct } from '../campaign';
import { colors } from '../theme';
import { isDedicatedGpuHour } from '../compute-product';
import { distributionPolicy } from '../distribution';
import { deviceMarketAvailability, deviceProductAvailability, listingAvailability, marketAvailability } from '../market-availability';
import { VastPurchaseSheet } from '../VastPurchaseSheet';
import { loadVastOffers, type VastOffer } from '../vast-commerce';

type Props = Readonly<{
  snapshot: CloudPaySnapshot;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenPublish: () => void;
  onBuy: (listing: MarketCreditListing) => void;
  onManageOwnListing: (listing: MarketCreditListing) => void;
  onOpenSparkDetail: (product: DeviceProduct) => void;
  onLogin: () => void;
}>;

type MarketSection = '算力租用' | '设备采购';
type ComputeSource = '平台保障' | 'Vast.ai 即时';
const sections: MarketSection[] = ['算力租用', '设备采购'];
const computeSources: ComputeSource[] = ['平台保障', 'Vast.ai 即时'];
const LISTING_PAGE_SIZE = 20;

export function MarketScreen({ snapshot, refreshing, onRefresh, onOpenPublish, onBuy, onManageOwnListing, onOpenSparkDetail, onLogin }: Props) {
  const [query, setQuery] = useState('');
  const [section, setSection] = useState<MarketSection>('设备采购');
  const [computeSource, setComputeSource] = useState<ComputeSource>('平台保障');
  const [filterVisible, setFilterVisible] = useState(false);
  const [region, setRegion] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(LISTING_PAGE_SIZE);
  const [vastOffers, setVastOffers] = useState<VastOffer[]>([]);
  const [vastState, setVastState] = useState<'idle' | 'loading' | 'available' | 'unavailable' | 'error'>('idle');
  const [selectedVastOffer, setSelectedVastOffer] = useState<VastOffer | null>(null);
  const regions = useMemo(() => Array.from(new Set([
    ...snapshot.listings.map((item) => item.region),
    ...snapshot.deviceProducts.map(deviceProductRegion).filter((value): value is string => Boolean(value)),
    ...vastOffers.map((item) => item.region),
  ])).sort(), [snapshot.deviceProducts, snapshot.listings, vastOffers]);
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
  const vastFiltered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (section !== '算力租用' || computeSource !== 'Vast.ai 即时') return [];
    return vastOffers.filter((item) => (!region || item.region === region)
      && (!needle || `${item.gpu.name} ${item.gpu.count} ${item.region} vast.ai`.toLowerCase().includes(needle)));
  }, [computeSource, query, region, section, vastOffers]);
  useEffect(() => {
    if (section !== '算力租用' || computeSource !== 'Vast.ai 即时') return;
    let active = true; setVastState('loading');
    void loadVastOffers().then((catalog) => {
      if (!active) return;
      setVastOffers(catalog.resources);
      setVastState(catalog.availability === 'available' ? 'available' : 'unavailable');
    }).catch(() => { if (active) { setVastOffers([]); setVastState('error'); } });
    return () => { active = false; };
  }, [computeSource, refreshing, section]);
  useEffect(() => setVisibleCount(LISTING_PAGE_SIZE), [computeSource, query, region, section]);
  const visibleListings = filtered.slice(0, visibleCount);
  const marketUnavailable = !snapshot.online || (section === '设备采购' ? !snapshot.deviceCatalogOnline
    : computeSource === 'Vast.ai 即时' ? vastState === 'unavailable' || vastState === 'error' : !snapshot.listingCatalogOnline);
  const marketState = marketAvailability(snapshot, distributionPolicy.newOrders);
  const deviceMarketState = deviceMarketAvailability(snapshot, distributionPolicy.newOrders);

  return <View style={styles.root}>
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
      <View style={styles.heading}><View><Text style={styles.title}>资源市场</Text><Text style={styles.subtitle}>{marketUnavailable ? '目录正在同步' : section === '设备采购' ? '实物设备采购与履约' : '即时开通，按卡时结算'}</Text></View><Text style={styles.count}>{filtered.length + deviceProducts.length + vastFiltered.length} 项</Text></View>
      <View style={styles.search}><Ionicons name="search-outline" size={20} color={colors.ink} /><TextInput value={query} onChangeText={setQuery} placeholder={section === '设备采购' ? '搜索 Spark、DGX、02672' : '搜索 GPU 型号、地区'} placeholderTextColor={colors.subtle} style={styles.searchInput} />{query ? <Pressable onPress={() => setQuery('')}><Ionicons name="close-circle" size={19} color={colors.subtle} /></Pressable> : null}<Pressable onPress={() => setFilterVisible(true)} style={styles.filterButton}><Ionicons name="options-outline" size={18} color={colors.ink} />{region ? <View style={styles.filterDot} /> : null}</Pressable></View>
      <View style={styles.sections}>{sections.map((item) => <Pressable key={item} onPress={() => { setSection(item); setRegion(null); }} style={[styles.section, section === item && styles.sectionActive]}><Text style={[styles.sectionText, section === item && styles.sectionTextActive]}>{item}</Text></Pressable>)}</View>
      {section === '算力租用' ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categories}>{computeSources.map((item) => <Pressable key={item} onPress={() => setComputeSource(item)} style={[styles.category, computeSource === item && styles.categoryActive]}><Text style={[styles.categoryText, computeSource === item && styles.categoryTextActive]}>{item}</Text></Pressable>)}</ScrollView> : <View style={styles.deviceIntro}><Text style={styles.deviceIntroTitle}>设备采购</Text><Text style={styles.deviceIntroText}>库存、卡时价格和交付进度由平台订单统一管理</Text></View>}

      {marketUnavailable ? <View style={styles.outage}><Ionicons name="cloud-offline-outline" size={20} color={colors.amber} /><View style={styles.outageCopy}><Text style={styles.outageTitle}>市场数据暂时无法确认</Text><Text style={styles.outageText}>不会把断网当成库存为零。下拉刷新后再查看价格和购买状态。</Text></View></View> : null}
      <View style={styles.list}>{deviceProducts.map((product) => <DeviceProductRow key={product.id} product={product}
        blockedReason={deviceProductAvailability(deviceMarketState, product).reason}
        onPress={() => onOpenSparkDetail(product)} />)}{vastFiltered.map((item) => <VastOfferRow key={item.offerId} offer={item} onPress={() => snapshot.authenticated ? setSelectedVastOffer(item) : onLogin()} />)}{visibleListings.map((item) => <MarketRow key={item.id} item={item}
        blockedReason={item.ownedByCurrentSubject ? null : listingAvailability(marketState, item, isDedicatedGpuHour(item)).reason}
        onPress={item.ownedByCurrentSubject ? () => onManageOwnListing(item) : listingAvailability(marketState, item, isDedicatedGpuHour(item)).allowed ? () => onBuy(item) : undefined} />)}</View>
      {visibleCount < filtered.length ? <Pressable onPress={() => setVisibleCount((count) => count + LISTING_PAGE_SIZE)} style={styles.loadMore}><Text style={styles.loadMoreText}>继续显示</Text></Pressable> : null}
      {section === '算力租用' && computeSource === 'Vast.ai 即时' && vastState === 'loading' ? <View style={styles.partnerEmpty}><ActivityIndicator color={colors.primary} /><View style={styles.partnerCopy}><Text style={styles.partnerTitle}>正在读取 Vast.ai</Text><Text style={styles.partnerText}>只接收可租用且已验证的即时资源。</Text></View></View> : null}
      {section === '算力租用' && computeSource === 'Vast.ai 即时' && vastState === 'available' && !vastFiltered.length ? <View style={styles.partnerEmpty}><Ionicons name="flash-outline" size={24} color={colors.primary} /><View style={styles.partnerCopy}><Text style={styles.partnerTitle}>当前没有匹配资源</Text><Text style={styles.partnerText}>Vast.ai 库存会实时变化，可稍后下拉刷新。</Text></View></View> : null}
      {!marketUnavailable && computeSource !== 'Vast.ai 即时' && !filtered.length && !deviceProducts.length ? <View style={styles.empty}><Ionicons name="search-outline" size={28} color={colors.muted} /><Text style={styles.emptyTitle}>没找到匹配资源</Text><Text style={styles.emptyText}>换个型号或地区，也可以提交定向需求。</Text><Pressable onPress={onOpenPublish} style={styles.primary}><Text style={styles.primaryText}>发布算力需求</Text></Pressable></View> : null}
    </ScrollView>
    <VastPurchaseSheet offer={selectedVastOffer} visible={Boolean(selectedVastOffer)} onClose={() => setSelectedVastOffer(null)} onOrdered={() => onRefresh()} />
    <Modal visible={filterVisible} transparent animationType="slide" onRequestClose={() => setFilterVisible(false)}><Pressable onPress={() => setFilterVisible(false)} style={styles.backdrop}><Pressable onPress={() => undefined} style={styles.sheet}><View style={styles.handle} /><View style={styles.sheetHeading}><Text style={styles.sheetTitle}>筛选地区</Text><Pressable onPress={() => { setRegion(null); setFilterVisible(false); }}><Text style={styles.reset}>重置</Text></Pressable></View><View style={styles.regionGrid}><FilterChip label="全部地区" selected={!region} onPress={() => setRegion(null)} />{regions.map((item) => <FilterChip key={item} label={item} selected={region === item} onPress={() => setRegion(item)} />)}</View><Pressable onPress={() => setFilterVisible(false)} style={styles.primary}><Text style={styles.primaryText}>查看结果</Text></Pressable></Pressable></Pressable></Modal>
  </View>;
}

function DeviceProductRow({ product, blockedReason, onPress }: Readonly<{ product: DeviceProduct; blockedReason: string | null; onPress: () => void }>) {
  return <View style={styles.card}>
    <View style={styles.cardTop}><View style={styles.icon}><Ionicons name="cube-outline" size={20} color={colors.ink} /></View><View style={styles.cardCopy}><View style={styles.typeRow}><Text style={styles.type}>设备采购</Text><Text style={styles.supplier}>{product.supplier.displayName}特供</Text><Text style={styles.discount}>{product.pricing.discountPercent === 20 ? '8 折' : `优惠 ${product.pricing.discountPercent}%`}</Text></View><Text style={styles.cardTitle}>{product.title}</Text><Text style={styles.meta}>{product.sku} · {product.expectedDelivery.label}</Text></View></View>
    <Text style={styles.audit}>设备商品与价格以平台商品目录为准</Text>
    <View style={styles.cardBottom}><View><Text style={styles.originalPrice}>{creditAmount(product.pricing.listUnitCredit)} 卡时</Text><Text style={styles.price}>{creditAmount(product.pricing.unitCredit)}</Text><Text style={styles.unit}>KAI 卡时 / 台</Text></View><View style={styles.stock}><Text style={styles.stockLabel}>可售</Text><Text style={styles.stockValue}>{product.inventory.available} 台</Text></View><Pressable onPress={onPress} style={styles.rowAction}><Text style={styles.rowActionText}>查看商品</Text><Ionicons name="arrow-forward" size={14} color={colors.surface} /></Pressable></View>
    {blockedReason ? <Text style={styles.pending}>{blockedReason}</Text> : null}
  </View>;
}

function VastOfferRow({ offer, onPress }: Readonly<{ offer: VastOffer; onPress: () => void }>) {
  const reliability = `${Math.round(offer.reliability * 1000) / 10}%`;
  return <View style={styles.card}>
    <View style={styles.cardTop}><View style={styles.vastIcon}><Ionicons name="flash-outline" size={20} color={colors.primary} /></View><View style={styles.cardCopy}><View style={styles.typeRow}><Text style={styles.partnerTag}>Vast.ai 合作资源</Text><Text style={styles.verifiedTag}>已验证 · {reliability}</Text></View><Text numberOfLines={1} style={styles.cardTitle}>{offer.gpu.count} × {offer.gpu.name}</Text><Text style={styles.meta}>{offer.gpu.memoryGb} GB 显存 / 卡 · {offer.region}</Text></View></View>
    <Text style={styles.audit}>即时库存 · 提交前重新确认价格与可用状态</Text>
    <View style={styles.cardBottom}><View><Text style={styles.price}>{creditAmount(offer.pricing.cardHoursPerHour)}</Text><Text style={styles.unit}>KAI 卡时 / 小时</Text></View><View style={styles.stock}><Text style={styles.stockLabel}>交付方式</Text><Text style={styles.stockValue}>自动部署</Text></View><Pressable onPress={onPress} style={styles.rowAction}><Text style={styles.rowActionText}>选择时长</Text><Ionicons name="arrow-forward" size={14} color={colors.surface} /></Pressable></View>
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
  deviceIntro: { paddingVertical: 12 }, deviceIntroTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, deviceIntroText: { color: colors.muted, fontSize: 9, marginTop: 4 },
  list: { gap: 8 }, card: { padding: 13, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, cardTop: { flexDirection: 'row', alignItems: 'center' }, icon: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F3F5' }, vastIcon: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, cardCopy: { flex: 1, marginLeft: 10 }, typeRow: { flexDirection: 'row', gap: 7, alignItems: 'center' }, type: { color: colors.muted, fontSize: 8, fontWeight: '800' }, supplier: { color: '#8A5B00', fontSize: 8, fontWeight: '800' }, discount: { color: colors.primary, fontSize: 8, fontWeight: '900' }, partnerTag: { color: colors.primary, fontSize: 8, fontWeight: '900' }, verifiedTag: { color: colors.green, fontSize: 8, fontWeight: '800' }, cardTitle: { color: colors.ink, fontSize: 14, fontWeight: '900', marginTop: 3 }, meta: { color: colors.muted, fontSize: 9, marginTop: 3 },
  cardBottom: { flexDirection: 'row', alignItems: 'flex-end', marginTop: 12, paddingTop: 11, borderTopWidth: 1, borderTopColor: colors.line }, originalPrice: { color: colors.muted, fontSize: 9, textDecorationLine: 'line-through' }, price: { color: colors.ink, fontSize: 18, fontWeight: '900', marginTop: 2 }, unit: { color: colors.muted, fontSize: 8, marginTop: 2 }, stock: { flex: 1, alignItems: 'flex-end', marginRight: 10 }, stockLabel: { color: colors.muted, fontSize: 8 }, stockValue: { color: colors.ink, fontSize: 10, fontWeight: '800', marginTop: 3 }, rowAction: { minHeight: 38, paddingHorizontal: 12, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.primary }, rowActionText: { color: colors.surface, fontSize: 10, fontWeight: '900' }, unavailable: { color: colors.muted, fontSize: 9 },
  audit: { color: colors.muted, fontSize: 8, lineHeight: 13, marginTop: 9 }, loadMore: { minHeight: 44, marginTop: 10, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, loadMoreText: { color: colors.primary, fontSize: 11, fontWeight: '800' },
  pending: { color: colors.amber, fontSize: 8, marginTop: 8 },
  outage: { padding: 12, marginBottom: 10, borderRadius: 12, flexDirection: 'row', gap: 9, backgroundColor: colors.amberSoft }, outageCopy: { flex: 1 }, outageTitle: { color: colors.ink, fontSize: 11, fontWeight: '900' }, outageText: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 3 },
  empty: { padding: 24, alignItems: 'center', borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, emptyTitle: { color: colors.ink, fontSize: 16, fontWeight: '900', marginTop: 10 }, emptyText: { color: colors.muted, fontSize: 10, lineHeight: 16, textAlign: 'center', marginTop: 6 }, primary: { minHeight: 46, marginTop: 15, paddingHorizontal: 18, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 12, fontWeight: '900' },
  partnerEmpty: { flexDirection: 'row', gap: 12, padding: 18, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: '#C9DCF6' }, partnerCopy: { flex: 1 }, partnerTitle: { color: colors.ink, fontSize: 14, fontWeight: '900' }, partnerText: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 5 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(17,24,39,0.30)' }, sheet: { padding: 18, paddingBottom: 28, borderTopLeftRadius: 16, borderTopRightRadius: 16, backgroundColor: colors.surface }, handle: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', backgroundColor: '#D0D5DD' }, sheetHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }, sheetTitle: { color: colors.ink, fontSize: 19, fontWeight: '900' }, reset: { color: colors.primary, fontSize: 11, fontWeight: '800' }, regionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 15 }, regionChip: { minHeight: 38, paddingHorizontal: 13, borderRadius: 8, justifyContent: 'center', backgroundColor: colors.canvas }, regionChipActive: { backgroundColor: '#EDF4FF', borderWidth: 1, borderColor: '#B7CEF4' }, regionText: { color: colors.muted, fontSize: 11 }, regionTextActive: { color: colors.primary, fontWeight: '800' },
});
