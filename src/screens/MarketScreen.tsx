import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { CloudPaySnapshot, DeviceProduct, MarketCreditListing } from '../api';
import { cnyPrice, creditAmount } from '../format';
import { colors } from '../theme';
import { isDedicatedGpuHour } from '../compute-product';

type Props = Readonly<{
  snapshot: CloudPaySnapshot;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenPublish: () => void;
  onBuy: (listing: MarketCreditListing) => void;
  onManageOwnListing: (listing: MarketCreditListing) => void;
  onOpenSparkDetail: (product: DeviceProduct) => void;
}>;

type Category = '全部' | '即时算力' | '设备采购' | 'GPU' | 'Token' | '其他';
const categories: Category[] = ['全部', '即时算力', '设备采购', 'GPU', 'Token', '其他'];
const LISTING_PAGE_SIZE = 20;

export function isBaigeSparkListing(item: MarketCreditListing) {
  return item.title === '02672 白鸽在线特供款'
    && item.productCode === 'NVIDIA DGX Spark'
    && item.productKind === 'hardware_device'
    && item.capacityUnit === '台'
    && item.capacityTotal === '200.000000';
}

export function isSparkDeviceProduct(item: DeviceProduct) {
  return item.id === '02672000-0000-4000-8000-000000000200'
    && item.title === 'NVIDIA DGX Spark'
    && item.productType === 'physical_delivery';
}

function categoryMatches(item: MarketCreditListing, category: Category) {
  if (category === '全部') return true;
  if (category === '即时算力') return item.productKind !== 'hardware_device';
  if (category === '设备采购') return item.productKind === 'hardware_device';
  if (category === 'GPU') return item.kind === 'gpu' || item.kind === 'apple_silicon';
  if (category === 'Token') return item.kind === 'token_capacity' || item.kind === 'token_usage';
  return !['gpu', 'apple_silicon', 'token_capacity', 'token_usage'].includes(item.kind);
}

export function MarketScreen({ snapshot, refreshing, onRefresh, onOpenPublish, onBuy, onManageOwnListing, onOpenSparkDetail }: Props) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('全部');
  const [filterVisible, setFilterVisible] = useState(false);
  const [region, setRegion] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(LISTING_PAGE_SIZE);
  const regions = useMemo(() => Array.from(new Set(snapshot.listings.map((item) => item.region))).sort(), [snapshot.listings]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return snapshot.listings.filter((item) => !isBaigeSparkListing(item) && categoryMatches(item, category) && (!region || item.region === region)
      && (!needle || `${item.title} ${item.productCode} ${item.region}`.toLowerCase().includes(needle)))
      .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'));
  }, [category, query, region, snapshot.listings]);
  const deviceProducts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!['全部', '设备采购'].includes(category) || region) return [];
    return snapshot.deviceProducts.filter((item) => isSparkDeviceProduct(item)
      && (!needle || `${item.title} ${item.sku} ${item.supplier.displayName}`.toLowerCase().includes(needle)));
  }, [category, query, region, snapshot.deviceProducts]);
  useEffect(() => setVisibleCount(LISTING_PAGE_SIZE), [category, query, region]);
  const visibleListings = filtered.slice(0, visibleCount);

  return <View style={styles.root}>
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
      <View style={styles.heading}><View><Text style={styles.title}>算力市场</Text><Text style={styles.subtitle}>价格与资源已审核</Text></View><Text style={styles.count}>{filtered.length + deviceProducts.length} 项</Text></View>
      <View style={styles.search}><Ionicons name="search-outline" size={20} color={colors.ink} /><TextInput value={query} onChangeText={setQuery} placeholder="搜索型号、地区" placeholderTextColor={colors.subtle} style={styles.searchInput} />{query ? <Pressable onPress={() => setQuery('')}><Ionicons name="close-circle" size={19} color={colors.subtle} /></Pressable> : null}<Pressable onPress={() => setFilterVisible(true)} style={styles.filterButton}><Ionicons name="options-outline" size={18} color={colors.ink} />{region ? <View style={styles.filterDot} /> : null}</Pressable></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categories}>{categories.map((item) => <Pressable key={item} onPress={() => setCategory(item)} style={[styles.category, category === item && styles.categoryActive]}><Text style={[styles.categoryText, category === item && styles.categoryTextActive]}>{item}</Text></Pressable>)}</ScrollView>

      <View style={styles.list}>{deviceProducts.map((product) => <DeviceProductRow key={product.id} product={product} onPress={() => onOpenSparkDetail(product)} />)}{visibleListings.map((item) => <MarketRow key={item.id} item={item}
        onPress={item.ownedByCurrentSubject ? () => onManageOwnListing(item) : isDedicatedGpuHour(item) ? () => onBuy(item) : undefined} />)}</View>
      {visibleCount < filtered.length ? <Pressable onPress={() => setVisibleCount((count) => count + LISTING_PAGE_SIZE)} style={styles.loadMore}><Text style={styles.loadMoreText}>继续显示</Text></Pressable> : null}
      {!filtered.length && !deviceProducts.length ? <View style={styles.empty}><Ionicons name="search-outline" size={28} color={colors.muted} /><Text style={styles.emptyTitle}>没找到匹配资源</Text><Text style={styles.emptyText}>换个型号或地区，也可以提交定向需求。</Text><Pressable onPress={onOpenPublish} style={styles.primary}><Text style={styles.primaryText}>发布算力需求</Text></Pressable></View> : null}
    </ScrollView>
    <Modal visible={filterVisible} transparent animationType="slide" onRequestClose={() => setFilterVisible(false)}><Pressable onPress={() => setFilterVisible(false)} style={styles.backdrop}><Pressable onPress={() => undefined} style={styles.sheet}><View style={styles.handle} /><View style={styles.sheetHeading}><Text style={styles.sheetTitle}>筛选地区</Text><Pressable onPress={() => { setRegion(null); setFilterVisible(false); }}><Text style={styles.reset}>重置</Text></Pressable></View><View style={styles.regionGrid}><FilterChip label="全部地区" selected={!region} onPress={() => setRegion(null)} />{regions.map((item) => <FilterChip key={item} label={item} selected={region === item} onPress={() => setRegion(item)} />)}</View><Pressable onPress={() => setFilterVisible(false)} style={styles.primary}><Text style={styles.primaryText}>查看结果</Text></Pressable></Pressable></Pressable></Modal>
  </View>;
}

function DeviceProductRow({ product, onPress }: Readonly<{ product: DeviceProduct; onPress: () => void }>) {
  return <View style={styles.card}>
    <View style={styles.cardTop}><View style={styles.icon}><Ionicons name="cube-outline" size={20} color={colors.ink} /></View><View style={styles.cardCopy}><View style={styles.typeRow}><Text style={styles.type}>设备采购</Text><Text style={styles.supplier}>{product.supplier.displayName}特供</Text></View><Text style={styles.cardTitle}>{product.title}</Text><Text style={styles.meta}>{product.sku} · {product.expectedDelivery.label}</Text></View></View>
    <Text style={styles.audit}>设备商品与价格以平台商品目录为准</Text>
    <View style={styles.cardBottom}><View><Text style={styles.price}>¥{cnyPrice(product.pricing.salePriceCny)}</Text><Text style={styles.unit}>含税 / 台 · {creditAmount(product.pricing.unitCredit)} 卡时</Text></View><View style={styles.stock}><Text style={styles.stockLabel}>可售</Text><Text style={styles.stockValue}>{product.inventory.available} 台</Text></View><Pressable onPress={onPress} style={styles.rowAction}><Text style={styles.rowActionText}>查看商品</Text><Ionicons name="arrow-forward" size={14} color={colors.surface} /></Pressable></View>
    {!product.purchasable ? <Text style={styles.pending}>供应主体核验完成后开放购买</Text> : null}
  </View>;
}

function MarketRow({ item, onPress }: Readonly<{ item: MarketCreditListing; onPress?: () => void }>) {
  const spark = isBaigeSparkListing(item);
  const device = item.productKind === 'hardware_device';
  const enabled = Boolean(onPress);
  return <View style={styles.card}>
    <View style={styles.cardTop}><View style={styles.icon}><Ionicons name={device ? 'cube-outline' : 'hardware-chip-outline'} size={20} color={colors.ink} /></View><View style={styles.cardCopy}><View style={styles.typeRow}><Text style={styles.type}>{device ? '设备采购' : '即时算力'}</Text>{spark ? <Text style={styles.supplier}>白鸽在线特供</Text> : null}</View><Text numberOfLines={1} style={styles.cardTitle}>{spark ? 'NVIDIA DGX Spark' : item.title}</Text><Text style={styles.meta}>{item.productCode} · {item.region}</Text></View></View>
    <Text style={styles.audit}>{isDedicatedGpuHour(item) ? '固定分配 1 张 GPU · ' : ''}资源与价格双审通过 · 人民币参考 ¥{cnyPrice(item.referenceCny)}</Text>
    <View style={styles.cardBottom}><View><Text style={styles.price}>{spark && item.promotion ? `¥${item.promotion.discountedReferenceCny}` : creditAmount(item.unitCredits)}</Text><Text style={styles.unit}>{device ? `含税 / ${item.capacityUnit}` : `KAI 卡时 / ${item.capacityUnit}`}</Text></View><View style={styles.stock}><Text style={styles.stockLabel}>可用</Text><Text style={styles.stockValue}>{item.capacityAvailable.replace(/\.0+$/u, '')} {item.capacityUnit}</Text></View>{enabled ? <Pressable onPress={onPress} style={styles.rowAction}><Text style={styles.rowActionText}>{item.ownedByCurrentSubject ? '管理' : device ? '查看采购' : '购买'}</Text><Ionicons name="arrow-forward" size={14} color={colors.surface} /></Pressable> : <Text style={styles.unavailable}>暂未开放</Text>}</View>
  </View>;
}

function FilterChip({ label, selected, onPress }: Readonly<{ label: string; selected: boolean; onPress: () => void }>) { return <Pressable onPress={onPress} style={[styles.regionChip, selected && styles.regionChipActive]}><Text style={[styles.regionText, selected && styles.regionTextActive]}>{label}</Text></Pressable>; }

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 16, paddingBottom: 34 }, heading: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, title: { color: colors.ink, fontSize: 25, fontWeight: '900' }, subtitle: { color: colors.muted, fontSize: 11, marginTop: 5 }, count: { color: colors.muted, fontSize: 11, marginTop: 8 },
  search: { minHeight: 48, marginTop: 15, paddingLeft: 13, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, searchInput: { flex: 1, color: colors.ink, fontSize: 13 }, filterButton: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center', borderLeftWidth: 1, borderLeftColor: colors.line }, filterDot: { position: 'absolute', right: 10, top: 10, width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary },
  categories: { gap: 7, paddingVertical: 12 }, category: { minHeight: 34, paddingHorizontal: 13, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, categoryActive: { borderColor: '#B7CEF4', backgroundColor: '#EDF4FF' }, categoryText: { color: colors.muted, fontSize: 11, fontWeight: '700' }, categoryTextActive: { color: colors.primary, fontWeight: '900' },
  list: { gap: 8 }, card: { padding: 13, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, cardTop: { flexDirection: 'row', alignItems: 'center' }, icon: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F3F5' }, cardCopy: { flex: 1, marginLeft: 10 }, typeRow: { flexDirection: 'row', gap: 7, alignItems: 'center' }, type: { color: colors.muted, fontSize: 8, fontWeight: '800' }, supplier: { color: '#8A5B00', fontSize: 8, fontWeight: '800' }, cardTitle: { color: colors.ink, fontSize: 14, fontWeight: '900', marginTop: 3 }, meta: { color: colors.muted, fontSize: 9, marginTop: 3 },
  cardBottom: { flexDirection: 'row', alignItems: 'flex-end', marginTop: 12, paddingTop: 11, borderTopWidth: 1, borderTopColor: colors.line }, price: { color: colors.ink, fontSize: 18, fontWeight: '900' }, unit: { color: colors.muted, fontSize: 8, marginTop: 2 }, stock: { flex: 1, alignItems: 'flex-end', marginRight: 10 }, stockLabel: { color: colors.muted, fontSize: 8 }, stockValue: { color: colors.ink, fontSize: 10, fontWeight: '800', marginTop: 3 }, rowAction: { minHeight: 38, paddingHorizontal: 12, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.primary }, rowActionText: { color: colors.surface, fontSize: 10, fontWeight: '900' }, unavailable: { color: colors.muted, fontSize: 9 },
  audit: { color: colors.muted, fontSize: 8, lineHeight: 13, marginTop: 9 }, loadMore: { minHeight: 44, marginTop: 10, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, loadMoreText: { color: colors.primary, fontSize: 11, fontWeight: '800' },
  pending: { color: colors.amber, fontSize: 8, marginTop: 8 },
  empty: { padding: 24, alignItems: 'center', borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, emptyTitle: { color: colors.ink, fontSize: 16, fontWeight: '900', marginTop: 10 }, emptyText: { color: colors.muted, fontSize: 10, lineHeight: 16, textAlign: 'center', marginTop: 6 }, primary: { minHeight: 46, marginTop: 15, paddingHorizontal: 18, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 12, fontWeight: '900' },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(17,24,39,0.30)' }, sheet: { padding: 18, paddingBottom: 28, borderTopLeftRadius: 16, borderTopRightRadius: 16, backgroundColor: colors.surface }, handle: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', backgroundColor: '#D0D5DD' }, sheetHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }, sheetTitle: { color: colors.ink, fontSize: 19, fontWeight: '900' }, reset: { color: colors.primary, fontSize: 11, fontWeight: '800' }, regionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 15 }, regionChip: { minHeight: 38, paddingHorizontal: 13, borderRadius: 8, justifyContent: 'center', backgroundColor: colors.canvas }, regionChipActive: { backgroundColor: '#EDF4FF', borderWidth: 1, borderColor: '#B7CEF4' }, regionText: { color: colors.muted, fontSize: 11 }, regionTextActive: { color: colors.primary, fontWeight: '800' },
});
