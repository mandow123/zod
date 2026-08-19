import { Ionicons } from '@expo/vector-icons';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { logoutCloudPay, type CloudPaySnapshot, type TradingSubject } from '../api';
import { AccountSecuritySheet } from '../AccountSecuritySheet';
import { brand, colors } from '../theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

const subjectStatusLabel: Record<TradingSubject['status'], string> = {
  active: '主体正常', suspended: '主体已暂停', closed: '主体已关闭',
};
const subjectRoleLabel: Record<TradingSubject['role'], string> = {
  owner: '所有者', admin: '管理员', provider_manager: '供应管理', provider_operator: '供应运营', viewer: '查看权限',
};
const supplierStatusLabel: Record<NonNullable<NonNullable<CloudPaySnapshot['providerWorkspace']>['supplier']>['status'], string> = {
  draft: '资料待完善', submitted: '资料审核中', approved: '资格已通过', rejected: '审核退回，需补充资料', suspended: '供应资格已暂停',
};

function PrivacySheet({ visible, onClose }: Readonly<{ visible: boolean; onClose: () => void }>) {
  return <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}><View style={styles.backdrop}><View style={styles.sheet}><View style={styles.handle} /><View style={styles.sheetHeading}><Text style={styles.sheetTitle}>隐私与数据</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭隐私与数据" onPress={onClose}><Ionicons name="close" size={22} color={colors.ink} /></Pressable></View>{[
    ['公开市场数据', 'App 只读取已审核资源与挂牌。'],
    ['安全会话', '凭证保存在手机系统安全存储中。'],
    ['交易边界', '卡时、订单和供给操作必须由服务端确认。'],
  ].map(([title, body]) => <View key={title} style={styles.privacyRow}><Text style={styles.privacyTitle}>{title}</Text><Text style={styles.privacyText}>{body}</Text></View>)}</View></View></Modal>;
}

function SubjectSheet({ visible, subjects, currentSubjectId, onSelect, onClose }: Readonly<{
  visible: boolean; subjects: readonly TradingSubject[]; currentSubjectId: string | null;
  onSelect: (subjectId: string) => void; onClose: () => void;
}>) {
  return <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}><View style={styles.backdrop}><View style={styles.sheet}><View style={styles.handle} />
    <View style={styles.sheetHeading}><View><Text style={styles.sheetTitle}>主体与认证</Text><Text style={styles.sheetSubtitle}>显示服务端返回的交易主体与当前状态</Text></View><Pressable accessibilityRole="button" accessibilityLabel="关闭主体选择" onPress={onClose}><Ionicons name="close" size={22} color={colors.ink} /></Pressable></View>
    {subjects.length ? <View style={styles.subjectList}>{subjects.map((subject, index) => {
      const selected = subject.id === currentSubjectId;
      return <Pressable key={subject.id} accessibilityRole="button" accessibilityState={{ selected }} onPress={() => { onSelect(subject.id); onClose(); }} style={[styles.subjectRow, index === subjects.length - 1 && styles.lastRow]}>
        <View style={[styles.menuIcon, selected && styles.selectedIcon]}><Ionicons name={subject.kind === 'organization' ? 'business-outline' : 'person-outline'} size={18} color={selected ? colors.primary : colors.ink} /></View>
        <View style={styles.rowCopy}><Text style={styles.rowTitle}>{subject.displayName}</Text><Text style={styles.rowMeta}>{subject.kind === 'organization' ? '组织主体' : '个人主体'} · {subjectRoleLabel[subject.role]} · {subjectStatusLabel[subject.status]}</Text></View>
        <Ionicons name={selected ? 'checkmark-circle' : 'chevron-forward'} size={selected ? 19 : 16} color={selected ? colors.primary : colors.subtle} />
      </Pressable>;
    })}</View> : <View style={styles.subjectEmpty}><Text style={styles.subjectEmptyTitle}>暂无交易主体</Text><Text style={styles.subjectEmptyText}>主体信息以服务端实际开通结果为准。</Text></View>}
  </View></View></Modal>;
}

type Props = Readonly<{
  snapshot: CloudPaySnapshot; onSelectSubject: (subjectId: string) => void;
  onSessionChanged: () => void | Promise<void>; onLogin: () => void; onOpenQualification: () => void;
  onOpenCredits: () => void; onOpenOrders: () => void; onOpenAssets: () => void;
  onOpenCreatorCollaboration: () => void; onOpenMessages: () => void; onOpenPayout: () => void;
}>;

export function ProfileScreen({ snapshot, onSelectSubject, onSessionChanged, onLogin, onOpenQualification, onOpenCredits, onOpenOrders, onOpenAssets, onOpenCreatorCollaboration, onOpenMessages, onOpenPayout }: Props) {
  const [privacyVisible, setPrivacyVisible] = useState(false);
  const [securityVisible, setSecurityVisible] = useState(false);
  const [subjectsVisible, setSubjectsVisible] = useState(false);
  const currentSubject = snapshot.subjects.find((subject) => subject.id === snapshot.currentSubjectId) ?? null;
  const supplier = snapshot.providerWorkspace?.supplier ?? null;
  // payout-profile is synthesized as pending for buyers, so supplier is the sole supply-business gate.
  const showSupplyBusiness = supplier !== null;
  const payoutActive = snapshot.payoutProfile?.status === 'active';
  const payoutMeta = payoutActive ? '查看可兑付收益与公司付款进度'
    : snapshot.payoutProfile?.status === 'suspended' ? '收款账户已暂停，请联系客服' : '兑付资格尚未激活';
  const accountAction = () => {
    if (!snapshot.authenticated) { onLogin(); return; }
    Alert.alert('退出当前设备？', '其他已登录设备不会受影响。', [{ text: '取消', style: 'cancel' }, { text: '安全退出', style: 'destructive', onPress: () => { void logoutCloudPay().then(onSessionChanged).catch(() => onSessionChanged()); } }]);
  };
  const openSubjects = () => snapshot.authenticated ? setSubjectsVisible(true) : onLogin();

  return <View style={styles.root}><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
    <Text style={styles.pageTitle}>我的</Text>
    <View style={styles.accountCard}><View style={styles.avatar}><Text style={styles.avatarText}>{snapshot.user?.displayName.trim().slice(0, 2).toUpperCase() || 'ZD'}</Text></View><View style={styles.accountCopy}><Text style={styles.accountName}>{snapshot.user?.displayName ?? '访客模式'}</Text><Text style={styles.accountMeta}>{snapshot.user?.phone ?? snapshot.user?.email ?? '登录后查看账号资产'}</Text></View><Pressable accessibilityRole="button" onPress={accountAction}><Text style={styles.textAction}>{snapshot.authenticated ? '退出' : '登录 Zod'}</Text></Pressable></View>

    {snapshot.authenticated ? <Pressable accessibilityRole="button" onPress={openSubjects} style={styles.subjectSummary}>
      <View style={styles.subjectSummaryCopy}><Text style={styles.subjectEyebrow}>当前交易主体</Text><Text numberOfLines={1} style={styles.subjectName}>{currentSubject?.displayName ?? '暂无可用主体'}</Text><Text style={styles.subjectMeta}>{currentSubject ? `${currentSubject.kind === 'organization' ? '组织主体' : '个人主体'} · ${subjectRoleLabel[currentSubject.role]} · ${subjectStatusLabel[currentSubject.status]}` : '主体状态以服务端为准'}</Text></View>
      <View style={styles.subjectAction}><Text style={styles.subjectActionText}>{snapshot.subjects.length > 1 ? '切换' : '查看'}</Text><Ionicons name="chevron-forward" size={15} color={colors.primary} /></View>
    </Pressable> : null}

    <MenuGroup title="资产与交易" caption="常用账户能力" icon="wallet-outline">
      <Menu icon="cube-outline" label="我的资产" meta="我购买的、我提供的" onPress={onOpenAssets} />
      <Menu icon="receipt-outline" label="订单" meta="购买、交付、验收与售后" onPress={onOpenOrders} />
      <Menu icon="wallet-outline" label="KAI 卡时" meta="余额、预留、待结算与明细" onPress={onOpenCredits} last />
    </MenuGroup>

    {showSupplyBusiness ? <MenuGroup title="供给经营" caption="资格审核与供应结算" icon="server-outline" accent="orange">
      <Menu icon="shield-checkmark-outline" label="上架资格"
        meta={supplier.status === 'approved' ? '资格已通过 · 创建和管理资源请使用“我的资产”' : `${supplierStatusLabel[supplier.status]} · 查看审核与资格状态`}
        onPress={supplier.status === 'approved' ? undefined : onOpenQualification} enabled={supplier.status !== 'approved'}
        trailingIcon={supplier.status === 'approved' ? 'checkmark-circle' : undefined} tone="orange" />
      <Menu icon="cash-outline" label="供应收益与兑付" meta={payoutMeta} onPress={payoutActive ? onOpenPayout : undefined} enabled={payoutActive} tone="orange" last />
    </MenuGroup> : null}

    <MenuGroup title="合作增长" caption="真实订单归因与返佣" icon="people-outline">
      <Menu icon="people-outline" label="达人合作" meta="返佣账本、观察期、冲正与转入" onPress={onOpenCreatorCollaboration} last />
    </MenuGroup>

    <MenuGroup title="服务与安全" caption="账号、主体与隐私" icon="shield-checkmark-outline">
      <Menu icon="chatbubble-ellipses-outline" label="客服与帮助" meta={`通过消息联系 ${brand.name}`} onPress={onOpenMessages} />
      <Menu icon="business-outline" label="主体与认证" meta={currentSubject ? `${currentSubject.displayName} · ${subjectStatusLabel[currentSubject.status]}` : '查看真实主体状态'} onPress={openSubjects} />
      <Menu icon="settings-outline" label="账号设置" meta="登录安全与设备管理" onPress={() => snapshot.authenticated ? setSecurityVisible(true) : onLogin()} />
      <Menu icon="document-text-outline" label="隐私与数据" meta="数据使用与交易边界" onPress={() => setPrivacyVisible(true)} last />
    </MenuGroup>
    <Text style={styles.version}>{brand.name} · 1.0.0</Text>
  </ScrollView>
  <SubjectSheet visible={subjectsVisible} subjects={snapshot.subjects} currentSubjectId={snapshot.currentSubjectId} onSelect={onSelectSubject} onClose={() => setSubjectsVisible(false)} />
  <PrivacySheet visible={privacyVisible} onClose={() => setPrivacyVisible(false)} />
  <AccountSecuritySheet visible={securityVisible} pushBackendReady={snapshot.pushReady} phoneReauthenticationAvailable={Boolean(snapshot.user?.phone)} onClose={() => setSecurityVisible(false)} onAccountChanged={onSessionChanged} />
  </View>;
}

function MenuGroup({ title, caption, icon, accent = 'blue', children }: Readonly<{ title: string; caption: string; icon: IconName; accent?: 'blue' | 'orange'; children: ReactNode }>) {
  return <View style={styles.group}><View style={styles.groupHeading}><View style={[styles.groupGlyph, accent === 'orange' && styles.orangeGlyph]}><Ionicons name={icon} size={17} color={accent === 'orange' ? colors.orange : colors.primary} /></View><View><Text style={styles.sectionLabel}>{title}</Text><Text style={styles.sectionCaption}>{caption}</Text></View></View><View style={styles.menuCard}>{children}</View></View>;
}

function Menu({ icon, label, meta, onPress, enabled = true, trailingIcon, tone = 'blue', last = false }: Readonly<{ icon: IconName; label: string; meta?: string; onPress?: () => void; enabled?: boolean; trailingIcon?: IconName; tone?: 'blue' | 'orange'; last?: boolean }>) {
  return <Pressable accessibilityRole={onPress ? 'button' : undefined} accessibilityState={{ disabled: !enabled }} disabled={!enabled || !onPress} onPress={onPress} style={[styles.menuRow, last && styles.lastRow, !enabled && styles.disabledRow]}>
    <View style={[styles.menuIcon, tone === 'orange' && styles.orangeMenuIcon]}><Ionicons name={icon} size={18} color={tone === 'orange' ? colors.orange : colors.ink} /></View>
    <View style={styles.rowCopy}><Text style={styles.rowTitle}>{label}</Text>{meta ? <Text style={styles.rowMeta}>{meta}</Text> : null}</View>
    {trailingIcon ? <Ionicons name={trailingIcon} size={18} color={colors.green} /> : enabled && onPress ? <Ionicons name="chevron-forward" size={16} color={colors.subtle} /> : <Ionicons name="lock-closed-outline" size={15} color={colors.subtle} />}
  </Pressable>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 16, paddingBottom: 34 }, pageTitle: { color: colors.ink, fontSize: 25, fontWeight: '900', marginBottom: 12 },
  accountCard: { minHeight: 76, paddingHorizontal: 13, borderRadius: 14, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, avatar: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E8F2FF' }, avatarText: { color: colors.ink, fontSize: 14, fontWeight: '900' }, accountCopy: { flex: 1, marginLeft: 11 }, accountName: { color: colors.ink, fontSize: 15, fontWeight: '900' }, accountMeta: { color: colors.muted, fontSize: 9, marginTop: 4 }, textAction: { color: colors.primary, fontSize: 11, fontWeight: '800' },
  subjectSummary: { minHeight: 76, marginTop: 10, paddingHorizontal: 14, borderRadius: 14, flexDirection: 'row', alignItems: 'center', backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#DFE6EE' }, subjectSummaryCopy: { flex: 1 }, subjectEyebrow: { color: colors.primary, fontSize: 8, fontWeight: '900' }, subjectName: { color: colors.ink, fontSize: 13, fontWeight: '900', marginTop: 4 }, subjectMeta: { color: colors.muted, fontSize: 9, marginTop: 4 }, subjectAction: { flexDirection: 'row', alignItems: 'center', gap: 3 }, subjectActionText: { color: colors.primary, fontSize: 10, fontWeight: '800' },
  group: { marginTop: 20 }, groupHeading: { minHeight: 38, marginBottom: 8, paddingHorizontal: 2, flexDirection: 'row', alignItems: 'center' }, groupGlyph: { width: 32, height: 32, marginRight: 9, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, orangeGlyph: { backgroundColor: colors.orangeSoft }, sectionLabel: { color: colors.ink, fontSize: 15, fontWeight: '900' }, sectionCaption: { color: colors.muted, fontSize: 8, marginTop: 3 },
  menuCard: { paddingHorizontal: 12, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, menuRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.line }, subjectRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.line }, lastRow: { borderBottomWidth: 0 }, disabledRow: { opacity: 0.62 }, menuIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F3F5' }, selectedIcon: { backgroundColor: colors.primarySoft }, orangeMenuIcon: { backgroundColor: colors.orangeSoft }, rowCopy: { flex: 1, marginLeft: 10 }, rowTitle: { color: colors.ink, fontSize: 12, fontWeight: '800' }, rowMeta: { color: colors.muted, fontSize: 9, marginTop: 4 }, version: { color: colors.subtle, fontSize: 9, textAlign: 'center', marginTop: 20 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(17,24,39,0.30)' }, sheet: { maxHeight: '82%', padding: 18, paddingBottom: 28, borderTopLeftRadius: 18, borderTopRightRadius: 18, backgroundColor: colors.surface }, handle: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', backgroundColor: '#D0D5DD' }, sheetHeading: { minHeight: 66, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, sheetTitle: { color: colors.ink, fontSize: 20, fontWeight: '900' }, sheetSubtitle: { color: colors.muted, fontSize: 9, marginTop: 5 }, subjectList: { borderRadius: 14, paddingHorizontal: 12, backgroundColor: colors.canvas }, subjectEmpty: { padding: 24, borderRadius: 14, alignItems: 'center', backgroundColor: colors.canvas }, subjectEmptyTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, subjectEmptyText: { color: colors.muted, fontSize: 9, marginTop: 6 }, privacyRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line }, privacyTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, privacyText: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 5 },
});
