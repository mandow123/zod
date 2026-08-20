import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import type { CloudPaySnapshot } from '../api';
import { Card } from '../components';
import { gpuNodeSummary } from '../compute-product';
import { NodeEnrollmentSheet } from '../NodeEnrollmentSheet';
import {
  filterProviderAssets, loadProviderAsset, loadProviderAssets, providerAssetActionAllowed, providerAssetLifecycleLabel,
  providerAssetHasView, providerAssetManagementLabel, providerAssetMaterialLabel, type ProviderAsset, type ProviderAssetFilter,
  type ProviderAssetStatus, type ProviderAssetSummary,
} from '../provider-assets';
import { loadSupplierWorkspace, resubmitResource, type ComputeResource } from '../publishing';
import { resourceStatusOpensEvidence } from '../provider-onboarding';
import { ResourceEvidenceSheet } from '../ResourceEvidenceSheet';
import { colors } from '../theme';

const emptySummary: ProviderAssetSummary = {
  total: 0, pendingConnection: 0, standby: 0, operating: 0, operatingIssue: 0, attention: 0,
  hosted: 0, deploying: 0, repurchased: 0, renewed: 0, closed: 0,
};

const filters: ReadonlyArray<Readonly<{ key: ProviderAssetFilter; label: string }>> = [
  { key: 'all', label: '全部' }, { key: 'hosted', label: '托管设备' }, { key: 'deploying', label: '部署中' },
  { key: 'attention', label: '待处理' }, { key: 'operating', label: '运营中' },
  { key: 'renewed', label: '已续产' }, { key: 'repurchased', label: '已回购' }, { key: 'closed', label: '设备关闭' },
  { key: 'pending_connection', label: '待接入' }, { key: 'standby', label: '待运营' },
];

const statusTone: Record<ProviderAssetStatus, Readonly<{
  color: string; backgroundColor: string; icon: 'link-outline' | 'hourglass-outline' | 'pulse-outline' | 'alert-circle-outline';
}>> = {
  pending_connection: { color: colors.amber, backgroundColor: colors.amberSoft, icon: 'link-outline' },
  standby: { color: colors.blue, backgroundColor: '#EAF2FF', icon: 'hourglass-outline' },
  operating: { color: colors.green, backgroundColor: colors.greenSoft, icon: 'pulse-outline' },
  operating_issue: { color: colors.red, backgroundColor: '#FFF1F1', icon: 'alert-circle-outline' },
};

type DetailSection = 'connection' | 'operation' | 'record';

export function ProviderResourcesScreen({
  snapshot, refreshing, onRefresh, onAdd, onNext, onLogin, openResourceId, onOpenHandled,
}: Readonly<{
  snapshot: CloudPaySnapshot;
  refreshing: boolean;
  onRefresh: () => void | Promise<void>;
  onAdd: () => void;
  onNext: (route: string, entityId: string | null) => void;
  onLogin: () => void;
  openResourceId?: string | null;
  onOpenHandled?: () => void;
}>) {
  const [assets, setAssets] = useState<ProviderAsset[]>([]);
  const [summary, setSummary] = useState<ProviderAssetSummary>(emptySummary);
  const [filter, setFilter] = useState<ProviderAssetFilter>('all');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<ProviderAsset | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<DetailSection | null>(null);
  const [evidenceResource, setEvidenceResource] = useState<ComputeResource | null>(null);
  const [nodeAsset, setNodeAsset] = useState<ProviderAsset | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const requestKeys = useRef(new Map<string, string>());
  const assetRequestGeneration = useRef(0);
  const detailRequestGeneration = useRef(0);
  const requestedResourceRef = useRef<string | null>(null);
  const canManage = Boolean(snapshot.providerWorkspace?.canManage);

  const loadAssets = async (generation = assetRequestGeneration.current) => {
    if (!snapshot.authenticated) {
      setAssets([]); setSummary(emptySummary); setLoaded(false); return;
    }
    setLoading(true); setError(null);
    try {
      const result = await loadProviderAssets();
      if (generation !== assetRequestGeneration.current) return;
      setAssets(result.assets); setSummary(result.summary); setLoaded(true);
      setSelectedAsset((current) => current
        ? result.assets.find((asset) => asset.id === current.id) ?? current
        : null);
      setNodeAsset((current) => current
        ? result.assets.find((asset) => asset.id === current.id) ?? current
        : null);
    } catch (caught) {
      if (generation !== assetRequestGeneration.current) return;
      setError(caught instanceof Error ? caught.message : '资产加载失败，请重试。');
    } finally {
      if (generation === assetRequestGeneration.current) setLoading(false);
    }
  };

  useEffect(() => {
    const generation = ++assetRequestGeneration.current;
    detailRequestGeneration.current += 1;
    setAssets([]); setSummary(emptySummary); setLoaded(false); setFilter('all'); setSelectedAsset(null); setNodeAsset(null);
    void loadAssets(generation);
    return () => {
      if (assetRequestGeneration.current === generation) assetRequestGeneration.current += 1;
      detailRequestGeneration.current += 1;
    };
  }, [snapshot.authenticated, snapshot.currentSubjectId]);

  useEffect(() => {
    if (!openResourceId) { requestedResourceRef.current = null; return; }
    if (requestedResourceRef.current === openResourceId) return;
    const target = assets.find((asset) => asset.resourceId === openResourceId || asset.id === openResourceId);
    if (!target) return;
    requestedResourceRef.current = openResourceId;
    onOpenHandled?.();
    if (!canManage) { openAsset(target); return; }
    void loadSupplierWorkspace().then((workspace) => {
      const resource = workspace.resources.find((item) => item.id === target.resourceId);
      if (resource && resourceStatusOpensEvidence(resource.status)) {
        setEvidenceResource(resource);
        return;
      }
      openAsset(target);
    }).catch(() => openAsset(target));
  }, [assets, canManage, onOpenHandled, openResourceId]);

  const refreshAll = async () => {
    await onRefresh();
    await loadAssets();
  };

  const openAsset = (asset: ProviderAsset) => {
    const generation = ++detailRequestGeneration.current;
    setSelectedAsset(asset); setDetailError(null);
    setExpanded(asset.status === 'pending_connection' ? 'connection' : 'operation');
    setDetailLoading(true);
    void loadProviderAsset(asset.id)
      .then((latest) => { if (generation === detailRequestGeneration.current) setSelectedAsset(latest); })
      .catch((caught) => { if (generation === detailRequestGeneration.current) setDetailError(caught instanceof Error ? caught.message : '没能读取最新资产详情。'); })
      .finally(() => { if (generation === detailRequestGeneration.current) setDetailLoading(false); });
  };

  const runAction = async (asset: ProviderAsset) => {
    const action = asset.nextAction;
    if (!providerAssetActionAllowed(action, canManage) || !action || busyAction) return;
    if (action.route !== 'provider_resources') {
      onNext(action.route, action.entityId);
      setSelectedAsset(null);
      return;
    }
    setBusyAction(true); setDetailError(null);
    try {
      const workspace = await loadSupplierWorkspace();
      let resource = workspace.resources.find((item) => item.id === asset.resourceId) ?? null;
      if (!resource) throw new Error('没有找到这项资源的核验记录。');
      if (action.key === 'resubmit_resource') {
        let requestId = requestKeys.current.get(asset.resourceId);
        if (!requestId) {
          requestId = `resource-resubmit-${Crypto.randomUUID()}`;
          requestKeys.current.set(asset.resourceId, requestId);
        }
        const result = await resubmitResource(asset.resourceId, requestId);
        requestKeys.current.delete(asset.resourceId);
        resource = result.resource;
        await loadAssets();
      }
      setEvidenceResource(resource); setSelectedAsset(null);
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : '暂时没能打开资源记录。');
    } finally {
      setBusyAction(false);
    }
  };

  const openNodeEnrollment = (asset: ProviderAsset) => {
    if (!canManage || !asset.nodeAction) return;
    setSelectedAsset(null); setNodeAsset(asset);
  };

  const visibleAssets = useMemo(() => filterProviderAssets(assets, filter), [assets, filter]);

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing || loading} onRefresh={() => void refreshAll()} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headingRow}>
          <View><Text style={styles.eyebrow}>资产中心</Text><Text style={styles.title}>我的资产</Text><Text style={styles.caption}>设备状态和待办集中管理</Text></View>
          {!snapshot.authenticated || canManage ? <Pressable accessibilityLabel="添加资产" onPress={snapshot.authenticated ? onAdd : onLogin} style={styles.addButton}><Ionicons name="add" size={22} color={colors.surface} /></Pressable> : null}
        </View>

        {!snapshot.authenticated ? (
          <Card style={styles.loginCard}>
            <Ionicons name="lock-closed-outline" size={30} color={colors.primary} />
            <Text style={styles.loginTitle}>登录后查看资产</Text>
            <Text style={styles.loginText}>设备状态、待处理事项和上架记录都绑定当前主体。</Text>
            <Pressable onPress={onLogin} style={styles.loginButton}><Text style={styles.primaryText}>登录</Text></Pressable>
          </Card>
        ) : (
          <>
            <View style={styles.summaryBar}>
              <Text style={styles.summaryStrong}>{summary.total} 台设备</Text>
              <View style={styles.summaryDot} /><Text style={styles.summaryText}>{summary.operating} 台运营</Text>
              {summary.deploying > 0 ? <><View style={styles.summaryDot} /><Text style={styles.summaryText}>{summary.deploying} 台部署中</Text></> : null}
              <View style={styles.summaryDot} /><Text style={[styles.summaryText, summary.attention > 0 && styles.summaryAttention]}>{summary.attention} 项待处理</Text>
            </View>

            {summary.attention > 0 ? (
              <Pressable onPress={() => setFilter('attention')} style={styles.attentionEntry}>
                <View style={styles.attentionIcon}><Ionicons name="alert-circle-outline" size={20} color={colors.amber} /></View>
                <View style={styles.attentionCopy}><Text style={styles.attentionTitle}>还有 {summary.attention} 项需要你处理</Text><Text style={styles.attentionText}>按紧急程度查看设备和下一步。</Text></View>
                <Ionicons name="arrow-forward" size={17} color={colors.amber} />
              </Pressable>
            ) : null}

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
              {filters.map((item) => <Pressable key={item.key} onPress={() => setFilter(item.key)} style={[styles.filter, filter === item.key && styles.filterActive]}><Text style={[styles.filterText, filter === item.key && styles.filterTextActive]}>{item.label}</Text></Pressable>)}
            </ScrollView>

            {error && loaded ? <View style={styles.errorBox}><Ionicons name="alert-circle-outline" size={18} color={colors.red} /><Text style={styles.errorText}>{error}</Text></View> : null}
            {loading && !loaded ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}
            {!loading && !loaded ? <LoadError message={error} onRetry={() => void loadAssets()} /> : null}
            {loaded && assets.length === 0 ? <EmptyAssets canManage={canManage} onAdd={onAdd} /> : null}
            {loaded && assets.length > 0 && visibleAssets.length === 0 ? (
              <Card style={styles.emptyCard}><Ionicons name="funnel-outline" size={28} color={colors.primary} /><Text style={styles.emptyTitle}>这里暂时没有设备</Text><Text style={styles.emptyText}>换个筛选条件看看。</Text><Pressable onPress={() => setFilter('all')}><Text style={styles.clearFilter}>查看全部</Text></Pressable></Card>
            ) : null}

            <View style={styles.assetList}>{visibleAssets.map((asset) => (
              <AssetCard key={asset.id} asset={asset} canManage={canManage} busy={busyAction}
                onOpen={() => openAsset(asset)} onAction={() => void runAction(asset)}
                onNodeAction={() => openNodeEnrollment(asset)} />
            ))}</View>
          </>
        )}
      </ScrollView>

      <AssetDetailSheet
        asset={selectedAsset}
        canManage={canManage}
        loading={detailLoading}
        error={detailError}
        expanded={expanded}
        busy={busyAction}
        onToggle={(section) => setExpanded((current) => current === section ? null : section)}
        onClose={() => { if (!busyAction) { detailRequestGeneration.current += 1; setSelectedAsset(null); } }}
        onAction={() => selectedAsset ? void runAction(selectedAsset) : undefined}
        onNodeAction={() => selectedAsset ? openNodeEnrollment(selectedAsset) : undefined}
      />
      <NodeEnrollmentSheet asset={nodeAsset} onClose={() => setNodeAsset(null)} onChanged={loadAssets} />
      <ResourceEvidenceSheet resource={evidenceResource} canManage={Boolean(snapshot.providerWorkspace?.canManage)} onClose={() => setEvidenceResource(null)} onChanged={refreshAll} />
    </View>
  );
}

function AssetCard({ asset, canManage, busy, onOpen, onAction, onNodeAction }: Readonly<{
  asset: ProviderAsset; canManage: boolean; busy: boolean; onOpen: () => void; onAction: () => void; onNodeAction: () => void;
}>) {
  const tone = statusTone[asset.status];
  const management = providerAssetManagementLabel(asset.managementMode);
  const nodeSummary = gpuNodeSummary(asset.specifications);
  const action = providerAssetActionAllowed(asset.nextAction, canManage) ? asset.nextAction : null;
  const nodePrimary = canManage && asset.nodeAction?.key === 'issue_node_claim' ? asset.nodeAction : null;
  return <Pressable onPress={onOpen}>
    <Card style={styles.assetCard}>
      <View style={styles.assetTop}>
        <View style={styles.assetIcon}><Ionicons name="server-outline" size={21} color={colors.primary} /></View>
        <View style={styles.assetCopy}><Text style={styles.assetName}>{asset.name}</Text><Text style={styles.assetMeta}>{[management, nodeSummary, asset.region].filter(Boolean).join(' · ')}</Text></View>
        <View style={[styles.statusPill, { backgroundColor: tone.backgroundColor }]}><Ionicons name={tone.icon} size={13} color={tone.color} /><Text style={[styles.statusText, { color: tone.color }]}>{asset.statusLabel}</Text></View>
      </View>
      <Text style={styles.factLine}>{providerAssetMaterialLabel(asset.materialStatus)} · {asset.deliveryReadiness.label}</Text>
      {providerAssetHasView(asset, 'renewed') && !providerAssetHasView(asset, 'closed') ? <View style={styles.renewedTag}><Text style={styles.renewedTagText}>已续产</Text></View> : null}
      {asset.attention ? <View style={[styles.assetAttention, asset.attention.severity === 'critical' && styles.assetAttentionCritical]}><Text style={styles.assetAttentionTitle}>{asset.attention.severity === 'info' ? '进度' : '待处理'} · {asset.attention.title}</Text><Text numberOfLines={2} style={styles.assetAttentionText}>{asset.attention.detail}</Text></View> : null}
      <View style={styles.cardFooter}>
        <Text style={styles.detailLink}>查看详情</Text>
        {nodePrimary || action ? <Pressable disabled={busy} onPress={(event) => { event.stopPropagation(); nodePrimary ? onNodeAction() : onAction(); }} style={styles.actionButton}>{busy ? <ActivityIndicator size="small" color={colors.surface} /> : <><Text style={styles.actionText}>{nodePrimary?.label ?? action?.label}</Text><Ionicons name="arrow-forward" size={14} color={colors.surface} /></>}</Pressable> : <Ionicons name="chevron-forward" size={17} color={colors.subtle} />}
      </View>
    </Card>
  </Pressable>;
}

function AssetDetailSheet({ asset, canManage, loading, error, expanded, busy, onToggle, onClose, onAction, onNodeAction }: Readonly<{
  asset: ProviderAsset | null; canManage: boolean; loading: boolean; error: string | null; expanded: DetailSection | null; busy: boolean;
  onToggle: (section: DetailSection) => void; onClose: () => void; onAction: () => void; onNodeAction: () => void;
}>) {
  if (!asset) return null;
  const tone = statusTone[asset.status];
  const management = providerAssetManagementLabel(asset.managementMode);
  const action = providerAssetActionAllowed(asset.nextAction, canManage) ? asset.nextAction : null;
  const nodeAction = canManage ? asset.nodeAction : null;
  const nodePrimary = nodeAction?.key === 'issue_node_claim' ? nodeAction : null;
  return <Modal visible animationType="slide" transparent onRequestClose={onClose}>
    <View style={styles.backdrop}><View style={styles.detailSheet}>
      <View style={styles.handle} />
      <View style={styles.detailHeader}>
        <View style={styles.detailHeaderCopy}><Text style={styles.detailEyebrow}>资产详情</Text><Text style={styles.detailTitle}>{asset.name}</Text><Text style={styles.detailMeta}>{[management, asset.region].filter(Boolean).join(' · ')}</Text></View>
        <Pressable disabled={busy} onPress={onClose} style={styles.closeButton}><Ionicons name="close" size={22} color={colors.ink} /></Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.detailContent} showsVerticalScrollIndicator={false}>
        <View style={[styles.detailStatus, { backgroundColor: tone.backgroundColor }]}><Ionicons name={tone.icon} size={22} color={tone.color} /><View style={styles.detailStatusCopy}><Text style={[styles.detailStatusTitle, { color: tone.color }]}>{asset.statusLabel}</Text><Text style={styles.detailStatusText}>{asset.statusDetail}</Text></View>{loading ? <ActivityIndicator size="small" color={tone.color} /> : null}</View>
        {error ? <View style={styles.errorBox}><Ionicons name="alert-circle-outline" size={18} color={colors.red} /><Text style={styles.errorText}>{error}</Text></View> : null}
        {asset.attention ? <View style={[styles.detailAttention, asset.attention.severity === 'critical' && styles.assetAttentionCritical]}><Text style={styles.detailAttentionLabel}>{asset.attention.severity === 'info' ? '当前进度' : '待处理'}</Text><Text style={styles.detailAttentionTitle}>{asset.attention.title}</Text><Text style={styles.detailAttentionText}>{asset.attention.detail}</Text></View> : null}

        <View style={styles.currentRow}><Fact label="资料" value={providerAssetMaterialLabel(asset.materialStatus)} /><Fact label="节点" value={asset.deliveryReadiness.label} /><Fact label="资产" value={providerAssetLifecycleLabel(asset.lifecycle)} /></View>

        <DetailSectionRow title="设备与接入" open={expanded === 'connection'} onPress={() => onToggle('connection')}>
          <DetailLine label="管理方式" value={management ?? '未标注'} />
          <DetailLine label="节点状态" value={asset.deliveryReadiness.label} />
          <DetailLine label="最近在线" value={timeLabel(asset.deliveryReadiness.nodeLastSeenAt)} />
          {nodeAction ? <Pressable disabled={busy} onPress={onNodeAction} style={nodeAction.key === 'revoke_node_enrollment' ? styles.nodeDangerButton : styles.nodeButton}><Text style={nodeAction.key === 'revoke_node_enrollment' ? styles.nodeDangerText : styles.nodeButtonText}>{nodeAction.label}</Text></Pressable> : null}
        </DetailSectionRow>
        <DetailSectionRow title="运营与上架" open={expanded === 'operation'} onPress={() => onToggle('operation')}>
          <Text style={styles.sectionBody}>{asset.statusDetail}</Text>
          <DetailLine label="当前状态" value={asset.statusLabel} />
          <DetailLine label="下一步" value={action?.label ?? '暂无待处理操作'} />
        </DetailSectionRow>
        <DetailSectionRow title="资产记录" open={expanded === 'record'} onPress={() => onToggle('record')}>
          <DetailLine label="生命周期" value={providerAssetLifecycleLabel(asset.lifecycle)} />
          {asset.lifecycleFacts?.renewedAt ? <DetailLine label="最近续产" value={timeLabel(asset.lifecycleFacts.renewedAt)} /> : null}
          {asset.lifecycleFacts?.repurchasedAt ? <DetailLine label="完成回购" value={timeLabel(asset.lifecycleFacts.repurchasedAt)} /> : null}
          {asset.lifecycleFacts?.closedAt ? <DetailLine label="设备关闭" value={timeLabel(asset.lifecycleFacts.closedAt)} /> : null}
          <DetailLine label="资源编号" value={asset.resourceId} />
          <DetailLine label="最近更新" value={timeLabel(asset.updatedAt)} />
        </DetailSectionRow>
      </ScrollView>
      {nodePrimary || action ? <View style={styles.detailFooter}><Pressable disabled={busy} onPress={nodePrimary ? onNodeAction : onAction} style={styles.detailAction}>{busy ? <ActivityIndicator color={colors.surface} /> : <><Text style={styles.detailActionText}>{nodePrimary?.label ?? action?.label}</Text><Ionicons name="arrow-forward" size={17} color={colors.surface} /></>}</Pressable></View> : null}
    </View></View>
  </Modal>;
}

function DetailSectionRow({ title, open, onPress, children }: Readonly<{
  title: string; open: boolean; onPress: () => void; children: ReactNode;
}>) {
  return <View style={styles.sectionCard}><Pressable onPress={onPress} style={styles.sectionHeading}><Text style={styles.sectionTitle}>{title}</Text><Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.muted} /></Pressable>{open ? <View style={styles.sectionContent}>{children}</View> : null}</View>;
}

function DetailLine({ label, value }: Readonly<{ label: string; value: string }>) {
  return <View style={styles.detailLine}><Text style={styles.detailLineLabel}>{label}</Text><Text style={styles.detailLineValue}>{value}</Text></View>;
}

function Fact({ label, value }: Readonly<{ label: string; value: string }>) {
  return <View style={styles.fact}><Text style={styles.factLabel}>{label}</Text><Text numberOfLines={2} style={styles.factValue}>{value}</Text></View>;
}

function LoadError({ message, onRetry }: Readonly<{ message: string | null; onRetry: () => void }>) {
  return <Card style={styles.emptyCard}><Ionicons name="cloud-offline-outline" size={30} color={colors.primary} /><Text style={styles.emptyTitle}>没能读取资产</Text><Text style={styles.emptyText}>{message ?? '请检查网络后重试，现有记录不会被修改。'}</Text><Pressable onPress={onRetry} style={styles.retryButton}><Text style={styles.primaryText}>重新读取</Text></Pressable></Card>;
}

function EmptyAssets({ canManage, onAdd }: Readonly<{ canManage: boolean; onAdd: () => void }>) {
  return <Card style={styles.emptyCard}><Ionicons name="server-outline" size={30} color={colors.primary} /><Text style={styles.emptyTitle}>还没有资产</Text><Text style={styles.emptyText}>{canManage ? '添加第一项设备后，资料、节点和运营状态会集中显示在这里。' : '当前主体还没有资产，管理员添加后会显示在这里。'}</Text>{canManage ? <Pressable onPress={onAdd} style={styles.retryButton}><Text style={styles.primaryText}>添加资产</Text></Pressable> : null}</Card>;
}

function timeLabel(value: string | null) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '暂无记录';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 16, paddingBottom: 150 },
  headingRow: { marginTop: 8, marginBottom: 18, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }, eyebrow: { color: colors.primary, fontSize: 12, fontWeight: '800', letterSpacing: 0.8 }, title: { color: colors.ink, fontSize: 30, lineHeight: 38, fontWeight: '900', marginTop: 4 }, caption: { color: colors.muted, fontSize: 14, lineHeight: 22, marginTop: 3 }, addButton: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  summaryBar: { minHeight: 48, paddingHorizontal: 14, borderRadius: 16, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', backgroundColor: colors.surface }, summaryStrong: { color: colors.ink, fontSize: 12, fontWeight: '900' }, summaryText: { color: colors.muted, fontSize: 11 }, summaryAttention: { color: colors.amber, fontWeight: '900' }, summaryDot: { width: 3, height: 3, marginHorizontal: 9, borderRadius: 2, backgroundColor: colors.subtle },
  attentionEntry: { minHeight: 72, marginTop: 10, padding: 12, borderRadius: 18, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.amberSoft }, attentionIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, attentionCopy: { flex: 1, marginHorizontal: 10 }, attentionTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, attentionText: { color: colors.muted, fontSize: 11, marginTop: 4 },
  filters: { gap: 8, paddingVertical: 17 }, filter: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }, filterActive: { borderColor: colors.primary, backgroundColor: colors.primary }, filterText: { color: colors.muted, fontSize: 14, fontWeight: '800' }, filterTextActive: { color: colors.surface },
  assetList: { gap: 10 }, assetCard: { padding: 16 }, assetTop: { flexDirection: 'row', alignItems: 'center' }, assetIcon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, assetCopy: { flex: 1, marginHorizontal: 10 }, assetName: { color: colors.ink, fontSize: 16, lineHeight: 24, fontWeight: '900' }, assetMeta: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 2 }, statusPill: { minHeight: 32, paddingHorizontal: 9, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 4 }, statusText: { fontSize: 11, fontWeight: '900' }, factLine: { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 12, paddingTop: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  assetAttention: { marginTop: 11, padding: 12, borderRadius: 12, backgroundColor: colors.amberSoft }, assetAttentionCritical: { backgroundColor: '#FEECEB' }, assetAttentionTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, assetAttentionText: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 3 }, cardFooter: { minHeight: 44, marginTop: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, detailLink: { color: colors.primary, fontSize: 13, fontWeight: '800' }, actionButton: { minHeight: 44, paddingHorizontal: 14, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.primary }, actionText: { color: colors.surface, fontSize: 13, fontWeight: '900' },
  renewedTag: { alignSelf: 'flex-start', marginTop: 10, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 7, backgroundColor: colors.primarySoft }, renewedTagText: { color: colors.primary, fontSize: 11, fontWeight: '900' },
  errorBox: { marginBottom: 12, padding: 12, borderRadius: 14, flexDirection: 'row', gap: 8, backgroundColor: '#FFF1F1' }, errorText: { flex: 1, color: colors.red, fontSize: 11, lineHeight: 17 }, loader: { marginVertical: 32 },
  loginCard: { padding: 25, alignItems: 'center' }, loginTitle: { color: colors.ink, fontSize: 18, fontWeight: '900', marginTop: 13 }, loginText: { color: colors.muted, fontSize: 12, lineHeight: 19, textAlign: 'center', marginTop: 6 }, loginButton: { width: 170, minHeight: 50, marginTop: 16, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, primaryText: { color: colors.surface, fontSize: 13, fontWeight: '900' },
  emptyCard: { padding: 24, alignItems: 'center' }, emptyTitle: { color: colors.ink, fontSize: 16, fontWeight: '900', marginTop: 10 }, emptyText: { color: colors.muted, fontSize: 12, lineHeight: 19, textAlign: 'center', marginTop: 5 }, retryButton: { minWidth: 160, minHeight: 48, marginTop: 15, paddingHorizontal: 18, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }, clearFilter: { color: colors.primary, fontSize: 13, fontWeight: '900', marginTop: 14 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.38)' }, detailSheet: { height: '91%', paddingTop: 9, borderTopLeftRadius: 30, borderTopRightRadius: 30, overflow: 'hidden', backgroundColor: colors.canvas }, handle: { width: 42, height: 5, alignSelf: 'center', borderRadius: 3, backgroundColor: '#D0D5DD' }, detailHeader: { paddingHorizontal: 18, paddingVertical: 15, flexDirection: 'row', alignItems: 'flex-start' }, detailHeaderCopy: { flex: 1 }, detailEyebrow: { color: colors.primary, fontSize: 11, fontWeight: '900', letterSpacing: 1.1 }, detailTitle: { color: colors.ink, fontSize: 23, fontWeight: '900', marginTop: 5 }, detailMeta: { color: colors.muted, fontSize: 11, marginTop: 5 }, closeButton: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, detailContent: { paddingHorizontal: 17, paddingBottom: 120 },
  detailStatus: { minHeight: 76, padding: 13, borderRadius: 18, flexDirection: 'row', alignItems: 'flex-start', gap: 10 }, detailStatusCopy: { flex: 1 }, detailStatusTitle: { fontSize: 13, fontWeight: '900' }, detailStatusText: { color: colors.ink, fontSize: 11, lineHeight: 17, marginTop: 4 }, detailAttention: { marginTop: 11, padding: 13, borderRadius: 16, backgroundColor: colors.amberSoft }, detailAttentionLabel: { color: colors.amber, fontSize: 11, fontWeight: '900' }, detailAttentionTitle: { color: colors.ink, fontSize: 13, fontWeight: '900', marginTop: 5 }, detailAttentionText: { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: 4 },
  currentRow: { marginVertical: 12, padding: 12, borderRadius: 18, flexDirection: 'row', gap: 8, backgroundColor: colors.surface }, fact: { flex: 1 }, factLabel: { color: colors.muted, fontSize: 10 }, factValue: { color: colors.ink, fontSize: 11, lineHeight: 16, fontWeight: '900', marginTop: 4 }, sectionCard: { marginBottom: 9, borderRadius: 17, overflow: 'hidden', backgroundColor: colors.surface }, sectionHeading: { minHeight: 53, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, sectionTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, sectionContent: { paddingHorizontal: 14, paddingBottom: 13, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }, sectionBody: { color: colors.muted, fontSize: 11, lineHeight: 17, paddingVertical: 11 }, detailLine: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 }, detailLineLabel: { color: colors.muted, fontSize: 11 }, detailLineValue: { flex: 1, color: colors.ink, fontSize: 11, fontWeight: '800', textAlign: 'right' },
  nodeButton: { minHeight: 44, marginTop: 8, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, nodeButtonText: { color: colors.primary, fontSize: 14, fontWeight: '900' }, nodeDangerButton: { minHeight: 44, marginTop: 8, borderWidth: 1, borderColor: '#F2B7B7', borderRadius: 10, alignItems: 'center', justifyContent: 'center' }, nodeDangerText: { color: colors.red, fontSize: 14, fontWeight: '900' },
  detailFooter: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 17, paddingTop: 10, paddingBottom: 24, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.canvas }, detailAction: { minHeight: 52, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.primary }, detailActionText: { color: colors.surface, fontSize: 16, fontWeight: '900' },
});
