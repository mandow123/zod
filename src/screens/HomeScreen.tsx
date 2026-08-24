import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { ImageBackground, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CloudPaySnapshot, DeviceProduct } from '../api';
import type { TabKey } from '../components';
import { creditAmount } from '../format';
import { brand, colors } from '../theme';
import { isSparkCampaignListing, isSparkCampaignProduct } from '../campaign';
import {
  loadSupplierInquiryCatalog,
  supplierCatalogReferenceCredit,
  type SupplierInquiryCatalogItem,
} from '../honghuan-inquiry-catalog';
import {
  loadSupplierQuoteDirectory, supplierQuoteForBilling, supplierQuoteReference,
  type SupplierQuoteDirectoryItem,
} from '../supplier-quote-directory';

const sparkArtwork = require('../../assets/baige-spark-campaign-v1.jpg');

type Props = Readonly<{
  snapshot: CloudPaySnapshot;
  refreshing: boolean;
  onRefresh: () => void;
  onNavigate: (tab: TabKey) => void;
  onOpenDemand: () => void;
  onOpenCredits: () => void;
  onOpenSparkDetail: (product: DeviceProduct) => void;
}>;

const shortcuts = [
  { label: 'GPU 算力', icon: 'hardware-chip-outline' as const },
  { label: '推理扩容', icon: 'pulse-outline' as const },
  { label: '定向需求', icon: 'megaphone-outline' as const },
  { label: '订单进度', icon: 'receipt-outline' as const },
];

export function HomeScreen({ snapshot, refreshing, onRefresh, onNavigate, onOpenDemand, onOpenCredits, onOpenSparkDetail }: Props) {
  const spark = snapshot.deviceProducts.find(isSparkCampaignProduct) ?? null;
  const resources = snapshot.listings.filter((item) => !isSparkCampaignListing(item)).slice(0, 3);
  const [inquiryResources, setInquiryResources] = useState<readonly SupplierInquiryCatalogItem[]>([]);
  const [supplierDirectory, setSupplierDirectory] = useState<readonly SupplierQuoteDirectoryItem[]>([]);
  const pending = snapshot.orders.filter((order) => order.side === 'buyer' && order.requiresAttention).length;
  const available = snapshot.creditBalance ? creditAmount(snapshot.creditBalance.available) : snapshot.authenticated ? '余额暂未更新' : '登录后查看';
  useEffect(() => {
    let active = true;
    void loadSupplierInquiryCatalog().then((result) => {
      if (active) setInquiryResources(result.items);
    }).catch(() => {
      if (active) setInquiryResources([]);
    });
    return () => { active = false; };
  }, [refreshing]);
  const inquiryPreview = inquiryResources.slice(0, Math.max(0, 3 - resources.length));
  useEffect(() => {
    let active = true;
    void loadSupplierQuoteDirectory().then((result) => {
      if (active) setSupplierDirectory(result.items);
    }).catch(() => {
      if (active) setSupplierDirectory([]);
    });
    return () => { active = false; };
  }, [refreshing]);
  const directoryPreview = supplierDirectory.slice(0, Math.max(0, 3 - resources.length - inquiryPreview.length));

  return <View style={styles.root}><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}
    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
    <LinearGradient colors={['#E8F8F7', '#F1EEFF', '#FFFFFF']} style={styles.hero}>
      <View style={styles.heroTop}><View><Text style={styles.brand}>{brand.name}</Text><Text style={styles.heroTitle}>找到正在可用的算力</Text></View><View style={styles.onlineDot} /></View>
      <Pressable onPress={() => onNavigate('market')} style={styles.search}><Ionicons name="search-outline" size={20} color={colors.ink} /><Text style={styles.searchText}>搜索 H100、地区或交付时段</Text></Pressable>
    </LinearGradient>

    <View style={styles.accountRow}>
      <Pressable onPress={onOpenCredits} style={styles.accountItem}><Text style={styles.accountLabel}>KAI 卡时账户</Text><Text style={styles.accountValue}>{available}</Text></Pressable>
      <View style={styles.accountDivider} />
      <Pressable onPress={() => onNavigate('assets')} style={styles.accountItem}><Text style={styles.accountLabel}>待处理</Text><Text style={styles.accountValue}>{pending}</Text></Pressable>
    </View>

    <View style={styles.shortcuts}>{shortcuts.map((item, index) => <Pressable key={item.label} onPress={() => index === 2 ? onOpenDemand() : index === 3 ? onNavigate('assets') : onNavigate('market')} style={styles.shortcut}><View style={styles.shortcutIcon}><Ionicons name={item.icon} size={20} color={colors.ink} /></View><Text style={styles.shortcutText}>{item.label}</Text></Pressable>)}</View>

    {spark ? <ImageBackground source={sparkArtwork} resizeMode="cover" imageStyle={styles.sparkImage} style={styles.sparkCard}>
        <View style={styles.sparkScrim} /><View style={styles.sparkCopy}><Text style={styles.sparkSupplier}>{spark.supplier.displayName}·上海特供</Text><Text style={styles.sparkTitle}>{spark.title}</Text><Text style={styles.sparkMeta}>{spark.inventory.total} 台 · {spark.pricing.discountPercent === 20 ? '8 折' : `优惠 ${spark.pricing.discountPercent}%`} · {spark.expectedDelivery.label}</Text><Pressable onPress={() => onOpenSparkDetail(spark)} style={styles.sparkAction}><Text style={styles.sparkActionText}>查看商品</Text><Ionicons name="arrow-forward" size={16} color={colors.surface} /></Pressable></View>
    </ImageBackground> : null}

    <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>全部资源</Text><Pressable onPress={() => onNavigate('market')}><Text style={styles.textAction}>{supplierDirectory.length ? `查看 ${supplierDirectory.length} 家` : '全部市场'}</Text></Pressable></View>
    <View style={styles.resourceList}>{resources.map((listing) => <Pressable key={listing.id} onPress={() => onNavigate('market')} style={styles.resourceRow}><View style={styles.resourceIcon}><Ionicons name="hardware-chip-outline" size={20} color={colors.ink} /></View><View style={styles.resourceCopy}><Text numberOfLines={1} style={styles.resourceTitle}>{listing.title}</Text><Text style={styles.resourceMeta}>{listing.productCode} · {listing.region}</Text></View><View style={styles.resourcePrice}><Text style={styles.resourceValue}>{creditAmount(listing.unitCredits)}</Text><Text style={styles.resourceUnit}>卡时/{listing.capacityUnit}</Text></View></Pressable>)}</View>
    <View style={styles.resourceList}>{inquiryPreview.map((item) => <Pressable key={item.resourceId} onPress={() => onNavigate('market')} style={styles.resourceRow}><View style={styles.resourceIcon}><Ionicons name="calendar-outline" size={20} color={colors.ink} /></View><View style={styles.resourceCopy}><Text numberOfLines={1} style={styles.resourceTitle}>{item.title}</Text><Text style={styles.resourceMeta}>{item.supplier.displayName} · 全国 · 询价确认</Text></View><View style={styles.resourcePrice}><Text style={styles.resourceValue}>{supplierCatalogReferenceCredit(item)}</Text><Text style={styles.resourceUnit}>{item.catalogKind === 'contract_monthly' ? '参考/月' : '参考/GPU时'}</Text></View></Pressable>)}</View>
    <View style={styles.resourceList}>{directoryPreview.map((item) => { const quote = supplierQuoteForBilling(item); return <Pressable key={item.supplierId} onPress={() => onNavigate('market')} style={styles.resourceRow}><View style={styles.resourceIcon}><Ionicons name="hardware-chip-outline" size={20} color={colors.ink} /></View><View style={styles.resourceCopy}><Text numberOfLines={1} style={styles.resourceTitle}>{item.displayName}</Text><Text numberOfLines={1} style={styles.resourceMeta}>{item.gpu.models.join(' / ')} · {item.locations[0] ?? '地域待确认'} · 询价确认</Text></View><View style={styles.resourcePrice}><Text numberOfLines={1} style={styles.resourceValue}>{supplierQuoteReference(item)}</Text><Text style={styles.resourceUnit}>{quote?.model ?? 'GPU'} 参考/GPU时</Text></View></Pressable>; })}</View>
  </ScrollView></View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 16, paddingBottom: 32 },
  hero: { minHeight: 170, padding: 17, borderRadius: 12, borderWidth: 1, borderColor: '#E5E7EB' }, heroTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, brand: { color: colors.muted, fontSize: 10, fontWeight: '800' }, heroTitle: { color: colors.ink, fontSize: 24, lineHeight: 31, fontWeight: '900', marginTop: 10 }, onlineDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#20A162' },
  search: { minHeight: 46, marginTop: 21, paddingHorizontal: 13, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: 'rgba(255,255,255,0.86)' }, searchText: { color: colors.muted, fontSize: 12 },
  accountRow: { minHeight: 72, marginTop: 10, paddingHorizontal: 14, borderRadius: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, accountItem: { flex: 1 }, accountLabel: { color: colors.muted, fontSize: 9 }, accountValue: { color: colors.ink, fontSize: 19, fontWeight: '900', marginTop: 5 }, accountDivider: { width: 1, height: 35, marginHorizontal: 14, backgroundColor: colors.line },
  shortcuts: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 }, shortcut: { width: '23%', alignItems: 'center' }, shortcutIcon: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, shortcutText: { color: colors.ink, fontSize: 9, fontWeight: '700', marginTop: 7 },
  sparkCard: { height: 196, marginTop: 20, borderRadius: 12, overflow: 'hidden', justifyContent: 'flex-end' }, sparkImage: { borderRadius: 12 }, sparkScrim: { position: 'absolute', inset: 0, backgroundColor: 'rgba(8,18,35,0.47)' }, sparkCopy: { padding: 15 }, sparkSupplier: { color: '#D9E8F6', fontSize: 9, fontWeight: '800' }, sparkTitle: { color: '#FFFFFF', fontSize: 24, fontWeight: '900', marginTop: 5 }, sparkMeta: { color: '#FFFFFF', fontSize: 10, marginTop: 5 }, sparkAction: { alignSelf: 'flex-start', minHeight: 38, marginTop: 12, paddingHorizontal: 13, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: colors.primary }, sparkActionText: { color: colors.surface, fontSize: 11, fontWeight: '900' },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 22, marginBottom: 10 }, sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '900' }, textAction: { color: colors.primary, fontSize: 11, fontWeight: '800' }, resourceList: { gap: 8 }, resourceRow: { minHeight: 68, paddingHorizontal: 12, borderRadius: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, resourceIcon: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F3F5' }, resourceCopy: { flex: 1, marginLeft: 10 }, resourceTitle: { color: colors.ink, fontSize: 12, fontWeight: '800' }, resourceMeta: { color: colors.muted, fontSize: 9, marginTop: 4 }, resourcePrice: { alignItems: 'flex-end' }, resourceValue: { color: colors.ink, fontSize: 14, fontWeight: '900' }, resourceUnit: { color: colors.muted, fontSize: 8, marginTop: 3 },
});
