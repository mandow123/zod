import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { logoutCloudPay, type CloudPaySnapshot } from '../api';
import { AccountSecuritySheet } from '../AccountSecuritySheet';
import { Card, StatusPill } from '../components';
import { colors } from '../theme';
import { creditAmount } from '../format';

function PrivacySheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalSheet}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalEyebrow}>隐私说明</Text>
              <Text style={styles.modalTitle}>隐私与数据用途</Text>
            </View>
            <Pressable onPress={onClose} style={styles.closeButton}>
              <Ionicons name="close" size={23} color={colors.ink} />
            </Pressable>
          </View>
          {[
            ['公开市场数据', 'App 读取 CloudPay 的公开服务状态与已核验资源档案，不添加演示容量或价格。'],
            ['安全会话', '不保存密码或验证码；登录凭证存放在本机系统安全存储中，并由服务端轮换。'],
            ['设备权限', '当前版本不申请相机、麦克风、相册、位置或通讯录权限。'],
            ['交易边界', '卡时、订单和供应方操作必须由服务端确认，App 不在本地伪造成功状态。'],
          ].map(([title, body]) => (
            <View key={title} style={styles.privacyRow}>
              <View style={styles.privacyDot} />
              <View style={styles.privacyCopy}>
                <Text style={styles.privacyTitle}>{title}</Text>
                <Text style={styles.privacyBody}>{body}</Text>
              </View>
            </View>
          ))}
          <Pressable style={styles.modalDone} onPress={onClose}>
            <Text style={styles.modalDoneText}>我知道了</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

export function ProfileScreen({ snapshot, onSessionChanged, onLogin, onOpenPublish, onOpenCredits }: {
  snapshot: CloudPaySnapshot;
  onSessionChanged: () => void | Promise<void>;
  onLogin: () => void;
  onOpenPublish: () => void;
  onOpenCredits: () => void;
}) {
  const [privacyVisible, setPrivacyVisible] = useState(false);
  const [securityVisible, setSecurityVisible] = useState(false);
  const releaseProgress = snapshot.releaseReady
    ? '已就绪'
    : snapshot.releaseBlockers.length > 0 ? `${snapshot.releaseBlockers.length} 项待完成` : '核验中';
  const avatarText = snapshot.user?.displayName.trim().slice(0, 2).toUpperCase() || 'KC';
  const currentSubject = snapshot.subjects.find((subject) => subject.id === snapshot.currentSubjectId) ?? null;
  const sessionConfirmed = snapshot.sessionState === 'authenticated';
  const identityCaption = snapshot.authenticated
    ? `${snapshot.user?.phone ?? snapshot.user?.email ?? 'KAI 统一身份'} · ${sessionConfirmed ? '登录已确认' : '本机已保存登录，正在重新连接'}`
    : '登录后查看卡时账户与供应方身份';

  const accountAction = () => {
    if (!snapshot.authenticated) {
      onLogin();
      return;
    }
    Alert.alert('退出当前设备？', '其他已登录设备不会受到影响。', [
      { text: '取消', style: 'cancel' },
      {
        text: '安全退出', style: 'destructive', onPress: () => {
          void logoutCloudPay().then(onSessionChanged).catch(() => onSessionChanged());
        },
      },
    ]);
  };

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Card style={styles.identityCard}>
          <View style={styles.identityTop}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{avatarText}</Text>
              <View style={[styles.avatarState, { backgroundColor: sessionConfirmed ? '#22C55E' : snapshot.authenticated ? colors.amber : colors.subtle }]} />
            </View>
            <View style={styles.identityCopy}>
              <Text style={styles.identityLabel}>当前账户</Text>
              <Text style={styles.identityTitle}>{snapshot.user?.displayName ?? '访客模式'}</Text>
              <Text style={styles.identityCaption}>{identityCaption}</Text>
            </View>
          </View>
          <Pressable style={styles.loginButton} onPress={accountAction}>
            <Text style={styles.loginButtonText}>{snapshot.authenticated ? '安全退出当前设备' : '登录 CloudPay'}</Text>
            <Ionicons name={snapshot.authenticated ? 'log-out-outline' : 'arrow-forward'} size={17} color={colors.surface} />
          </Pressable>
        </Card>

        {snapshot.authenticated && currentSubject ? (
          <Card style={styles.subjectCard}>
            <View style={styles.subjectIcon}><Ionicons name={currentSubject.kind === 'organization' ? 'business-outline' : 'person-outline'} size={22} color={colors.primary} /></View>
            <View style={styles.subjectCopy}>
              <Text style={styles.subjectLabel}>当前交易主体</Text>
              <Text style={styles.subjectTitle}>{currentSubject.displayName}</Text>
              <Text style={styles.subjectMeta}>{currentSubject.kind === 'organization' ? '组织主体' : '个人主体'} · 同一账号下使用和提供算力</Text>
            </View>
          </Card>
        ) : null}

        {snapshot.authenticated && snapshot.creditBalance ? (
          <Pressable style={styles.creditCard} onPress={onOpenCredits} accessibilityRole="button" accessibilityLabel="打开 KAI 卡时账户">
            <View style={styles.creditTop}><View><Text style={styles.creditLabel}>KAI 卡时</Text><Text style={styles.creditValue}>{creditAmount(snapshot.creditBalance.available)}</Text></View><View style={styles.creditArrow}><Ionicons name="arrow-forward" size={18} color={colors.primary} /></View></View>
            <Text style={styles.creditCaption}>可用卡时 · 订单预留 {creditAmount(snapshot.creditBalance.reserved)}</Text>
          </Pressable>
        ) : null}

        <View style={styles.statusGrid}>
          <Card style={styles.statusCard}>
            <Ionicons name="cloud-done-outline" size={22} color={snapshot.online ? colors.green : colors.subtle} />
            <Text style={styles.statusValue}>{snapshot.online ? '在线' : '离线'}</Text>
            <Text style={styles.statusLabel}>数据服务</Text>
          </Card>
          <Card style={styles.statusCard}>
            <Ionicons name="wallet-outline" size={22} color={colors.blue} />
            <Text style={styles.statusValue}>{snapshot.creditBalance ? creditAmount(snapshot.creditBalance.reserved) : '—'}</Text>
            <Text style={styles.statusLabel}>订单预留</Text>
          </Card>
          <Card style={styles.statusCard}>
            <Ionicons name="storefront-outline" size={22} color={colors.amber} />
            <Text style={styles.statusValue}>{snapshot.creditBalance ? creditAmount(snapshot.creditBalance.supplierReceivable) : '—'}</Text>
            <Text style={styles.statusLabel}>待结算</Text>
          </Card>
        </View>

        <View style={styles.sectionHeading}>
          <Text style={styles.sectionTitle}>控制台</Text>
          <StatusPill online={snapshot.online} label={snapshot.online ? '实时连接' : '等待连接'} />
        </View>
        <Card style={styles.menuCard}>
          {[
            ['资源与挂牌', 'cube-outline' as const, onOpenPublish],
            ['账户与设备', 'phone-portrait-outline' as const, () => snapshot.authenticated ? setSecurityVisible(true) : onLogin()],
            ['隐私与数据', 'shield-checkmark-outline' as const, () => setPrivacyVisible(true)],
          ].map(([label, icon, action], index) => (
            <Pressable key={String(label)} style={[styles.menuRow, index === 2 && styles.menuRowLast]} onPress={action as () => void}>
              <View style={styles.menuIcon}>
                <Ionicons name={icon as 'cube-outline'} size={20} color={colors.primaryDark} />
              </View>
              <Text style={styles.menuLabel}>{String(label)}</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.subtle} />
            </Pressable>
          ))}
        </Card>

        <Text style={styles.version}>KAI CloudPay · 1.0.0</Text>
      </ScrollView>
      <PrivacySheet visible={privacyVisible} onClose={() => setPrivacyVisible(false)} />
      <AccountSecuritySheet
        visible={securityVisible}
        pushBackendReady={snapshot.pushReady}
        phoneReauthenticationAvailable={Boolean(snapshot.user?.phone)}
        onClose={() => setSecurityVisible(false)}
        onAccountChanged={onSessionChanged}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: 16, paddingBottom: 38 },
  identityCard: { padding: 18, marginTop: 6, backgroundColor: colors.surface },
  identityTop: { flexDirection: 'row', alignItems: 'center' },
  avatar: { width: 64, height: 64, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  avatarText: { color: colors.surface, fontSize: 21, fontWeight: '900' },
  avatarState: { position: 'absolute', right: -2, bottom: -2, width: 16, height: 16, borderRadius: 8, borderWidth: 3, borderColor: colors.surface },
  identityCopy: { flex: 1, marginLeft: 14 },
  identityLabel: { color: colors.primary, fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },
  identityTitle: { color: colors.ink, fontSize: 20, fontWeight: '900', marginTop: 4 },
  identityCaption: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 3 },
  loginButton: { minHeight: 46, marginTop: 18, borderRadius: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.primary },
  loginButtonText: { color: colors.surface, fontSize: 14, fontWeight: '800' },
  subjectCard: { minHeight: 82, marginTop: 12, padding: 14, flexDirection: 'row', alignItems: 'center' },
  subjectIcon: { width: 50, height: 50, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft },
  subjectCopy: { flex: 1, marginLeft: 12 }, subjectLabel: { color: colors.primary, fontSize: 9, fontWeight: '900', letterSpacing: 1.1 }, subjectTitle: { color: colors.ink, fontSize: 16, fontWeight: '900', marginTop: 3 }, subjectMeta: { color: colors.muted, fontSize: 10, marginTop: 4 },
  creditCard: { minHeight: 128, marginTop: 12, padding: 18, borderWidth: 1, borderColor: '#D5E5FA', borderRadius: 24, backgroundColor: colors.surface },
  creditTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, creditLabel: { color: colors.primary, fontSize: 10, fontWeight: '900' }, creditValue: { color: colors.primaryDark, fontSize: 34, fontWeight: '900', marginTop: 5 }, creditArrow: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, creditCaption: { color: colors.muted, fontSize: 10, marginTop: 7 },
  statusGrid: { flexDirection: 'row', gap: 9, marginVertical: 18 },
  statusCard: { flex: 1, minHeight: 118, padding: 13, justifyContent: 'space-between' },
  statusValue: { color: colors.ink, fontSize: 15, fontWeight: '900', marginTop: 13 },
  statusLabel: { color: colors.muted, fontSize: 10, marginTop: 3 },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionTitle: { color: colors.ink, fontSize: 21, fontWeight: '800' },
  menuCard: { paddingHorizontal: 15 },
  menuRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.line },
  menuRowLast: { borderBottomWidth: 0 },
  menuIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft },
  menuLabel: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '700', marginLeft: 12 },
  version: { color: colors.subtle, fontSize: 11, textAlign: 'center', marginTop: 20 },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.35)' },
  modalSheet: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 30, borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: colors.surface },
  modalHandle: { width: 42, height: 5, borderRadius: 3, alignSelf: 'center', backgroundColor: '#D6DEE8', marginBottom: 16 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  modalEyebrow: { color: colors.primary, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  modalTitle: { color: colors.ink, fontSize: 23, fontWeight: '900', marginTop: 3 },
  closeButton: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas },
  privacyRow: { flexDirection: 'row', paddingVertical: 11 },
  privacyDot: { width: 9, height: 9, borderRadius: 5, marginTop: 5, backgroundColor: colors.primary },
  privacyCopy: { flex: 1, marginLeft: 11 },
  privacyTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  privacyBody: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  modalDone: { minHeight: 50, marginTop: 13, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  modalDoneText: { color: colors.surface, fontSize: 15, fontWeight: '800' },
});
