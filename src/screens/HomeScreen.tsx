import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { CloudPaySnapshot } from '../api';
import { Card, SectionTitle, StatusPill, type TabKey } from '../components';
import { colors } from '../theme';
import { distributionPolicy } from '../distribution';
import { creditAmount } from '../format';

type Props = {
  snapshot: CloudPaySnapshot;
  refreshing: boolean;
  onRefresh: () => void;
  onNavigate: (tab: TabKey) => void;
  onOpenDemand: () => void;
  onOpenCredits: () => void;
};

const missions = [
  { title: '训练冲刺', caption: '按模型找集群', icon: 'rocket-outline' as const, tone: '#E8F3FF' },
  { title: '推理扩容', caption: '按峰值补容量', icon: 'pulse-outline' as const, tone: '#E8F7EE' },
  { title: '定向征集', caption: '发布算力需求', icon: 'megaphone-outline' as const, tone: '#FFF2D9' },
  { title: '机柜补位', caption: '寻找柜月资源', icon: 'server-outline' as const, tone: '#F0ECFF' },
];

function uniqueRegions(resources: CloudPaySnapshot['resources']) {
  const values = resources
    .map((item) => item.region)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  return new Set(values).size;
}

export function HomeScreen({ snapshot, refreshing, onRefresh, onNavigate, onOpenDemand, onOpenCredits }: Props) {
  const regionCount = uniqueRegions(snapshot.resources);
  const availableCredits = snapshot.creditBalance
    ? creditAmount(snapshot.creditBalance.available)
    : null;

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <LinearGradient colors={['#E8F2FF', '#F8FBFF']} style={styles.radarCard}>
          <View style={styles.radarGlow} />
          <View style={styles.radarRingOuter} />
          <View style={styles.radarRingInner} />
          <View style={styles.radarSweep} />
          <View style={styles.radarPointOne} />
          <View style={styles.radarPointTwo} />

          <View style={styles.radarTop}>
            <StatusPill online={snapshot.online} />
            <Text style={styles.radarTime}>
              {snapshot.updatedAt
                ? snapshot.updatedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
                : '同步中'}
            </Text>
          </View>
          <View style={styles.radarCopy}>
            <Text style={styles.radarEyebrow}>今日算力</Text>
            <Text style={styles.radarTitle}>{distributionPolicy.newOrders ? '发布需求，\n匹配可用算力。' : '查看资源，\n管理已有服务。'}</Text>
            <Text style={styles.radarCaption}>{distributionPolicy.newOrders ? '按模型、交付时间和地区匹配可用 GPU、Token 与柜月。' : '浏览平台已审核的 GPU、Token、存储与柜月资源。'}</Text>
          </View>
          <Pressable style={styles.radarAction} onPress={() => onNavigate('market')}>
            <Text style={styles.radarActionText}>{distributionPolicy.newOrders ? '开始一次匹配' : '浏览资源目录'}</Text>
            <Ionicons name="arrow-forward" size={18} color={colors.surface} />
          </Pressable>
        </LinearGradient>

        <Pressable
          style={styles.creditCard}
          onPress={onOpenCredits}
          accessibilityRole="button"
          accessibilityLabel="打开 KAI 卡时账户"
        >
          <View style={styles.creditIcon}><Ionicons name="wallet-outline" size={22} color={colors.primary} /></View>
          <View style={styles.creditCopy}>
            <Text style={styles.creditTitle}>KAI 卡时账户</Text>
            <Text style={styles.creditCaption}>先充值卡时再购买算力</Text>
          </View>
          <View style={styles.creditBalance}>
            <Text style={styles.creditBalanceLabel}>{availableCredits === null ? (snapshot.authenticated ? '余额暂未更新' : '登录后查看') : '可用卡时'}</Text>
            {availableCredits !== null ? <Text style={styles.creditBalanceValue}>{availableCredits}</Text> : null}
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.primary} />
        </Pressable>

        <Card style={styles.pulseCard}>
          <View style={styles.pulseHeader}>
            <View>
              <Text style={styles.pulseTitle}>市场概况</Text>
              <Text style={styles.pulseCaption}>资源与挂牌实时更新</Text>
            </View>
            <Ionicons name="radio-outline" size={24} color={colors.primary} />
          </View>
          <View style={styles.metrics}>
            <View style={styles.metric}>
              <Text style={styles.metricValue}>{snapshot.online ? snapshot.resources.length : '—'}</Text>
              <Text style={styles.metricLabel}>资源档案</Text>
            </View>
            <View style={styles.metricDivider} />
            <View style={styles.metric}>
              <Text style={styles.metricValue}>{snapshot.online ? regionCount : '—'}</Text>
              <Text style={styles.metricLabel}>交付地区</Text>
            </View>
            <View style={styles.metricDivider} />
            <View style={styles.metric}>
              <Text style={styles.metricValue}>{snapshot.listingCatalogOnline ? snapshot.listings.length : '—'}</Text>
              <Text style={styles.metricLabel}>在售方案</Text>
            </View>
          </View>
          <View style={styles.noticeLine}>
            <Ionicons name="shield-checkmark-outline" size={17} color={colors.primary} />
            <Text style={styles.noticeText}>{snapshot.priceNotice}</Text>
          </View>
        </Card>

        <SectionTitle title="你要用算力做什么" caption="选择任务，直接查看适合的资源。" />
        <View style={styles.missionGrid}>
          {missions.map((mission, index) => (
            <Pressable
              key={mission.title}
              style={styles.missionCard}
              onPress={() => index < 2 || !distributionPolicy.newOrders ? onNavigate('market') : index === 2 ? onOpenDemand() : onNavigate('market')}
            >
              <View style={[styles.missionIcon, { backgroundColor: mission.tone }]}>
                <Ionicons name={mission.icon} size={24} color={colors.primaryDark} />
              </View>
              <Text style={styles.missionTitle}>{mission.title}</Text>
              <Text style={styles.missionCaption}>{mission.caption}</Text>
              <Ionicons name="arrow-forward-outline" size={17} color={colors.subtle} style={styles.missionArrow} />
            </Pressable>
          ))}
        </View>

        <SectionTitle title="购买后怎么交付" caption="订单中的三个关键步骤。" action="查看消息" onAction={() => onNavigate('messages')} />
        <Card style={styles.timelineCard}>
          {[
            ['描述任务', '模型、时段与地区'],
            ['锁定容量', '报价与库存快照'],
            ['交付验收', '状态与凭证可追溯'],
          ].map(([title, caption], index) => (
            <View key={title} style={styles.timelineRow}>
              <View style={styles.timelineRail}>
                <View style={[styles.timelineDot, index === 0 && styles.timelineDotActive]} />
                {index < 2 ? <View style={styles.timelineLine} /> : null}
              </View>
              <View style={styles.timelineCopy}>
                <Text style={styles.timelineIndex}>0{index + 1}</Text>
                <Text style={styles.timelineTitle}>{title}</Text>
                <Text style={styles.timelineCaption}>{caption}</Text>
              </View>
            </View>
          ))}
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: 16, paddingBottom: 30, gap: 22 },
  radarCard: { minHeight: 318, borderRadius: 28, padding: 22, borderWidth: 1, borderColor: '#D5E5FA', overflow: 'hidden', justifyContent: 'space-between' },
  radarGlow: { position: 'absolute', right: -90, top: -70, width: 280, height: 280, borderRadius: 140, backgroundColor: 'rgba(23,105,224,0.05)' },
  radarRingOuter: { position: 'absolute', right: -32, top: 34, width: 230, height: 230, borderRadius: 115, borderWidth: 1, borderColor: 'rgba(23,105,224,0.12)' },
  radarRingInner: { position: 'absolute', right: 22, top: 88, width: 122, height: 122, borderRadius: 61, borderWidth: 1, borderColor: 'rgba(23,105,224,0.14)' },
  radarSweep: { position: 'absolute', right: 74, top: 86, width: 2, height: 96, backgroundColor: 'rgba(74,140,242,0.34)', transform: [{ rotate: '36deg' }] },
  radarPointOne: { position: 'absolute', right: 86, top: 115, width: 10, height: 10, borderRadius: 5, backgroundColor: '#4A8CF2' },
  radarPointTwo: { position: 'absolute', right: 34, top: 204, width: 7, height: 7, borderRadius: 4, backgroundColor: '#AFC9EC' },
  radarTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', zIndex: 2 },
  radarTime: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  radarCopy: { maxWidth: '88%', zIndex: 2, marginTop: 32 },
  radarEyebrow: { color: colors.primary, fontSize: 13, fontWeight: '800', letterSpacing: 1.2, marginBottom: 9 },
  radarTitle: { color: colors.ink, fontSize: 28, lineHeight: 37, fontWeight: '900', letterSpacing: -0.7 },
  radarCaption: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 10 },
  radarAction: { zIndex: 2, alignSelf: 'flex-start', minHeight: 48, borderRadius: 15, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.primary },
  radarActionText: { color: colors.surface, fontSize: 15, fontWeight: '800' },
  creditCard: { minHeight: 84, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 22, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  creditIcon: { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft },
  creditCopy: { flex: 1 },
  creditTitle: { color: colors.ink, fontSize: 16, fontWeight: '900' },
  creditCaption: { color: colors.muted, fontSize: 11, marginTop: 4 },
  creditBalance: { alignItems: 'flex-end' },
  creditBalanceLabel: { color: colors.muted, fontSize: 9 },
  creditBalanceValue: { color: colors.primaryDark, fontSize: 18, fontWeight: '900', marginTop: 2 },
  pulseCard: { padding: 18, gap: 16 },
  pulseHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pulseTitle: { color: colors.ink, fontSize: 19, fontWeight: '800' },
  pulseCaption: { color: colors.muted, fontSize: 12, marginTop: 3 },
  metrics: { flexDirection: 'row', alignItems: 'center' },
  metric: { flex: 1 },
  metricValue: { color: colors.ink, fontSize: 24, fontWeight: '900' },
  metricLabel: { color: colors.muted, fontSize: 11, marginTop: 4 },
  metricDivider: { width: 1, height: 46, backgroundColor: colors.line, marginHorizontal: 10 },
  noticeLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, borderRadius: 14, backgroundColor: colors.primarySoft },
  noticeText: { flex: 1, color: colors.primaryDark, fontSize: 12, lineHeight: 18 },
  missionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  missionCard: { width: '48%', minHeight: 156, padding: 15, borderRadius: 22, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  missionIcon: { width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginBottom: 13 },
  missionTitle: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  missionCaption: { color: colors.muted, fontSize: 12, marginTop: 4 },
  missionArrow: { position: 'absolute', right: 14, bottom: 14 },
  timelineCard: { paddingHorizontal: 17, paddingVertical: 6 },
  timelineRow: { minHeight: 82, flexDirection: 'row', alignItems: 'center' },
  timelineRail: { width: 24, height: '100%', alignItems: 'center' },
  timelineDot: { width: 10, height: 10, borderRadius: 5, marginTop: 26, backgroundColor: '#C9D4CD', zIndex: 2 },
  timelineDotActive: { width: 13, height: 13, borderRadius: 7, backgroundColor: colors.primary },
  timelineLine: { position: 'absolute', top: 34, bottom: -28, width: 1, backgroundColor: colors.line },
  timelineCopy: { flex: 1, paddingLeft: 10 },
  timelineIndex: { color: colors.primary, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  timelineTitle: { color: colors.ink, fontSize: 16, fontWeight: '800', marginTop: 2 },
  timelineCaption: { color: colors.muted, fontSize: 12, marginTop: 2 },
});
