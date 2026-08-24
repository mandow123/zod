import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  loadCloudPayMarketCandles, type CloudPayMarketCandle, type CloudPayMarketInterval,
  type CloudPayMarketPayload,
} from './cloudpay-market-candles';
import { colors } from './theme';

const intervalLabels: Readonly<Record<CloudPayMarketInterval, string>> = {
  '5m': '5分', '15m': '15分', '1h': '1时', '4h': '4时', '1d': '日线', '1w': '周线', '1mo': '月线',
};
const visibleIntervals: readonly CloudPayMarketInterval[] = ['1h', '4h', '1d', '1w', '1mo'];
const CHART_HEIGHT = 156;

function formatPrice(value: number) {
  return value >= 1000 ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
    : value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function MarketCandle({ candle, min, range }: Readonly<{ candle: CloudPayMarketCandle; min: number; range: number }>) {
  const rising = candle.close >= candle.open;
  const color = rising ? '#16A36A' : '#E5484D';
  const y = (value: number) => Math.max(0, Math.min(CHART_HEIGHT, ((maxValue - value) / range) * CHART_HEIGHT));
  const maxValue = min + range;
  const wickTop = y(candle.high);
  const wickBottom = y(candle.low);
  const bodyTop = y(Math.max(candle.open, candle.close));
  const bodyBottom = y(Math.min(candle.open, candle.close));
  return <View style={styles.candleSlot}>
    <View style={[styles.wick, { backgroundColor: color, top: wickTop, height: Math.max(1, wickBottom - wickTop) }]} />
    <View style={[styles.candleBody, { backgroundColor: color, top: bodyTop, height: Math.max(2, bodyBottom - bodyTop) }]} />
  </View>;
}

function KlineChart({ candles }: Readonly<{ candles: readonly CloudPayMarketCandle[] }>) {
  const visible = candles.slice(-36);
  const low = Math.min(...visible.map((item) => item.low));
  const high = Math.max(...visible.map((item) => item.high));
  const padding = Math.max((high - low) * 0.08, Math.max(high, 1) * 0.002);
  const min = Math.max(0, low - padding);
  const range = Math.max(0.0001, high + padding - min);
  return <View style={styles.chartFrame}>
    {[0, 1, 2, 3].map((line) => <View key={line} style={[styles.gridLine, { top: (CHART_HEIGHT / 3) * line }]} />)}
    <View style={styles.candles}>{visible.map((item) => <MarketCandle key={item.time} candle={item} min={min} range={range} />)}</View>
    <View style={styles.priceScale}><Text style={styles.scaleText}>{formatPrice(high)}</Text><Text style={styles.scaleText}>{formatPrice(low)}</Text></View>
  </View>;
}

export function CloudPayKlinePanel({ refreshToken = 0 }: Readonly<{ refreshToken?: number }>) {
  const [payload, setPayload] = useState<CloudPayMarketPayload | null>(null);
  const [interval, setInterval] = useState<CloudPayMarketInterval>('1d');
  const [product, setProduct] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    void loadCloudPayMarketCandles({ kind: 'gpu', interval, product, region: 'shanghai', signal: controller.signal })
      .then((next) => { setPayload(next); if (!product) setProduct(next.product.id); })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'CloudPay 行情暂时无法读取。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [interval, product, refreshToken, retryToken]);

  const change = useMemo(() => {
    if (!payload?.candles.length) return null;
    const first = payload.candles[0]; const last = payload.candles[payload.candles.length - 1];
    return { last, amount: last.close - first.open, percent: first.open ? ((last.close - first.open) / first.open) * 100 : 0 };
  }, [payload]);
  const products = payload?.options.products.gpu ?? [];

  return <View style={styles.panel}>
    <View style={styles.header}><View style={styles.headerCopy}><View style={styles.liveRow}><View style={styles.liveDot} /><Text style={styles.liveText}>CloudPay 同源行情</Text></View><Text style={styles.title}>{payload?.product.name ?? 'GPU 报价参考盘'}</Text><Text style={styles.meta}>{payload ? `${payload.region.name} · ${payload.product.unit}` : '正在连接 cloudpay.kai.com'}</Text></View>
      {change ? <View style={styles.latest}><Text style={styles.latestPrice}>{formatPrice(change.last.close)}</Text><Text style={[styles.change, { color: change.amount >= 0 ? '#168A5B' : colors.red }]}>{change.amount >= 0 ? '+' : ''}{change.percent.toFixed(2)}%</Text></View> : null}</View>

    {products.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.productTabs}>{products.map((item) => <Pressable key={item.id} onPress={() => setProduct(item.id)} style={[styles.productTab, product === item.id && styles.productTabActive]}><Text style={[styles.productText, product === item.id && styles.productTextActive]}>{item.name.replace('NVIDIA ', '')}</Text></Pressable>)}</ScrollView> : null}
    <View style={styles.intervalTabs}>{visibleIntervals.map((item) => <Pressable key={item} disabled={loading} onPress={() => setInterval(item)} style={[styles.intervalTab, interval === item && styles.intervalTabActive]}><Text style={[styles.intervalText, interval === item && styles.intervalTextActive]}>{intervalLabels[item]}</Text></Pressable>)}</View>

    {loading && !payload ? <View style={styles.state}><ActivityIndicator color={colors.primary} /><Text style={styles.stateText}>正在读取真实报价流…</Text></View> : null}
    {error && !payload ? <View style={styles.state}><Ionicons name="cloud-offline-outline" size={24} color={colors.primary} /><Text style={styles.stateTitle}>K 线暂时无法读取</Text><Text style={styles.stateText}>{error}</Text><Pressable onPress={() => setRetryToken((value) => value + 1)} style={styles.retry}><Text style={styles.retryText}>重新加载</Text></Pressable></View> : null}
    {payload ? <><KlineChart candles={payload.candles} />
      {change ? <View style={styles.ohlc}><View><Text style={styles.factLabel}>开</Text><Text style={styles.factValue}>{formatPrice(change.last.open)}</Text></View><View><Text style={styles.factLabel}>高</Text><Text style={styles.factValue}>{formatPrice(change.last.high)}</Text></View><View><Text style={styles.factLabel}>低</Text><Text style={styles.factValue}>{formatPrice(change.last.low)}</Text></View><View><Text style={styles.factLabel}>收</Text><Text style={styles.factValue}>{formatPrice(change.last.close)}</Text></View></View> : null}
      <View style={styles.sourceRow}><Text style={styles.source}>数据源 {payload.source} · 更新 {formatUpdatedAt(payload.updatedAt)}</Text>{loading ? <ActivityIndicator size="small" color={colors.primary} /> : null}</View>
      {error ? <Text style={styles.stale}>更新失败，当前保留上次已确认数据：{error}</Text> : null}
      <Text style={styles.notice}>{payload.notice}</Text>
    </> : null}
  </View>;
}

const styles = StyleSheet.create({
  panel: { padding: 14, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: '#CFE0F8' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }, headerCopy: { flex: 1 },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 5 }, liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#16A36A' }, liveText: { color: colors.primary, fontSize: 8, fontWeight: '900' },
  title: { color: colors.ink, fontSize: 17, fontWeight: '900', marginTop: 4 }, meta: { color: colors.muted, fontSize: 8, marginTop: 3 }, latest: { alignItems: 'flex-end' }, latestPrice: { color: colors.ink, fontSize: 18, fontWeight: '900' }, change: { fontSize: 9, fontWeight: '900', marginTop: 2 },
  productTabs: { gap: 6, paddingTop: 13, paddingBottom: 9 }, productTab: { paddingHorizontal: 9, minHeight: 28, justifyContent: 'center', borderRadius: 7, backgroundColor: colors.canvas }, productTabActive: { backgroundColor: colors.primarySoft }, productText: { color: colors.muted, fontSize: 8, fontWeight: '800' }, productTextActive: { color: colors.primary },
  intervalTabs: { flexDirection: 'row', marginBottom: 10, padding: 3, borderRadius: 8, backgroundColor: colors.canvas }, intervalTab: { flex: 1, minHeight: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 6 }, intervalTabActive: { backgroundColor: colors.surface }, intervalText: { color: colors.muted, fontSize: 8, fontWeight: '800' }, intervalTextActive: { color: colors.primary },
  chartFrame: { height: CHART_HEIGHT, overflow: 'hidden', borderRadius: 8, backgroundColor: '#FBFCFE' }, gridLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: '#EDF0F4' }, candles: { flex: 1, flexDirection: 'row', paddingRight: 44 }, candleSlot: { flex: 1, height: CHART_HEIGHT, position: 'relative', alignItems: 'center' }, wick: { position: 'absolute', width: 1 }, candleBody: { position: 'absolute', width: '60%', minWidth: 2, maxWidth: 7, borderRadius: 1 }, priceScale: { position: 'absolute', right: 4, top: 4, bottom: 4, justifyContent: 'space-between', alignItems: 'flex-end' }, scaleText: { color: colors.subtle, fontSize: 7 },
  ohlc: { flexDirection: 'row', justifyContent: 'space-between', padding: 10, marginTop: 9, borderRadius: 8, backgroundColor: colors.canvas }, factLabel: { color: colors.muted, fontSize: 7 }, factValue: { color: colors.ink, fontSize: 9, fontWeight: '900', marginTop: 2 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }, source: { flex: 1, color: colors.muted, fontSize: 7 }, notice: { color: colors.muted, fontSize: 8, lineHeight: 13, marginTop: 7 }, stale: { color: colors.red, fontSize: 8, lineHeight: 12, marginTop: 6 },
  state: { minHeight: 220, alignItems: 'center', justifyContent: 'center', padding: 18 }, stateTitle: { color: colors.ink, fontSize: 13, fontWeight: '900', marginTop: 8 }, stateText: { color: colors.muted, fontSize: 9, textAlign: 'center', lineHeight: 14, marginTop: 7 }, retry: { minHeight: 36, paddingHorizontal: 13, marginTop: 10, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: colors.primary }, retryText: { color: colors.surface, fontSize: 9, fontWeight: '900' },
});
