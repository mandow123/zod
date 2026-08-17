import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { logoutCloudPay, type CloudPaySnapshot } from '../api';
import { AccountSecuritySheet } from '../AccountSecuritySheet';
import type { WorkMode } from '../components';
import { brand, colors } from '../theme';

function PrivacySheet({ visible, onClose }: Readonly<{ visible: boolean; onClose: () => void }>) {
  return <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}><View style={styles.backdrop}><View style={styles.sheet}><View style={styles.handle} /><View style={styles.sheetHeading}><Text style={styles.sheetTitle}>隐私与数据</Text><Pressable onPress={onClose}><Ionicons name="close" size={22} color={colors.ink} /></Pressable></View>{[
    ['公开市场数据', 'App 只读取已审核资源与挂牌。'],
    ['安全会话', '凭证保存在手机系统安全存储中。'],
    ['交易边界', '卡时、订单和供给操作必须由服务端确认。'],
  ].map(([title, body]) => <View key={title} style={styles.privacyRow}><Text style={styles.privacyTitle}>{title}</Text><Text style={styles.privacyText}>{body}</Text></View>)}</View></View></Modal>;
}

type Props = Readonly<{
  snapshot: CloudPaySnapshot;
  mode: WorkMode;
  onModeChange: (mode: WorkMode) => void;
  onSelectSubject: (subjectId: string) => void;
  onSessionChanged: () => void | Promise<void>;
  onLogin: () => void;
  onOpenPublish: () => void;
  onOpenCredits: () => void;
  onOpenOrders: () => void;
  onOpenAssets: () => void;
  onOpenMessages: () => void;
}>;

export function ProfileScreen({ snapshot, mode, onModeChange, onSelectSubject, onSessionChanged, onLogin, onOpenPublish, onOpenCredits, onOpenOrders, onOpenAssets, onOpenMessages }: Props) {
  const [privacyVisible, setPrivacyVisible] = useState(false);
  const [securityVisible, setSecurityVisible] = useState(false);
  const currentSubject = snapshot.subjects.find((subject) => subject.id === snapshot.currentSubjectId) ?? null;
  const accountAction = () => {
    if (!snapshot.authenticated) { onLogin(); return; }
    Alert.alert('退出当前设备？', '其他已登录设备不会受影响。', [{ text: '取消', style: 'cancel' }, { text: '安全退出', style: 'destructive', onPress: () => { void logoutCloudPay().then(onSessionChanged).catch(() => onSessionChanged()); } }]);
  };

  return <View style={styles.root}><ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
    <Text style={styles.pageTitle}>我的</Text>
    <View style={styles.accountCard}><View style={styles.avatar}><Text style={styles.avatarText}>{snapshot.user?.displayName.trim().slice(0, 2).toUpperCase() || 'ZD'}</Text></View><View style={styles.accountCopy}><Text style={styles.accountName}>{snapshot.user?.displayName ?? '访客模式'}</Text><Text style={styles.accountMeta}>{snapshot.user?.phone ?? snapshot.user?.email ?? '登录后查看账号资产'}</Text></View><Pressable onPress={accountAction}><Text style={styles.textAction}>{snapshot.authenticated ? '退出' : '登录 Zod'}</Text></Pressable></View>

    <Text style={styles.sectionLabel}>当前视角</Text>
    <View style={styles.modeSwitch}><Pressable onPress={() => onModeChange('consumer')} style={[styles.modeItem, mode === 'consumer' && styles.modeActive]}><Ionicons name="flash-outline" size={17} color={mode === 'consumer' ? colors.ink : colors.muted} /><Text style={[styles.modeText, mode === 'consumer' && styles.modeTextActive]}>使用算力</Text></Pressable><Pressable onPress={() => onModeChange('provider')} style={[styles.modeItem, mode === 'provider' && styles.modeActive]}><Ionicons name="server-outline" size={17} color={mode === 'provider' ? colors.ink : colors.muted} /><Text style={[styles.modeText, mode === 'provider' && styles.modeTextActive]}>提供算力</Text></Pressable></View>
    <Text style={styles.modeHint}>首页会随视角切换，资产和账号记录不会变。</Text>

    {snapshot.authenticated && snapshot.subjects.length ? <><Text style={styles.sectionLabel}>交易主体</Text><View style={styles.menuCard}>{snapshot.subjects.map((subject, index) => <Pressable key={subject.id} onPress={() => onSelectSubject(subject.id)} style={[styles.subjectRow, index === snapshot.subjects.length - 1 && styles.lastRow]}><View style={styles.menuIcon}><Ionicons name={subject.kind === 'organization' ? 'business-outline' : 'person-outline'} size={18} color={colors.ink} /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{subject.displayName}</Text><Text style={styles.rowMeta}>{subject.kind === 'organization' ? '组织主体' : '个人主体'} · {subject.role}</Text></View>{subject.id === currentSubject?.id ? <Ionicons name="checkmark-circle" size={19} color={colors.primary} /> : <Ionicons name="chevron-forward" size={16} color={colors.subtle} />}</Pressable>)}</View></> : null}

    <Text style={styles.sectionLabel}>账号与服务</Text>
    <View style={styles.menuCard}>
      <Menu icon="receipt-outline" label="订单" meta="购买、交付、验收与售后" onPress={onOpenOrders} />
      <Menu icon="wallet-outline" label="费用与结算" meta="卡时、预留、待结算和明细" onPress={onOpenCredits} />
      <Menu icon="shield-checkmark-outline" label="认证与供给资格" meta={snapshot.providerWorkspace?.supplier?.status ?? '尚未开通'} onPress={onOpenPublish} />
      <Menu icon="cube-outline" label="我的资产" meta="购买与提供记录" onPress={onOpenAssets} />
      <Menu icon="chatbubble-ellipses-outline" label="客服与帮助" meta={`通过消息联系 ${brand.name}`} onPress={onOpenMessages} />
      <Menu icon="settings-outline" label="账号设置" meta="安全、设备与隐私" onPress={() => snapshot.authenticated ? setSecurityVisible(true) : onLogin()} />
      <Menu icon="document-text-outline" label="隐私与数据" onPress={() => setPrivacyVisible(true)} last />
    </View>
    <Text style={styles.version}>{brand.name} · 1.0.0</Text>
  </ScrollView><PrivacySheet visible={privacyVisible} onClose={() => setPrivacyVisible(false)} /><AccountSecuritySheet visible={securityVisible} pushBackendReady={snapshot.pushReady} phoneReauthenticationAvailable={Boolean(snapshot.user?.phone)} onClose={() => setSecurityVisible(false)} onAccountChanged={onSessionChanged} /></View>;
}

function Menu({ icon, label, meta, onPress, last = false }: Readonly<{ icon: 'receipt-outline' | 'wallet-outline' | 'shield-checkmark-outline' | 'cube-outline' | 'chatbubble-ellipses-outline' | 'settings-outline' | 'document-text-outline'; label: string; meta?: string; onPress: () => void; last?: boolean }>) { return <Pressable onPress={onPress} style={[styles.menuRow, last && styles.lastRow]}><View style={styles.menuIcon}><Ionicons name={icon} size={18} color={colors.ink} /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{label}</Text>{meta ? <Text style={styles.rowMeta}>{meta}</Text> : null}</View><Ionicons name="chevron-forward" size={16} color={colors.subtle} /></Pressable>; }

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 16, paddingBottom: 34 }, pageTitle: { color: colors.ink, fontSize: 25, fontWeight: '900', marginBottom: 12 }, accountCard: { minHeight: 76, paddingHorizontal: 13, borderRadius: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, avatar: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E8F2FF' }, avatarText: { color: colors.ink, fontSize: 14, fontWeight: '900' }, accountCopy: { flex: 1, marginLeft: 11 }, accountName: { color: colors.ink, fontSize: 15, fontWeight: '900' }, accountMeta: { color: colors.muted, fontSize: 9, marginTop: 4 }, textAction: { color: colors.primary, fontSize: 11, fontWeight: '800' },
  sectionLabel: { color: colors.ink, fontSize: 15, fontWeight: '900', marginTop: 20, marginBottom: 9 }, modeSwitch: { flexDirection: 'row', padding: 3, borderRadius: 10, backgroundColor: '#EDEFF2' }, modeItem: { flex: 1, minHeight: 42, borderRadius: 8, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center' }, modeActive: { backgroundColor: colors.surface }, modeText: { color: colors.muted, fontSize: 12, fontWeight: '700' }, modeTextActive: { color: colors.ink, fontWeight: '900' }, modeHint: { color: colors.muted, fontSize: 9, lineHeight: 15, marginTop: 7 },
  menuCard: { paddingHorizontal: 12, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, menuRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.line }, subjectRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.line }, lastRow: { borderBottomWidth: 0 }, menuIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F3F5' }, rowCopy: { flex: 1, marginLeft: 10 }, rowTitle: { color: colors.ink, fontSize: 12, fontWeight: '800' }, rowMeta: { color: colors.muted, fontSize: 9, marginTop: 4 }, version: { color: colors.subtle, fontSize: 9, textAlign: 'center', marginTop: 20 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(17,24,39,0.30)' }, sheet: { padding: 18, paddingBottom: 28, borderTopLeftRadius: 16, borderTopRightRadius: 16, backgroundColor: colors.surface }, handle: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', backgroundColor: '#D0D5DD' }, sheetHeading: { minHeight: 55, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, sheetTitle: { color: colors.ink, fontSize: 20, fontWeight: '900' }, privacyRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line }, privacyTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, privacyText: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 5 },
});
