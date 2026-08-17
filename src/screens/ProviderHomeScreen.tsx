import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CloudPaySnapshot } from '../api';
import { creditAmount } from '../format';
import { colors } from '../theme';

type Props = Readonly<{
  snapshot: CloudPaySnapshot;
  refreshing: boolean;
  onRefresh: () => void;
  onLogin: () => void;
  onNext: (route: string, entityId: string | null) => void;
  onOpenPublish: () => void;
  onOpenAssets: () => void;
}>;

export function ProviderHomeScreen({ snapshot, refreshing, onRefresh, onLogin, onNext, onOpenPublish, onOpenAssets }: Props) {
  const workspace = snapshot.providerWorkspace;
  const abnormal = workspace ? workspace.resources.rejected + workspace.resources.suspended + workspace.listings.paused + workspace.listings.scheduledPaused : 0;
  const expiry = workspace?.offers.expired ?? 0;

  return <View style={styles.root}><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}
    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
    <LinearGradient colors={['#EAF8F8', '#F0EEFF', '#FFFFFF']} style={styles.hero}>
      <Text style={styles.eyebrow}>提供算力</Text>
      <Text style={styles.heroTitle}>{workspace?.subject.displayName ?? '资源工作台'}</Text>
      <Text style={styles.heroText}>设备、订单和结算都在这里。</Text>
    </LinearGradient>

    {!snapshot.authenticated ? <View style={styles.loginCard}><Text style={styles.loginTitle}>登录后管理供给</Text><Text style={styles.loginText}>使用算力和提供算力共用同一账号。</Text><Pressable onPress={onLogin} style={styles.primary}><Text style={styles.primaryText}>登录 Zod</Text></Pressable></View> : !workspace ? <View style={styles.loginCard}><Text style={styles.loginTitle}>供给进度暂未载入</Text><Text style={styles.loginText}>{snapshot.providerWorkspaceError ?? '下拉重新读取。'}</Text></View> : <>
      <Pressable onPress={() => onNext(workspace.nextAction.route, workspace.nextAction.entityId)} style={styles.todo}>
        <View style={styles.todoIcon}><Ionicons name="notifications-outline" size={20} color={colors.ink} /></View>
        <View style={styles.todoCopy}><Text style={styles.todoLabel}>当前待办</Text><Text style={styles.todoTitle}>{workspace.nextAction.label}</Text></View>
        <Ionicons name="arrow-forward" size={17} color={colors.primary} />
      </Pressable>

      <View style={styles.metrics}>
        <Metric value={String(workspace.listings.selling)} label="运行" />
        <Metric value={String(abnormal)} label="异常" warn={abnormal > 0} />
        <Metric value={String(expiry)} label="到期" warn={expiry > 0} />
      </View>

      <View style={styles.earnings}>
        <View><Text style={styles.earningsLabel}>待结算</Text><Text style={styles.earningsValue}>{snapshot.creditBalance ? creditAmount(snapshot.creditBalance.supplierReceivable) : '—'} <Text style={styles.earningsUnit}>KAI 卡时</Text></Text></View>
        <Pressable onPress={onOpenAssets}><Text style={styles.textAction}>查看资产</Text></Pressable>
      </View>

      <Text style={styles.sectionTitle}>供给操作</Text>
      <Pressable onPress={onOpenPublish} style={styles.primary}><Ionicons name="storefront-outline" size={18} color={colors.surface} /><Text style={styles.primaryText}>上架资源</Text></Pressable>
      <Pressable onPress={onOpenAssets} style={styles.secondaryEntry}><View><Text style={styles.secondaryTitle}>添加与管理设备</Text><Text style={styles.secondaryText}>在我的资产中查看节点、部署和运营状态</Text></View><Ionicons name="chevron-forward" size={17} color={colors.muted} /></Pressable>
    </>}
  </ScrollView></View>;
}

function Metric({ value, label, warn = false }: Readonly<{ value: string; label: string; warn?: boolean }>) { return <View style={styles.metric}><Text style={[styles.metricValue, warn && styles.warn]}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></View>; }

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 16, paddingBottom: 32 },
  hero: { minHeight: 154, padding: 18, borderRadius: 12, borderWidth: 1, borderColor: '#E5E7EB' }, eyebrow: { color: colors.muted, fontSize: 10, fontWeight: '800' }, heroTitle: { color: colors.ink, fontSize: 25, fontWeight: '900', marginTop: 15 }, heroText: { color: colors.muted, fontSize: 11, lineHeight: 18, marginTop: 8, maxWidth: '86%' },
  todo: { minHeight: 72, marginTop: 12, paddingHorizontal: 13, borderRadius: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, todoIcon: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F3F5' }, todoCopy: { flex: 1, marginLeft: 11 }, todoLabel: { color: colors.muted, fontSize: 9 }, todoTitle: { color: colors.ink, fontSize: 13, fontWeight: '900', marginTop: 4 },
  metrics: { flexDirection: 'row', marginTop: 12, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, metric: { flex: 1, minHeight: 78, alignItems: 'center', justifyContent: 'center' }, metricValue: { color: colors.ink, fontSize: 22, fontWeight: '900' }, metricLabel: { color: colors.muted, fontSize: 10, marginTop: 6 }, warn: { color: colors.red },
  earnings: { minHeight: 80, marginTop: 12, paddingHorizontal: 14, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#F0F8F7' }, earningsLabel: { color: colors.muted, fontSize: 9 }, earningsValue: { color: colors.ink, fontSize: 21, fontWeight: '900', marginTop: 5 }, earningsUnit: { color: colors.muted, fontSize: 9 }, textAction: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '900', marginTop: 20, marginBottom: 10 }, primary: { minHeight: 48, borderRadius: 8, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 13, fontWeight: '900' }, secondaryEntry: { minHeight: 68, marginTop: 9, paddingHorizontal: 13, borderRadius: 12, borderWidth: 1, borderColor: colors.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface }, secondaryTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, secondaryText: { color: colors.muted, fontSize: 9, marginTop: 5 },
  loginCard: { marginTop: 12, padding: 20, alignItems: 'center', borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }, loginTitle: { color: colors.ink, fontSize: 17, fontWeight: '900' }, loginText: { color: colors.muted, fontSize: 11, textAlign: 'center', lineHeight: 18, marginVertical: 8 },
});
