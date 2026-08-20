import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { CloudPayOrder } from './api';
import { Card } from './components';
import { OrderCard } from './OrderCard';
import { loadStagingPrincipalToken } from './staging-principal';
import { stagingOrderStatus } from './staging-presentation';
import { loadStagingOrders, type StagingOrder } from './staging-sandbox-api';
import { stagingOrderForOriginalScreen } from './staging-order-view';
import { colors } from './theme';

export function StagingOrdersSlot({ onOpenOrder }: Readonly<{
  onOpenOrder: (order: CloudPayOrder) => void;
}>) {
  const [orders, setOrders] = useState<StagingOrder[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    const principal = await loadStagingPrincipalToken();
    if (!principal) { setOrders(null); setError(false); return; }
    setLoading(true); setError(false);
    try { setOrders(await loadStagingOrders()); }
    catch { setOrders([]); setError(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (orders === null) return null;
  return <View style={styles.section}><View style={styles.heading}><View><Text style={styles.eyebrow}>TEST ENVIRONMENT</Text>
    <Text style={styles.title}>测试环境订单</Text></View>
    <Pressable disabled={loading} onPress={() => void load()} accessibilityLabel="重新读取测试环境订单">
      {loading ? <ActivityIndicator color={colors.primary} /> : <Ionicons name="refresh" size={19} color={colors.primary} />}
    </Pressable></View>
    {error ? <Card style={styles.message}><Text style={styles.messageTitle}>测试环境订单暂时无法读取</Text>
      <Text style={styles.messageText}>正式订单不受影响，请稍后重新读取。</Text></Card> : null}
    {!error && orders.length === 0 ? <Card style={styles.message}><Text style={styles.messageTitle}>还没有测试环境订单</Text></Card> : null}
    {orders.map((order) => <OrderCard key={order.id} order={stagingOrderForOriginalScreen(order)}
      statusLabel={stagingOrderStatus(order)} onPress={() => onOpenOrder(stagingOrderForOriginalScreen(order))} />)}
  </View>;
}

const styles = StyleSheet.create({
  section: { marginBottom: 18 }, heading: { marginBottom: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { color: colors.primary, fontSize: 8, fontWeight: '900', letterSpacing: 1.2 }, title: { color: colors.ink, fontSize: 17, fontWeight: '900', marginTop: 4 },
  message: { padding: 15, marginBottom: 11 }, messageTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  messageText: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 5 },
});
