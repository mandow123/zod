import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { loadLegalDocuments, type LegalDocuments } from './api';
import { requestLoginCode, verifyLoginCode } from './local-e2e-login';
import { loadLocalE2EOtp } from './local-e2e-runtime';
import { colors } from './theme';

type Mode = 'login' | 'register';

type AuthSheetProps = Readonly<{
  visible: boolean;
  onClose: () => void;
  onSignedIn: () => void | Promise<void>;
  kaiAuthBusy?: boolean;
  kaiAuthError?: string | null;
  onKaiAuthStart?: (documents: LegalDocuments) => void | Promise<void>;
}>;

export function AuthSheet({ visible, onClose, onSignedIn }: AuthSheetProps) {
  const [mode, setMode] = useState<Mode>('login');
  const [phone, setPhone] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<LegalDocuments | null>(null);
  const [legalError, setLegalError] = useState<string | null>(null);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localCodeFilled, setLocalCodeFilled] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setMode('login');
    setPhone('');
    setDisplayName('');
    setCode('');
    setChallengeId(null);
    setConsented(false);
    setError(null);
    setLocalCodeFilled(false);
    setLegalError(null);
    void loadLegalDocuments()
      .then(setDocuments)
      .catch((reason: unknown) => setLegalError(reason instanceof Error ? reason.message : '暂时无法读取协议。'));
  }, [visible]);

  const openDocument = async (url: string | null | undefined) => {
    if (!url || !/^https:\/\//u.test(url)) {
      setError('协议地址尚未配置。');
      return;
    }
    await Linking.openURL(url);
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setCode('');
    setChallengeId(null);
    setError(null);
    setLocalCodeFilled(false);
  };

  const requestCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const challenge = await requestLoginCode(phone.trim(), mode);
      setChallengeId(challenge.challengeId);
      const localCode = await loadLocalE2EOtp(phone);
      if (localCode) {
        setCode(localCode);
        setLocalCodeFilled(true);
      } else {
        setError('本机验收码没有生成，请换号码后重试。');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '本机验证码获取失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!challengeId) return;
    if (mode === 'register' && (!documents || !consented)) {
      setError(documents ? '请先阅读并同意用户协议和隐私政策。' : legalError ?? '暂时无法读取协议，请稍后重试。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await verifyLoginCode({
        phone: phone.trim(), challengeId, code: code.trim(), purpose: mode,
        ...(mode === 'register' ? { displayName, documents: documents ?? undefined } : {}),
      });
      await onSignedIn();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '验证失败，请重试。');
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    setPhone('');
    setDisplayName('');
    setCode('');
    setChallengeId(null);
    setConsented(false);
    setError(null);
    onClose();
  };

  const canRequest = /^\d{11,20}$/u.test(phone.trim()) && !busy;
  const canVerify = Boolean(challengeId && /^\d{6}$/u.test(code.trim())
    && (mode === 'login' || (displayName.trim().length > 0 && consented && documents)) && !busy);
  const visibleError = error ?? (mode === 'register' ? legalError : null);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View nativeID="KAI_CLOUD_LOCAL_E2E_AUTH_V1" style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View>
              <Text style={styles.eyebrow}>本机验收</Text>
              <Text style={styles.title}>进入 Zod</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={close} style={styles.closeButton}>
              <Ionicons name="close" size={23} color={colors.ink} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.formContent} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <View style={styles.segment}>
              {(['login', 'register'] as const).map((item) => (
                <Pressable key={item} onPress={() => switchMode(item)} style={[styles.segmentItem, mode === item && styles.segmentItemActive]}>
                  <Text style={[styles.segmentText, mode === item && styles.segmentTextActive]}>{item === 'login' ? '登录' : '注册'}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.label}>手机号</Text>
            <View style={styles.inputRow}>
              <Text style={styles.countryCode}>+86</Text>
              <TextInput
                value={phone}
                onChangeText={(value) => setPhone(value.replace(/\D/gu, '').slice(0, 20))}
                editable={!challengeId && !busy}
                keyboardType="phone-pad"
                textContentType="telephoneNumber"
                placeholder="请输入手机号"
                placeholderTextColor={colors.subtle}
                style={styles.input}
              />
            </View>

            {!challengeId ? (
              <View style={styles.previewNote}>
                <Ionicons name="flask-outline" size={17} color={colors.primary} />
                <Text style={styles.previewNoteText}>本地预览不会发送短信，验证码会在这里自动填入。</Text>
              </View>
            ) : null}

            {mode === 'register' ? (
              <>
                <Text style={styles.label}>账户名称</Text>
                <View style={styles.inputRow}>
                  <Ionicons name="person-outline" size={19} color={colors.muted} />
                  <TextInput
                    value={displayName}
                    onChangeText={(value) => setDisplayName(value.slice(0, 80))}
                    editable={!busy}
                    placeholder="例如：KAI 算力团队"
                    placeholderTextColor={colors.subtle}
                    style={styles.input}
                  />
                </View>
              </>
            ) : null}

            {challengeId ? (
              <>
                <Text style={styles.label}>本机验证码</Text>
                <View style={styles.inputRow}>
                  <Ionicons name="keypad-outline" size={19} color={colors.muted} />
                  <TextInput
                    value={code}
                    onChangeText={(value) => setCode(value.replace(/\D/gu, '').slice(0, 6))}
                    editable={!busy}
                    keyboardType="number-pad"
                    textContentType="oneTimeCode"
                    placeholder="6 位验证码"
                    placeholderTextColor={colors.subtle}
                    style={styles.input}
                    maxLength={6}
                  />
                </View>
                <View style={styles.sentLine}>
                  <Ionicons name="checkmark-circle" size={16} color={colors.green} />
                  <Text style={styles.sentText}>{localCodeFilled ? '本机验收码已填入，直接验证即可。' : '正在读取本机验收码。'}</Text>
                  <Pressable onPress={() => { setChallengeId(null); setCode(''); setLocalCodeFilled(false); }} hitSlop={8}>
                    <Text style={styles.changePhone}>换号码</Text>
                  </Pressable>
                </View>
              </>
            ) : null}

            {mode === 'register' ? (
              <Pressable style={styles.consentRow} onPress={() => setConsented((value) => !value)}>
                <View style={[styles.checkbox, consented && styles.checkboxChecked]}>
                  {consented ? <Ionicons name="checkmark" size={15} color={colors.surface} /> : null}
                </View>
                <Text style={styles.consentText}>我已阅读并同意</Text>
                <Pressable onPress={() => void openDocument(documents?.terms.url)} hitSlop={6}>
                  <Text style={styles.documentLink}>用户协议</Text>
                </Pressable>
                <Text style={styles.consentText}>和</Text>
                <Pressable onPress={() => void openDocument(documents?.privacy.url)} hitSlop={6}>
                  <Text style={styles.documentLink}>隐私政策</Text>
                </Pressable>
              </Pressable>
            ) : null}

            {visibleError ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle-outline" size={18} color={colors.red} />
                <Text style={styles.errorText}>{visibleError}</Text>
              </View>
            ) : null}

            <View style={styles.securityNote}>
              <Ionicons name="shield-checkmark-outline" size={18} color={colors.primary} />
              <Text style={styles.securityText}>这是本机验收入口，只连接本地测试服务；正式 App 使用 KAI 统一身份登录。</Text>
            </View>
          </ScrollView>

          <View style={styles.actionArea}>
            <Pressable
              disabled={challengeId ? !canVerify : !canRequest}
              onPress={challengeId ? () => void verify() : () => void requestCode()}
              style={[styles.primaryButton, (challengeId ? !canVerify : !canRequest) && styles.primaryButtonDisabled]}
            >
              {busy ? <ActivityIndicator color={colors.surface} /> : (
                <>
                  <Text style={styles.primaryText}>{challengeId
                    ? (mode === 'login' ? '验证并登录' : '验证并创建账户')
                    : '获取本机验证码'}</Text>
                  <Ionicons name="arrow-forward" size={18} color={colors.surface} />
                </>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.38)' },
  sheet: { maxHeight: '92%', paddingHorizontal: 20, paddingTop: 10, paddingBottom: 28, borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: colors.surface },
  handle: { width: 42, height: 5, borderRadius: 3, alignSelf: 'center', backgroundColor: '#D6DEE8', marginBottom: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
  formContent: { paddingBottom: 8 },
  eyebrow: { color: colors.primary, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  title: { color: colors.ink, fontSize: 25, fontWeight: '900', marginTop: 3 },
  closeButton: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas },
  segment: { flexDirection: 'row', padding: 4, marginBottom: 18, borderRadius: 16, backgroundColor: colors.canvas },
  segmentItem: { flex: 1, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 13 },
  segmentItemActive: { backgroundColor: colors.surface },
  segmentText: { color: colors.muted, fontSize: 14, fontWeight: '700' },
  segmentTextActive: { color: colors.primary, fontWeight: '900' },
  label: { color: colors.ink, fontSize: 12, fontWeight: '800', marginBottom: 7, marginTop: 3 },
  inputRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 15, marginBottom: 14, borderWidth: 1, borderColor: colors.line, borderRadius: 17, backgroundColor: colors.surface },
  countryCode: { color: colors.ink, fontSize: 15, fontWeight: '800', paddingRight: 10, borderRightWidth: 1, borderRightColor: colors.line },
  input: { flex: 1, color: colors.ink, fontSize: 15, paddingVertical: 0 },
  previewNote: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 11, marginTop: -5, marginBottom: 14, borderRadius: 13, backgroundColor: colors.primarySoft },
  previewNoteText: { flex: 1, color: colors.primaryDark, fontSize: 11, lineHeight: 17 },
  sentLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -3, marginBottom: 13 },
  sentText: { flex: 1, color: colors.muted, fontSize: 11 },
  changePhone: { color: colors.primary, fontSize: 11, fontWeight: '800' },
  consentRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, paddingVertical: 8 },
  checkbox: { width: 21, height: 21, borderRadius: 7, alignItems: 'center', justifyContent: 'center', marginRight: 4, borderWidth: 1, borderColor: colors.line },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  consentText: { color: colors.muted, fontSize: 12 },
  documentLink: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  errorBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, padding: 12, marginTop: 8, borderRadius: 14, backgroundColor: '#FDECEC' },
  errorText: { flex: 1, color: colors.red, fontSize: 12, lineHeight: 18 },
  actionArea: { paddingTop: 10, backgroundColor: colors.surface },
  primaryButton: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 17, backgroundColor: colors.primary },
  primaryButtonDisabled: { opacity: 0.42 },
  primaryText: { color: colors.surface, fontSize: 15, fontWeight: '900' },
  securityNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 13, marginTop: 8, borderRadius: 14, backgroundColor: colors.primarySoft },
  securityText: { flex: 1, color: colors.primaryDark, fontSize: 11, lineHeight: 17 },
});
