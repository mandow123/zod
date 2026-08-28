import { Ionicons } from '@expo/vector-icons';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CloudPayOrder, CloudPaySnapshot, DeviceOrder } from '../api';
import { TopVideoHero, topVideoColors } from '../components/TopVideoHero';
import { creditAmount } from '../format';
import { Card } from '../components';
import { OrderCard } from '../OrderCard';
import {
  providerOrderNeedsAttention, providerOrderSection, providerWorkspaceMetrics, providerWorkspaceRoadmap,
} from '../provider-workspace-metrics';
import { colors, ledgerActionButton, ledgerActionText } from '../theme';

export function ProviderWorkspaceScreen({ snapshot, refreshing, onRefresh, onNext, onLogin, onOpenOrder, onOpenDeviceOrder, onAllOrders }: Readonly<{
  snapshot: CloudPaySnapshot;
  refreshing: boolean;
  onRefresh: () => void;
  onNext: (route: string, entityId: string | null) => void;
  onLogin: () => void;
  onOpenOrder: (order: CloudPayOrder) => void;
  onOpenDeviceOrder: (order: DeviceOrder) => void;
  onAllOrders: () => void;
}>) {
  const workspace = snapshot.providerWorkspace;
  const metrics = workspace ? providerWorkspaceMetrics(workspace) : { resourceTotal: 0, awaitingReview: 0, needsAction: 0 };
  const providerOrders = snapshot.orders.filter((order) => order.side === 'provider');
  const orderSection = providerOrderSection(providerOrders);
  const totalNeedsAction = metrics.needsAction + orderSection.actionable;
  const orderPreview = [...providerOrders]
    .sort((left, right) => Number(providerOrderNeedsAttention(right)) - Number(providerOrderNeedsAttention(left))
      || Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, 3);
  const staleWorkspace = Boolean(snapshot.providerWorkspaceError || snapshot.providerWorkspaceCachedAt);
  const deviceOrders = snapshot.deviceOrders.filter((order) => order.side !== 'buyer');

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={topVideoColors.primary} />}
      >
        <TopVideoHero eyebrow="提供算力" title="把可用算力带上市场" detail="登录后查看上架审核、资源节点与交付状态。" />
        {!snapshot.authenticated ? (
          <Card style={styles.loginCard}>
            <View style={styles.loginIcon}><Ionicons name="server-outline" size={35} color={colors.primary} /></View>
            <Text style={styles.loginTitle}>登录后上架算力</Text>
            <Text style={styles.loginText}>购买和上架共用同一账号。</Text>
            <Pressable onPress={onLogin} style={styles.primary}><Text style={styles.primaryText}>登录</Text></Pressable>
          </Card>
        ) : !workspace ? (
          <Card style={styles.loginCard}>
            <Ionicons name="cloud-offline-outline" size={35} color={colors.amber} />
            <Text style={styles.loginTitle}>上架数据没能载入</Text>
            <Text style={styles.loginText}>{snapshot.error ?? '资源和审核记录都在，重新获取即可。'}</Text>
            <Pressable onPress={onRefresh} style={styles.primary}><Text style={styles.primaryText}>重新获取</Text></Pressable>
          </Card>
        ) : (
          <>
            {snapshot.providerWorkspaceError || snapshot.providerWorkspaceCachedAt ? <Card style={styles.syncNotice}>
              <Ionicons name="cloud-offline-outline" size={19} color={colors.amber} />
              <View style={styles.syncNoticeCopy}>
                <Text style={styles.syncNoticeTitle}>{snapshot.providerWorkspaceError ? '本次同步未完成' : '正在同步最新状态'}</Text>
                <Text style={styles.syncNoticeText}>当前显示{cachedTime(snapshot.providerWorkspaceCachedAt)}保存的上架状态。</Text>
              </View>
            </Card> : null}
            <Card style={styles.workspaceCard}>
              <View style={styles.heroTop}>
                <View style={styles.modePill}><View style={styles.modeDot} /><Text style={styles.modeText}>提供工作台</Text></View>
                <Text style={styles.subjectRole}>{roleLabel[workspace.subject.role]}</Text>
              </View>
              <Text style={styles.heroEyebrow}>下一步</Text>
              <Text style={styles.heroTitle}>{workspace.nextAction.label}</Text>
              <Text style={styles.heroCaption}>{workspace.resume
                ? resumeCaption(workspace.resume.status, workspace.resume.title)
                : nextActionCaption(workspace.nextAction.key)}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={staleWorkspace ? '同步最新上架状态' : workspace.nextAction.label}
                onPress={() => staleWorkspace ? onRefresh() : onNext(workspace.nextAction.route, workspace.nextAction.entityId)}
                style={[styles.heroAction, staleWorkspace && styles.heroActionStale]}>
                <Text style={styles.heroActionText}>{staleWorkspace ? '同步后继续' : workspace.nextAction.label}</Text>
                <Ionicons name={staleWorkspace ? 'refresh' : 'arrow-forward'} size={18} color={colors.surface} />
              </Pressable>
            </Card>

            <View style={styles.metrics}>
              <Card style={styles.metric}><Text style={styles.metricValue}>{metrics.resourceTotal}</Text><Text style={styles.metricLabel}>资源总数</Text></Card>
              <Card style={styles.metric}><Text style={[styles.metricValue, totalNeedsAction > 0 && styles.alertValue]}>{totalNeedsAction}</Text><Text style={styles.metricLabel}>需要处理</Text></Card>
              <Card style={styles.metric}><Text style={styles.metricValue}>{metrics.awaitingReview}</Text><Text style={styles.metricLabel}>审核进行中</Text></Card>
            </View>

            {providerOrders.length > 0 ? (
              <>
                <View style={styles.orderHeading}><Text style={styles.sectionTitle}>{orderSection.title}</Text><Text style={styles.orderCount}>{orderSection.count}</Text></View>
                {orderPreview.map((order) => <OrderCard key={order.id} order={order} onPress={() => onOpenOrder(order)} />)}
                <Pressable onPress={onAllOrders} style={styles.allOrders}><Text style={styles.allOrdersText}>查看全部提供订单</Text><Ionicons name="arrow-forward" size={16} color={colors.primary} /></Pressable>
              </>
            ) : null}
            {snapshot.orderErrors.provider ? <Card style={styles.orderError}><Ionicons name="cloud-offline-outline" size={20} color={colors.red} /><View style={styles.orderErrorCopy}><Text style={styles.orderErrorTitle}>订单暂时没能同步</Text><Text style={styles.orderErrorText}>下拉刷新，不影响已经保存的订单。</Text></View></Card> : null}

            {deviceOrders.length ? <><View style={styles.orderHeading}><Text style={styles.sectionTitle}>设备销售订单</Text><Text style={styles.orderCount}>{deviceOrders.length} 笔</Text></View>{deviceOrders.slice(0, 5).map((order) => <Pressable key={order.id} onPress={() => onOpenDeviceOrder(order)} style={styles.deviceOrder}><View style={styles.deviceOrderIcon}><Ionicons name="cube-outline" size={19} color={colors.ink} /></View><View style={styles.deviceOrderCopy}><Text style={styles.deviceOrderTitle}>{snapshot.deviceProducts.find((item) => item.id === order.productId)?.title ?? order.orderNumber}</Text><Text style={styles.deviceOrderMeta}>{order.quantity} 台 · {creditAmount(order.totalCredit)} 卡时</Text></View><Text style={styles.deviceOrderState}>{order.status === 'reserved' ? '待确认' : order.status === 'confirmed' ? '待发货' : order.status === 'shipping' ? '运输中' : order.status === 'received' ? '待结算' : '已结束'}</Text></Pressable>)}</> : null}

            <Text style={styles.sectionTitle}>上架流程</Text>
            <Card style={styles.roadmap}>
              {providerSteps(workspace).map((step, index, allSteps) => (
                <View key={step.label} style={styles.stepRow}>
                  <View style={styles.rail}>
                    <View style={[styles.stepDot, step.done && styles.stepDone, step.current && styles.stepCurrent]}>
                      {step.done ? <Ionicons name="checkmark" size={13} color={colors.surface} /> : null}
                    </View>
                    {index < allSteps.length - 1 ? <View style={[styles.stepLine, step.done && styles.stepLineDone]} /> : null}
                  </View>
                  <View style={styles.stepCopy}>
                    <Text style={[styles.stepTitle, step.current && styles.stepTitleCurrent]}>{step.label}</Text>
                    <Text style={styles.stepMeta}>{step.meta}</Text>
                  </View>
                  {step.current ? <View style={styles.currentPill}><Text style={styles.currentText}>当前</Text></View> : null}
                </View>
              ))}
            </Card>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function cachedTime(value: string | null) {
  if (!value) return '上次';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '上次';
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function nextActionCaption(key: string) {
  if (key.includes('onboarding')) return '提交主体资料，审核通过后即可添加资源。';
  if (key === 'connect_resource_node') return '为资料已核验的资源接入执行节点，完成在线与交付检查。';
  if (key === 'track_node_readiness') return '节点正在检查，可查看连接、库存和交付准备状态。';
  if (key === 'restore_resource_node') return '执行节点已离线，恢复连接并通过在线检查后才能继续上架。';
  if (key === 'reconnect_resource_node') return '重新接入执行节点，通过在线与交付检查后再创建上架方案。';
  if (key.includes('resource')) return '提交权属、配置和可用性材料。';
  if (key === 'create_offer') return '为资料已核验、节点可交付的资源填写服务和核价依据。';
  if (key === 'reaudit_expired_offer') return '审核已到期，重新提交后才能上架。';
  if (key.includes('audit')) return '审核结果和补件要求会发到消息。';
  if (key.includes('publish')) return '双审已通过，只需确认库存与时段即可发布。';
  return '查看资源、审核和正在销售的挂牌。';
}

function resumeCaption(status: NonNullable<CloudPaySnapshot['providerWorkspace']>['resume'] extends infer Value
  ? Value extends { status: infer Status } ? Status : never : never, title: string) {
  if (status === 'changes_requested') return '审核有修改意见，请处理后重新提交。';
  if (status === 'rejected') return '方案未通过审核，请按审核意见修改。';
  if (status === 'under_review') return '资源和价格正在审核。';
  if (status === 'approved') return '双审已通过，确认数量和时段即可上架。';
  if (status === 'expired') return '审核已到期，重新提交后才能上架。';
  return `上架方案“${title}”还未提交。`;
}

function providerSteps(workspace: NonNullable<CloudPaySnapshot['providerWorkspace']>) {
  const { supplierDone, resourceDone, nodeDone, offerDone, listingDone, firstIncomplete } = providerWorkspaceRoadmap(workspace);
  return [
    { label: '主体开通', meta: supplierDone ? '已通过主体审核' : '确认身份与授权关系', done: supplierDone, current: firstIncomplete === 0 },
    { label: '资料核验', meta: resourceDone ? `${workspace.resources.verified} 份资源资料已核验` : '核对权属、配置和可用性材料', done: resourceDone, current: firstIncomplete === 1 },
    { label: '节点接入', meta: nodeDone ? '节点在线且具备自动交付能力' : '在我的资产中完成安全接入和在线检查', done: nodeDone, current: firstIncomplete === 2 },
    { label: '方案与双审', meta: offerDone ? '已有获准商品方案' : workspace.offers.expired > 0 ? '审核已到期，需重新提交' : '提交服务边界与价格依据', done: offerDone, current: firstIncomplete === 3 },
    { label: '选择时段并发布', meta: listingDone ? listingProgressLabel(workspace.listings) : '审核通过后选择容量和时段', done: listingDone, current: firstIncomplete === 4 },
  ];
}

function listingProgressLabel(listings: NonNullable<CloudPaySnapshot['providerWorkspace']>['listings']) {
  const parts = [listings.selling > 0 ? `${listings.selling} 个销售中` : null, listings.scheduled > 0 ? `${listings.scheduled} 个待生效` : null,
    listings.scheduledPaused > 0 ? `${listings.scheduledPaused} 个排期已暂停` : null,
    listings.paused > 0 ? `${listings.paused} 个已暂停` : null, listings.soldOut > 0 ? `${listings.soldOut} 个已售罄` : null].filter(Boolean);
  return parts.join(' · ');
}

const roleLabel: Record<NonNullable<CloudPaySnapshot['providerWorkspace']>['subject']['role'], string> = {
  owner: '负责人', admin: '管理员', provider_manager: '上架经理', provider_operator: '资源运营', viewer: '只读成员',
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: topVideoColors.canvas }, content: { padding: 16, paddingBottom: 38 },
  workspaceCard: { minHeight: 238, marginTop: 13, padding: 17, borderRadius: 22, borderColor: topVideoColors.line, backgroundColor: topVideoColors.surface },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modePill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.88)' },
  modeDot: { width: 7, height: 7, borderRadius: 4, marginRight: 6, backgroundColor: topVideoColors.primary },
  modeText: { color: colors.primaryDark, fontSize: 11, fontWeight: '800' }, subjectRole: { color: colors.muted, fontSize: 11, fontWeight: '800' },
  heroEyebrow: { color: colors.primary, fontSize: 11, fontWeight: '900', letterSpacing: 1.2, marginTop: 26 },
  heroTitle: { color: colors.ink, fontSize: 27, lineHeight: 35, fontWeight: '900', letterSpacing: -0.7, marginTop: 8 },
  heroCaption: { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 8, maxWidth: '92%' },
  heroAction: { alignSelf: 'flex-start', minHeight: 44, marginTop: 13, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, backgroundColor: topVideoColors.primary },
  heroActionStale: { backgroundColor: topVideoColors.focus },
  heroActionText: { color: colors.surface, fontSize: 14, fontWeight: '900' },
  metrics: { flexDirection: 'row', gap: 9, marginVertical: 18 }, metric: { flex: 1, minHeight: 100, padding: 13, justifyContent: 'space-between' },
  syncNotice: { marginBottom: 12, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 10, borderColor: '#C9DCF6', backgroundColor: '#F8FBFF' },
  syncNoticeCopy: { flex: 1 }, syncNoticeTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' }, syncNoticeText: { color: colors.muted, fontSize: 10, marginTop: 3 },
  metricValue: { color: colors.ink, fontSize: 25, fontWeight: '900' }, alertValue: { color: colors.red }, metricLabel: { color: colors.muted, fontSize: 10 },
  sectionTitle: { color: colors.ink, fontSize: 21, fontWeight: '900', marginBottom: 12 }, roadmap: { paddingHorizontal: 16, paddingVertical: 7 },
  orderHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, orderCount: { color: colors.muted, fontSize: 10, marginBottom: 12 },
  allOrders: { minHeight: 46, marginBottom: 18, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderWidth: 1, borderColor: '#B9D2F7', borderRadius: 15, backgroundColor: colors.surface },
  allOrdersText: { color: colors.primary, fontSize: 12, fontWeight: '900' },
  orderError: { marginBottom: 18, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 10, borderColor: '#F2CBCB', backgroundColor: '#FFF7F7' },
  orderErrorCopy: { flex: 1 }, orderErrorTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' }, orderErrorText: { color: colors.muted, fontSize: 10, marginTop: 3 },
  stepRow: { minHeight: 76, flexDirection: 'row', alignItems: 'center' }, rail: { width: 28, height: '100%', alignItems: 'center' },
  stepDot: { width: 14, height: 14, borderRadius: 7, marginTop: 29, zIndex: 2, backgroundColor: '#CDD8D1' },
  stepDone: { width: 22, height: 22, borderRadius: 11, marginTop: 25, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.green },
  stepCurrent: { width: 18, height: 18, borderRadius: 9, marginTop: 27, borderWidth: 5, borderColor: '#B9D2F7', backgroundColor: colors.primary },
  stepLine: { position: 'absolute', top: 39, bottom: -37, width: 2, backgroundColor: colors.line }, stepLineDone: { backgroundColor: '#9ED0AC' },
  stepCopy: { flex: 1, marginLeft: 10 }, stepTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' }, stepTitleCurrent: { color: colors.primary }, stepMeta: { color: colors.muted, fontSize: 11, marginTop: 4 },
  currentPill: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 999, backgroundColor: colors.primarySoft }, currentText: { color: colors.primary, fontSize: 10, fontWeight: '900' },
  loginCard: { marginTop: 30, padding: 26, alignItems: 'center' }, loginIcon: { width: 72, height: 72, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft },
  loginTitle: { color: colors.ink, fontSize: 21, fontWeight: '900', marginTop: 17, textAlign: 'center' }, loginText: { color: colors.muted, fontSize: 12, lineHeight: 19, textAlign: 'center', marginTop: 8 },
  primary: { minHeight: 48, marginTop: 18, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center', ...ledgerActionButton }, primaryText: { ...ledgerActionText, fontSize: 14, fontWeight: '900' },
  deviceOrder: { minHeight: 70, paddingHorizontal: 12, marginBottom: 8, borderRadius: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, deviceOrderIcon: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, deviceOrderCopy: { flex: 1, marginHorizontal: 10 }, deviceOrderTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' }, deviceOrderMeta: { color: colors.muted, fontSize: 9, marginTop: 4 }, deviceOrderState: { color: colors.primary, fontSize: 9, fontWeight: '800' },
});
