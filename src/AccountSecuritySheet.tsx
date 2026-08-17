import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  cancelAccountDeletion,
  disablePushNotifications,
  enablePushNotifications,
  listAccountSessions,
  loadAccountDeletion,
  loadPushStatus,
  PHONE_REAUTHENTICATION_ENABLED,
  pushProjectId,
  requestAccountDeletion,
  requestDeletionCode,
  revokeAccountSession,
  verifyDeletionCode,
  type AccountDeletion,
  type AccountSession,
} from './account-security';
import { colors } from './theme';

function timeLabel(value: string) {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(time);
}

function sessionTitle(session: AccountSession) {
  const platform = session.device.platform === 'android' ? 'Android 设备' : 'iPhone';
  return session.current ? `本机 · ${platform}` : platform;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}

export function AccountSecuritySheet({
  visible,
  pushBackendReady,
  phoneReauthenticationAvailable,
  onClose,
  onAccountChanged,
}: Readonly<{
  visible: boolean;
  pushBackendReady: boolean;
  phoneReauthenticationAvailable: boolean;
  onClose: () => void;
  onAccountChanged: () => void | Promise<void>;
}>) {
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [deletion, setDeletion] = useState<AccountDeletion | null>(null);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletionOpen, setDeletionOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    const [sessionResult, deletionResult, pushResult] = await Promise.allSettled([
      listAccountSessions(), loadAccountDeletion(), loadPushStatus(),
    ]);
    if (sessionResult.status === 'fulfilled') setSessions(sessionResult.value);
    if (deletionResult.status === 'fulfilled') setDeletion(deletionResult.value);
    if (pushResult.status === 'fulfilled') setPushEnabled(pushResult.value.pushEnabled);
    const failure = [sessionResult, deletionResult, pushResult].find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') setError(messageOf(failure.reason));
    setLoading(false);
  };

  useEffect(() => {
    if (visible) void load();
  }, [visible]);

  const revoke = (session: AccountSession) => {
    Alert.alert('退出这台设备？', `${sessionTitle(session)}将立即失去登录状态。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '确认退出', style: 'destructive', onPress: () => {
          setBusyAction(session.id);
          setError(null);
          void revokeAccountSession(session.id)
            .then(() => setSessions((items) => items.filter((item) => item.id !== session.id)))
            .catch((failure: unknown) => setError(messageOf(failure)))
            .finally(() => setBusyAction(null));
        },
      },
    ]);
  };

  const togglePush = async (next: boolean) => {
    if (busyAction) return;
    setBusyAction('push');
    setError(null);
    try {
      if (next) await enablePushNotifications();
      else await disablePushNotifications();
      setPushEnabled(next);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusyAction(null);
    }
  };

  const sendDeletionCode = async () => {
    setBusyAction('deletion-code');
    setError(null);
    try {
      const challenge = await requestDeletionCode(phone.trim());
      setChallengeId(challenge.challengeId);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusyAction(null);
    }
  };

  const submitDeletion = () => {
    if (!challengeId) return;
    Alert.alert(
      '申请注销账户？',
      '验证通过后进入 7 天冷静期。冷静期内可撤回；未结订单、退款或争议会依法保留到处理完成。',
      [
        { text: '暂不注销', style: 'cancel' },
        {
          text: '验证并申请', style: 'destructive', onPress: () => {
            setBusyAction('deletion-submit');
            setError(null);
            void verifyDeletionCode(phone.trim(), challengeId, code.trim())
              .then((token) => requestAccountDeletion(token, reason))
              .then(async (request) => {
                setDeletion(request);
                setDeletionOpen(false);
                setChallengeId(null);
                setCode('');
                await onAccountChanged();
              })
              .catch((failure: unknown) => setError(messageOf(failure)))
              .finally(() => setBusyAction(null));
          },
        },
      ],
    );
  };

  const cancelDeletion = () => {
    Alert.alert('撤回注销申请？', '账户会恢复为正常状态，现有订单和消息不受影响。', [
      { text: '保留申请', style: 'cancel' },
      {
        text: '确认撤回', onPress: () => {
          setBusyAction('deletion-cancel');
          setError(null);
          void cancelAccountDeletion()
            .then(async () => { setDeletion(null); await onAccountChanged(); })
            .catch((failure: unknown) => setError(messageOf(failure)))
            .finally(() => setBusyAction(null));
        },
      },
    ]);
  };

  const close = () => {
    if (busyAction) return;
    setDeletionOpen(false);
    setChallengeId(null);
    setCode('');
    setError(null);
    onClose();
  };
  const pushClientReady = Boolean(pushProjectId());
  const canEnablePush = pushBackendReady && pushClientReady;
  const canUsePhoneReauthentication = PHONE_REAUTHENTICATION_ENABLED && phoneReauthenticationAvailable;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View>
              <Text style={styles.eyebrow}>ACCOUNT CONTROL</Text>
              <Text style={styles.title}>账户与设备</Text>
            </View>
            <Pressable accessibilityLabel="关闭" onPress={close} style={styles.closeButton}>
              <Ionicons name="close" size={23} color={colors.ink} />
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {loading ? (
              <View style={styles.loadingRow}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>正在核对服务端状态…</Text></View>
            ) : null}
            {error ? (
              <Pressable style={styles.errorBox} onPress={() => void load()}>
                <Ionicons name="alert-circle-outline" size={19} color={colors.red} />
                <Text style={styles.errorText}>{error}</Text>
                <Text style={styles.retryText}>重试</Text>
              </Pressable>
            ) : null}

            <Text style={styles.sectionTitle}>登录设备</Text>
            <View style={styles.group}>
              {sessions.length ? sessions.map((session, index) => (
                <View key={session.id} style={[styles.row, index === sessions.length - 1 && styles.rowLast]}>
                  <View style={styles.rowIcon}>
                    <Ionicons name={session.device.platform === 'android' ? 'logo-android' : 'phone-portrait-outline'} size={20} color={colors.primaryDark} />
                  </View>
                  <View style={styles.rowCopy}>
                    <View style={styles.rowTitleLine}>
                      <Text style={styles.rowTitle}>{sessionTitle(session)}</Text>
                      {session.current ? <Text style={styles.currentTag}>当前</Text> : null}
                    </View>
                    <Text style={styles.rowCaption}>App {session.device.appVersion} · 最近活动 {timeLabel(session.lastSeenAt)}</Text>
                  </View>
                  {!session.current ? (
                    <Pressable disabled={Boolean(busyAction)} onPress={() => revoke(session)} style={styles.textAction}>
                      {busyAction === session.id ? <ActivityIndicator size="small" color={colors.red} /> : <Text style={styles.dangerText}>退出</Text>}
                    </Pressable>
                  ) : null}
                </View>
              )) : <Text style={styles.emptyText}>暂未读取到设备信息。</Text>}
            </View>

            <Text style={styles.sectionTitle}>消息通知</Text>
            <View style={styles.group}>
              <View style={styles.row}>
                <View style={[styles.rowIcon, styles.notificationIcon]}>
                  <Ionicons name="notifications-outline" size={20} color={colors.blue} />
                </View>
                <View style={styles.rowCopy}>
                  <Text style={styles.rowTitle}>订单与账户动态</Text>
                  <Text style={styles.rowCaption}>{canEnablePush ? '仅在你主动开启后申请系统权限。' : '正式推送项目尚未绑定，应用内消息仍可正常查看。'}</Text>
                </View>
                {busyAction === 'push' ? <ActivityIndicator color={colors.primary} /> : (
                  <Switch
                    value={pushEnabled}
                    disabled={Boolean(busyAction) || (!pushEnabled && !canEnablePush)}
                    onValueChange={(value) => void togglePush(value)}
                    trackColor={{ false: '#D8E0DB', true: '#8BC79B' }}
                    thumbColor={pushEnabled ? colors.green : '#F8FAF9'}
                  />
                )}
              </View>
              <View style={[styles.row, styles.rowLast]}>
                <View style={styles.rowIcon}>
                  <Ionicons name="mail-unread-outline" size={20} color={colors.primaryDark} />
                </View>
                <View style={styles.rowCopy}>
                  <Text style={styles.rowTitle}>应用内消息</Text>
                  <Text style={styles.rowCaption}>永久开启。推送失败也不会丢失资源审核、卡时和交付记录。</Text>
                </View>
                <Ionicons name="checkmark-circle" size={22} color={colors.green} />
              </View>
            </View>

            <Text style={styles.sectionTitle}>账户注销</Text>
            {deletion ? (
              <View style={styles.deletionCard}>
                <View style={styles.deletionHeading}>
                  <Ionicons name={deletion.status === 'blocked_by_legal_hold' ? 'shield-outline' : 'hourglass-outline'} size={22} color={colors.amber} />
                  <Text style={styles.deletionTitle}>{deletion.status === 'blocked_by_legal_hold' ? '正在等待业务结清' : '已进入注销冷静期'}</Text>
                </View>
                <Text style={styles.deletionBody}>{deletion.legalHoldReason ?? `可在 ${timeLabel(deletion.coolingOffUntil)} 前撤回。到期后服务端按规则执行匿名化。`}</Text>
                {['requested', 'cooling_off', 'blocked_by_legal_hold'].includes(deletion.status) ? (
                  <Pressable disabled={Boolean(busyAction)} onPress={cancelDeletion} style={styles.cancelDeletionButton}>
                    {busyAction === 'deletion-cancel' ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.cancelDeletionText}>撤回注销申请</Text>}
                  </Pressable>
                ) : null}
              </View>
            ) : !canUsePhoneReauthentication ? (
              <View style={styles.group}>
                <View style={[styles.row, styles.rowLast]}>
                  <View style={[styles.rowIcon, styles.dangerIcon]}><Ionicons name="lock-closed-outline" size={20} color={colors.red} /></View>
                  <View style={styles.rowCopy}>
                    <Text style={styles.rowTitle}>统一身份账户注销暂未开放</Text>
                    <Text style={styles.rowCaption}>需要由 KAI 统一身份再次确认本人后才能申请；当前不会降级使用其他手机号短信验证。</Text>
                  </View>
                </View>
              </View>
            ) : (
              <View style={styles.group}>
                {!deletionOpen ? (
                  <Pressable onPress={() => setDeletionOpen(true)} style={[styles.row, styles.rowLast]}>
                    <View style={[styles.rowIcon, styles.dangerIcon]}><Ionicons name="person-remove-outline" size={20} color={colors.red} /></View>
                    <View style={styles.rowCopy}>
                      <Text style={styles.rowTitle}>申请注销 Zod 账户</Text>
                      <Text style={styles.rowCaption}>需短信二次确认，并提供 7 天可撤回冷静期。</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.subtle} />
                  </Pressable>
                ) : (
                  <View style={styles.deletionForm}>
                    <Text style={styles.formHint}>为保护资产，请输入账户完整手机号并完成短信验证。</Text>
                    <TextInput
                      value={phone}
                      onChangeText={(value) => setPhone(value.replace(/\D/gu, '').slice(0, 20))}
                      editable={!challengeId && !busyAction}
                      keyboardType="phone-pad"
                      placeholder="账户手机号"
                      placeholderTextColor={colors.subtle}
                      style={styles.input}
                    />
                    {challengeId ? (
                      <>
                        <TextInput
                          value={code}
                          onChangeText={(value) => setCode(value.replace(/\D/gu, '').slice(0, 6))}
                          editable={!busyAction}
                          keyboardType="number-pad"
                          placeholder="6 位短信验证码"
                          placeholderTextColor={colors.subtle}
                          style={styles.input}
                          maxLength={6}
                        />
                        <TextInput
                          value={reason}
                          onChangeText={(value) => setReason(value.slice(0, 1_000))}
                          editable={!busyAction}
                          placeholder="注销原因（选填）"
                          placeholderTextColor={colors.subtle}
                          style={styles.input}
                        />
                      </>
                    ) : null}
                    <View style={styles.formActions}>
                      <Pressable disabled={Boolean(busyAction)} onPress={() => { setDeletionOpen(false); setChallengeId(null); setCode(''); }} style={styles.secondaryButton}>
                        <Text style={styles.secondaryText}>取消</Text>
                      </Pressable>
                      <Pressable
                        disabled={Boolean(busyAction) || (challengeId ? !/^\d{6}$/u.test(code) : !/^\d{11,20}$/u.test(phone))}
                        onPress={challengeId ? submitDeletion : () => void sendDeletionCode()}
                        style={styles.dangerButton}
                      >
                        {busyAction?.startsWith('deletion') ? <ActivityIndicator color={colors.surface} /> : (
                          <Text style={styles.dangerButtonText}>{challengeId ? '验证并申请' : '获取验证码'}</Text>
                        )}
                      </Pressable>
                    </View>
                  </View>
                )}
              </View>
            )}
            <Text style={styles.footerNote}>Zod 不允许客户端自行宣告退出、注销或推送成功，所有状态均由服务端确认并留痕。</Text>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.35)' },
  sheet: { maxHeight: '92%', paddingHorizontal: 18, paddingTop: 10, paddingBottom: 28, borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: colors.canvas },
  handle: { width: 42, height: 5, borderRadius: 3, alignSelf: 'center', backgroundColor: '#D6DEE8', marginBottom: 15 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 },
  eyebrow: { color: colors.primary, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  title: { color: colors.ink, fontSize: 24, fontWeight: '900', marginTop: 3 },
  closeButton: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  loadingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, paddingVertical: 18 },
  loadingText: { color: colors.muted, fontSize: 12 },
  errorBox: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 15, backgroundColor: '#FFF0F0', marginTop: 10 },
  errorText: { flex: 1, color: colors.red, fontSize: 12, lineHeight: 17, marginHorizontal: 8 },
  retryText: { color: colors.red, fontSize: 12, fontWeight: '800' },
  sectionTitle: { color: colors.ink, fontSize: 16, fontWeight: '900', marginTop: 20, marginBottom: 9 },
  group: { borderWidth: 1, borderColor: colors.line, borderRadius: 20, backgroundColor: colors.surface, overflow: 'hidden' },
  row: { minHeight: 76, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.line },
  rowLast: { borderBottomWidth: 0 },
  rowIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft },
  notificationIcon: { backgroundColor: colors.blueSoft },
  dangerIcon: { backgroundColor: '#FFF0F0' },
  rowCopy: { flex: 1, marginHorizontal: 11 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  rowTitle: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  rowCaption: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  currentTag: { color: colors.green, fontSize: 9, fontWeight: '900', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 99, backgroundColor: colors.greenSoft },
  textAction: { minWidth: 42, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  dangerText: { color: colors.red, fontSize: 12, fontWeight: '800' },
  emptyText: { color: colors.muted, fontSize: 12, padding: 18 },
  deletionCard: { padding: 16, borderRadius: 20, borderWidth: 1, borderColor: '#F4D39A', backgroundColor: '#FFF8E8' },
  deletionHeading: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  deletionTitle: { color: colors.ink, fontSize: 15, fontWeight: '900' },
  deletionBody: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 10 },
  cancelDeletionButton: { minHeight: 44, marginTop: 14, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  cancelDeletionText: { color: colors.primary, fontSize: 13, fontWeight: '800' },
  deletionForm: { padding: 15 },
  formHint: { color: colors.muted, fontSize: 12, lineHeight: 18, marginBottom: 8 },
  input: { minHeight: 48, paddingHorizontal: 14, marginTop: 9, borderWidth: 1, borderColor: colors.line, borderRadius: 14, color: colors.ink, backgroundColor: colors.surface, fontSize: 14 },
  formActions: { flexDirection: 'row', gap: 10, marginTop: 13 },
  secondaryButton: { flex: 1, minHeight: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas },
  secondaryText: { color: colors.muted, fontSize: 13, fontWeight: '800' },
  dangerButton: { flex: 1.5, minHeight: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.red },
  dangerButtonText: { color: colors.surface, fontSize: 13, fontWeight: '800' },
  footerNote: { color: colors.subtle, fontSize: 10, lineHeight: 16, textAlign: 'center', marginTop: 18, paddingHorizontal: 14 },
});
