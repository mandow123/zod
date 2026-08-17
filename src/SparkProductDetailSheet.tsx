import { Ionicons } from '@expo/vector-icons';
import { ImageBackground, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { DeviceProduct } from './api';
import { creditAmount } from './format';
import { colors } from './theme';

const artwork = require('../assets/baige-spark-campaign-v1.jpg');

export function SparkProductDetailSheet({ product, visible, purchaseAllowed, blockedReason, onClose, onBuy }: Readonly<{
  product: DeviceProduct | null;
  visible: boolean;
  purchaseAllowed: boolean;
  blockedReason: string | null;
  onClose: () => void;
  onBuy: (product: DeviceProduct) => void;
}>) {
  if (!product) return null;
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <View style={styles.backdrop}><View style={styles.sheet}>
      <View style={styles.handle} />
      <View style={styles.header}>
        <View><Text style={styles.eyebrow}>{product.supplier.displayName} · 活动商品</Text><Text style={styles.title}>{product.title}</Text></View>
        <Pressable onPress={onClose} style={styles.close} accessibilityLabel="关闭白鸽在线特供款详情"><Ionicons name="close" size={23} color={colors.ink} /></Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ImageBackground source={artwork} resizeMode="cover" imageStyle={styles.heroImage} style={styles.hero}>
          <View style={styles.heroScrim} />
          <View style={styles.heroCopy}>
            <Text style={styles.heroLabel}>{product.supplier.displayName} · 上海</Text>
            <Text style={styles.heroTitle}>{product.inventory.total} 台限量</Text>
            <Text style={styles.heroCaption}>整机实物交付 · {product.expectedDelivery.label}</Text>
          </View>
        </ImageBackground>

        <View style={styles.priceCard}>
          <View style={styles.discountBadge}><Text style={styles.discountText}>{product.pricing.discountPercent === 20 ? '8 折' : `优惠 ${product.pricing.discountPercent}%`}</Text></View>
          <Text style={styles.priceLabel}>活动价</Text>
          <Text style={styles.price}>{creditAmount(product.pricing.unitCredit)} <Text style={styles.unit}>KAI 卡时 / 台</Text></Text>
        </View>

        <View style={styles.inventoryCard}>
          <Inventory label="总量" value={`${product.inventory.total} 台`} />
          <View style={styles.inventoryDivider} />
          <Inventory label="已售" value={`${product.inventory.sold} 台`} />
          <View style={styles.inventoryDivider} />
          <Inventory label="剩余" value={`${product.inventory.available} 台`} strong />
        </View>

        <Fact icon="cube-outline" title="整机商品" body={`${product.title} 采用实物交付，不作为 GPU 小时算力订单。`} />
        <Fact icon="time-outline" title="交付周期" body={`${product.expectedDelivery.label}，实际交付节点以订单和平台消息为准。`} />
        <Fact icon="shield-checkmark-outline" title="价格说明" body={`当前价格 ${creditAmount(product.pricing.unitCredit)} KAI 卡时 / 台，已按 8 折活动直接展示，价格由服务端锁定。`} />
        {!purchaseAllowed ? <View style={styles.blocked}><Ionicons name="alert-circle-outline" size={19} color={colors.amber} /><Text style={styles.noticeText}>{blockedReason ?? '该商品当前暂不可购买。'}</Text></View> : null}
        <View style={styles.notice}><Ionicons name="information-circle-outline" size={20} color={colors.amber} /><Text style={styles.noticeText}>点击购买只会进入确认页；数量、价格与订单结果以服务端确认为准。</Text></View>
      </ScrollView>
      <View style={styles.footer}><View><Text style={styles.footerLabel}>活动价</Text><Text style={styles.footerPrice}>{creditAmount(product.pricing.unitCredit)} 卡时 / 台</Text></View><Pressable disabled={!purchaseAllowed} onPress={() => onBuy(product)} style={[styles.buy, !purchaseAllowed && styles.buyDisabled]}><Text style={styles.buyText}>{purchaseAllowed ? '立即购买' : '暂不可购买'}</Text><Ionicons name="arrow-forward" size={17} color={colors.surface} /></Pressable></View>
    </View></View>
  </Modal>;
}

function Inventory({ label, value, strong = false }: Readonly<{ label: string; value: string; strong?: boolean }>) {
  return <View style={styles.inventoryItem}><Text style={styles.inventoryLabel}>{label}</Text><Text style={[styles.inventoryValue, strong && styles.inventoryStrong]}>{value}</Text></View>;
}

function Fact({ icon, title, body }: Readonly<{ icon: 'cube-outline' | 'time-outline' | 'shield-checkmark-outline'; title: string; body: string }>) {
  return <View style={styles.fact}><View style={styles.factIcon}><Ionicons name={icon} size={20} color={colors.primary} /></View><View style={styles.factCopy}><Text style={styles.factTitle}>{title}</Text><Text style={styles.factBody}>{body}</Text></View></View>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(18,35,58,0.38)' },
  sheet: { maxHeight: '93%', borderTopLeftRadius: 16, borderTopRightRadius: 16, backgroundColor: colors.canvas },
  handle: { width: 42, height: 5, alignSelf: 'center', borderRadius: 3, marginTop: 9, backgroundColor: '#D6DEE8' },
  header: { minHeight: 78, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { color: colors.primary, fontSize: 10, fontWeight: '900' },
  title: { color: colors.ink, fontSize: 22, fontWeight: '900', marginTop: 4 },
  close: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  content: { padding: 17, paddingBottom: 18 },
  hero: { height: 205, borderRadius: 12, overflow: 'hidden', justifyContent: 'flex-end' },
  heroImage: { borderRadius: 12 },
  heroScrim: { position: 'absolute', inset: 0, backgroundColor: 'rgba(9,32,56,0.50)' },
  heroCopy: { padding: 17 },
  heroLabel: { color: '#DCEEFF', fontSize: 10, fontWeight: '900' },
  heroTitle: { color: '#FFFFFF', fontSize: 27, fontWeight: '900', marginTop: 6 },
  heroCaption: { color: '#FFFFFF', fontSize: 11, marginTop: 6 },
  priceCard: { padding: 17, marginTop: 12, borderWidth: 1, borderColor: '#D5E5FA', borderRadius: 12, backgroundColor: colors.surface },
  discountBadge: { alignSelf: 'flex-start', paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999, backgroundColor: '#EAF2FF' },
  discountText: { color: colors.primary, fontSize: 10, fontWeight: '900' },
  priceLabel: { color: colors.primary, fontSize: 10, fontWeight: '900', marginTop: 12 },
  price: { color: colors.primaryDark, fontSize: 30, fontWeight: '900', marginTop: 7 },
  unit: { color: colors.muted, fontSize: 12 },
  creditLine: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 15, paddingTop: 13, borderTopWidth: 1, borderTopColor: colors.line },
  creditLabel: { color: colors.muted, fontSize: 10 },
  credit: { color: colors.ink, fontSize: 11, fontWeight: '900' },
  inventoryCard: { flexDirection: 'row', alignItems: 'center', padding: 15, marginTop: 10, borderRadius: 12, backgroundColor: colors.surface },
  inventoryItem: { flex: 1, alignItems: 'center' },
  inventoryLabel: { color: colors.muted, fontSize: 9 },
  inventoryValue: { color: colors.ink, fontSize: 14, fontWeight: '900', marginTop: 5 },
  inventoryStrong: { color: colors.primary },
  inventoryDivider: { width: 1, height: 33, backgroundColor: colors.line },
  fact: { flexDirection: 'row', gap: 11, padding: 14, marginTop: 10, borderRadius: 12, backgroundColor: colors.surface },
  factIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft },
  factCopy: { flex: 1 },
  factTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  factBody: { color: colors.muted, fontSize: 10, lineHeight: 17, marginTop: 4 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 14, marginTop: 13, borderRadius: 18, backgroundColor: '#FFF8E7' },
  noticeText: { flex: 1, color: colors.muted, fontSize: 10, lineHeight: 17 },
  blocked: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 14, marginTop: 10, borderRadius: 12, backgroundColor: '#FFF8E7' },
  footer: { minHeight: 72, paddingHorizontal: 17, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface }, footerLabel: { color: colors.muted, fontSize: 9 }, footerPrice: { color: colors.ink, fontSize: 16, fontWeight: '900', marginTop: 4 }, buy: { minHeight: 46, paddingHorizontal: 18, borderRadius: 8, flexDirection: 'row', gap: 7, alignItems: 'center', backgroundColor: colors.primary }, buyDisabled: { opacity: 0.5 }, buyText: { color: colors.surface, fontSize: 12, fontWeight: '900' },
});
