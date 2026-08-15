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
  View,
} from 'react-native';
import { loadLegalDocuments, type LegalDocuments } from './api';
import { colors } from './theme';

type AuthSheetProps = Readonly<{
  visible: boolean;
  onClose: () => void;
  onSignedIn: () => void | Promise<void>;
  kaiAuthBusy?: boolean;
  kaiAuthError?: string | null;
  onKaiAuthStart?: (documents: LegalDocuments) => void | Promise<void>;
}>;

export function AuthSheet({
  visible,
  onClose,
  onSignedIn: _onSignedIn,
  kaiAuthBusy = false,
  kaiAuthError = null,
  onKaiAuthStart,
}: AuthSheetProps) {
  const [documents, setDocuments] = useState<LegalDocuments | null>(null);
  const [legalError, setLegalError] = useState<string | null>(null);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setDocuments(null);
    setConsented(false);
    setError(null);
    setLegalError(null);
    void loadLegalDocuments()
      .then((nextDocuments) => { if (active) setDocuments(nextDocuments); })
      .catch((reason: unknown) => {
        if (active) setLegalError(reason instanceof Error ? reason.message : '暂时无法读取协议。');
      });
    return () => { active = false; };
  }, [visible]);

  const openDocument = async (url: string | null | undefined) => {
    if (!url || !/^https:\/\//u.test(url)) {
      setError('协议地址尚未配置。');
      return;
    }
    await Linking.openURL(url);
  };

  const openKaiAuth = async () => {
    if (!onKaiAuthStart || !documents || !consented || kaiAuthBusy) return;
    setBusy(true);
    setError(null);
    try {
      await onKaiAuthStart(documents);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法打开 KAI 账号登录。');
    } finally {
      setBusy(false);
    }
  };

  const unifiedError = error ?? kaiAuthError ?? legalError;
  const disabled = busy || kaiAuthBusy || !onKaiAuthStart || !documents || !consented;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View nativeID="KAI_CLOUD_UNIFIED_IDENTITY_V1" style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View>
              <Text style={styles.eyebrow}>KAI 统一身份</Text>
              <Text style={styles.title}>登录 CloudPay</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} style={styles.closeButton}>
              <Ionicons name="close" size={23} color={colors.ink} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.formContent} showsVerticalScrollIndicator={false}>
            <View style={styles.securityNote}>
              <Ionicons name="shield-checkmark-outline" size={18} color={colors.primary} />
              <Text style={styles.securityText}>与 cloud.kai.com 主站使用同一账号。登录会在系统浏览器中完成，密码不会交给 CloudPay App。</Text>
            </View>

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

            {unifiedError ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle-outline" size={18} color={colors.red} />
                <Text style={styles.errorText}>{unifiedError}</Text>
              </View>
            ) : null}
          </ScrollView>

          <View style={styles.actionArea}>
            <Pressable
              disabled={disabled}
              onPress={() => void openKaiAuth()}
              style={[styles.primaryButton, disabled && styles.primaryButtonDisabled]}
            >
              {busy || kaiAuthBusy ? <ActivityIndicator color={colors.surface} /> : (
                <>
                  <Text style={styles.primaryText}>使用 KAI 账号登录</Text>
                  <Ionicons name="open-outline" size={18} color={colors.surface} />
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
  consentRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, paddingVertical: 16 },
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
