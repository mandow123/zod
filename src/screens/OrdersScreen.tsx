import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { loadCloudPayOrders, type AftercareReview, type CloudPayOrder, type CloudPaySnapshot } from '../api';
import { Card } from '../components';
import { OrderCard } from '../OrderCard';
import { StagingOrdersSlot } from '../StagingOrdersSlot';
import { colors } from '../theme';

export function OrdersScreen({ snapshot, side, refreshing, onRefresh, onMarket, onLogin, onOpenOrder, onOpenStagingOrder, onOpenReview }: Readonly<{
  snapshot: CloudPaySnapshot;
  side: 'buyer' | 'provider';
  refreshing: boolean;
  onRefresh: () => void;
  onMarket: () => void;
  onLogin: () => void;
  onOpenOrder: (order: CloudPayOrder) => void;
  onOpenStagingOrder: (order: CloudPayOrder) => void;
  onOpenReview: (review: AftercareReview) => void;
}>) {
  const [orders, setOrders] = useState<CloudPayOrder[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  useEffect(() => {
    setOrders(snapshot.orders.filter((order) => order.side === side));
    setCursor(snapshot.orderCursors[side]);
    setMoreError(null);
  }, [side, snapshot.currentSubjectId, snapshot.orderCursors, snapshot.orders]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true); setMoreError(null);
    try {
      const page = await loadCloudPayOrders(side, cursor);
      setOrders((current) => {
        const known = new Set(current.map((order) => order.id));
        return [...current, ...page.orders.filter((order) => !known.has(order.id))];
      });
      setCursor(page.nextCursor);
    } catch (reason) {
      setMoreError(reason instanceof Error ? reason.message : '更多订单暂时无法读取。');
    } finally { setLoadingMore(false); }
  };

  const title = side === 'provider' ? '提供订单' : '购买订单';
  const emptyTitle = side === 'provider' ? '还没有提供订单' : '还没有购买订单';
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
        <Text style={styles.eyebrow}>算力订单</Text>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.caption}>{side === 'provider' ? '资源锁定、自动开通、验收和结算都在这里查看。' : '购买、使用、验收和售后都在这里查看。'}</Text>
        {side === 'buyer' ? <StagingOrdersSlot onOpenOrder={onOpenStagingOrder} /> : null}
        {snapshot.authenticated && snapshot.orderErrors[side] && orders.length === 0 ? (
          <Card style={styles.emptyCard}>
            <View style={[styles.icon, styles.warningIcon]}><Ionicons name="cloud-offline-outline" size={35} color={colors.amber} /></View>
            <Text style={styles.emptyTitle}>订单暂时没能同步</Text>
            <Text style={styles.emptyText}>已经保存的订单不会丢失，请重新读取。</Text>
            <Pressable onPress={onRefresh} style={styles.action}><Text style={styles.actionText}>重新读取</Text><Ionicons name="refresh" size={17} color={colors.surface} /></Pressable>
          </Card>
        ) : snapshot.authenticated && (orders.length > 0 || (side === 'buyer' && snapshot.aftercareReviews.length > 0)) ? (
          <View>
            {side === 'buyer' && snapshot.aftercareReviews.length > 0 ? <><Text style={styles.sectionTitle}>待处理售后</Text>{snapshot.aftercareReviews.map((review) => (
              <Pressable key={review.refundId} onPress={() => onOpenReview(review)} style={styles.reviewCard}>
                <View style={styles.reviewIcon}><Ionicons name="shield-checkmark-outline" size={22} color={colors.amber} /></View>
                <View style={styles.reviewCopy}><Text style={styles.reviewTitle}>{review.order.title}</Text><Text style={styles.reviewMeta}>{review.order.orderNumber} · {review.escalatedBySide === 'provider' ? '提供方提出异议' : '买方超时升级'}</Text></View>
                <Ionicons name="chevron-forward" size={17} color={colors.primary} />
              </Pressable>
            ))}</> : null}
            {orders.length > 0 ? <Text style={styles.sectionTitle}>全部{title}</Text> : null}
            {orders.map((order) => <OrderCard key={order.id} order={order} onPress={() => onOpenOrder(order)} />)}
            {moreError ? <Text style={styles.moreError}>{moreError}</Text> : null}
            {cursor ? <Pressable disabled={loadingMore} onPress={() => void loadMore()} style={styles.moreButton}>{loadingMore ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.moreText}>加载更多订单</Text>}</Pressable> : orders.length > 0 ? <Text style={styles.endText}>已显示全部订单</Text> : null}
          </View>
        ) : <Card style={styles.emptyCard}>
          <View style={styles.icon}><Ionicons name={snapshot.authenticated ? 'receipt-outline' : 'lock-closed-outline'} size={35} color={colors.primary} /></View>
          <Text style={styles.emptyTitle}>{snapshot.authenticated ? emptyTitle : '登录后查看你的订单'}</Text>
          <Text style={styles.emptyText}>{snapshot.authenticated ? (side === 'provider' ? '买方下单后，订单会显示在这里。' : '购买算力后，订单会显示在这里。') : '同一账号会保留订单、交付和退款进度。'}</Text>
          <Pressable onPress={snapshot.authenticated ? onMarket : onLogin} style={styles.action}>
            <Text style={styles.actionText}>{snapshot.authenticated ? (side === 'provider' ? '返回工作台' : '去逛市场') : '安全登录'}</Text>
            <Ionicons name="arrow-forward" size={17} color={colors.surface} />
          </Pressable>
        </Card>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: 18, paddingBottom: 38 },
  eyebrow: { color: colors.primary, fontSize: 10, fontWeight: '900', letterSpacing: 1.7, marginTop: 10 },
  title: { color: colors.ink, fontSize: 30, fontWeight: '900', letterSpacing: -0.8, marginTop: 8 },
  caption: { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 8, marginBottom: 24 },
  emptyCard: { padding: 24, alignItems: 'center' },
  icon: { width: 72, height: 72, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft },
  warningIcon: { backgroundColor: colors.amberSoft },
  emptyTitle: { color: colors.ink, fontSize: 19, fontWeight: '900', marginTop: 17 },
  emptyText: { color: colors.muted, fontSize: 12, lineHeight: 19, textAlign: 'center', marginTop: 7 },
  action: { minHeight: 48, marginTop: 18, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 16, backgroundColor: colors.primary },
  actionText: { color: colors.surface, fontSize: 14, fontWeight: '900' },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: '900', marginTop: 4, marginBottom: 11 },
  reviewCard: { minHeight: 76, marginBottom: 16, padding: 13, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.line, borderRadius: 19, backgroundColor: colors.surface },
  reviewIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.amberSoft },
  reviewCopy: { flex: 1, marginLeft: 11 }, reviewTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, reviewMeta: { color: colors.muted, fontSize: 9, marginTop: 5 },
  moreButton: { minHeight: 50, marginTop: 5, borderWidth: 1, borderColor: colors.primary, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  moreText: { color: colors.primary, fontSize: 13, fontWeight: '900' }, moreError: { color: colors.red, fontSize: 11, lineHeight: 18, textAlign: 'center', marginVertical: 10 },
  endText: { color: colors.subtle, fontSize: 10, textAlign: 'center', marginTop: 11 },
});
