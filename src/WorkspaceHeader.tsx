import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { TradingSubject } from './api';
import type { WorkMode } from './components';
import { colors, shadows } from './theme';

export function WorkspaceHeader({
  mode,
  onModeChange,
  subject,
  subjects,
  unread,
  subjectPickerVisible,
  onOpenSubjectPicker,
  onCloseSubjectPicker,
  onSelectSubject,
  onMessages,
  onProfile,
}: Readonly<{
  mode: WorkMode;
  onModeChange: (mode: WorkMode) => void;
  subject: TradingSubject | null;
  subjects: TradingSubject[];
  unread: number;
  subjectPickerVisible: boolean;
  onOpenSubjectPicker: () => void;
  onCloseSubjectPicker: () => void;
  onSelectSubject: (subjectId: string) => void;
  onMessages: () => void;
  onProfile: () => void;
}>) {
  const switchMode = (next: WorkMode) => {
    if (next === mode) return;
    void Haptics.selectionAsync();
    onModeChange(next);
  };

  return (
    <>
      <View style={styles.shell}>
        <View style={styles.topRow}>
          <View style={styles.brand}>
            <View style={styles.logo}><Text style={styles.logoText}>K</Text></View>
            <View>
              <Text style={styles.title}>KAI Cloud</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="切换交易主体"
                onPress={onOpenSubjectPicker}
                style={styles.subjectButton}
              >
                <Text numberOfLines={1} style={styles.subjectText}>{subject?.displayName ?? '当前账号'}</Text>
                {subjects.length > 0 ? <Ionicons name="chevron-down" size={13} color={colors.muted} /> : null}
              </Pressable>
            </View>
          </View>
          <View style={styles.actions}>
            <Pressable onPress={onMessages} style={styles.iconButton} accessibilityLabel="消息">
              <Ionicons name="notifications-outline" size={23} color={colors.ink} />
              {unread > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text></View> : null}
            </Pressable>
            <Pressable onPress={onProfile} style={styles.avatar} accessibilityLabel="我的">
              <Text style={styles.avatarText}>{(subject?.displayName ?? 'K').trim().slice(0, 1).toUpperCase()}</Text>
            </Pressable>
          </View>
        </View>
        <View style={styles.segment}>
          <Pressable onPress={() => switchMode('consumer')} style={[styles.segmentItem, mode === 'consumer' && styles.segmentItemActive]}>
            <Ionicons name="flash-outline" size={16} color={mode === 'consumer' ? colors.primary : colors.muted} />
            <Text style={[styles.segmentText, mode === 'consumer' && styles.segmentTextActive]}>使用算力</Text>
          </Pressable>
          <Pressable onPress={() => switchMode('provider')} style={[styles.segmentItem, mode === 'provider' && styles.segmentItemActive]}>
            <Ionicons name="server-outline" size={16} color={mode === 'provider' ? colors.primary : colors.muted} />
            <Text style={[styles.segmentText, mode === 'provider' && styles.segmentTextActive]}>提供算力</Text>
          </Pressable>
        </View>
      </View>

      <Modal visible={subjectPickerVisible} transparent animationType="fade" onRequestClose={onCloseSubjectPicker}>
        <Pressable style={styles.backdrop} onPress={onCloseSubjectPicker}>
          <Pressable style={styles.picker} onPress={(event) => event.stopPropagation()}>
            <View style={styles.pickerHandle} />
            <Text style={styles.pickerEyebrow}>当前交易主体</Text>
            <Text style={styles.pickerTitle}>切换后，资源和上架记录会随主体切换</Text>
            <View style={styles.subjectList}>
              {subjects.map((item) => (
                <Pressable key={item.id} onPress={() => onSelectSubject(item.id)} style={[styles.subjectRow, item.selected && styles.subjectRowSelected]}>
                  <View style={[styles.subjectIcon, item.selected && styles.subjectIconSelected]}>
                    <Ionicons name={item.kind === 'organization' ? 'business-outline' : 'person-outline'} size={20} color={item.selected ? colors.surface : colors.primary} />
                  </View>
                  <View style={styles.subjectCopy}>
                    <Text style={styles.subjectName}>{item.displayName}</Text>
                    <Text style={styles.subjectMeta}>{item.kind === 'organization' ? '组织主体' : '个人主体'} · {roleLabel[item.role]}</Text>
                  </View>
                  {item.selected ? <Ionicons name="checkmark-circle" size={22} color={colors.primary} /> : null}
                </Pressable>
              ))}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const roleLabel: Record<TradingSubject['role'], string> = {
  owner: '负责人', admin: '管理员', provider_manager: '上架经理', provider_operator: '资源运营', viewer: '只读成员',
};

const styles = StyleSheet.create({
  shell: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, backgroundColor: colors.canvas, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  topRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  logo: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  logoText: { color: colors.surface, fontSize: 22, fontWeight: '900' },
  title: { color: colors.ink, fontSize: 17, fontWeight: '900', marginLeft: 10 },
  subjectButton: { maxWidth: 190, marginLeft: 10, marginTop: 1, flexDirection: 'row', alignItems: 'center', gap: 3 },
  subjectText: { maxWidth: 165, color: colors.muted, fontSize: 11, fontWeight: '700' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  iconButton: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  badge: { position: 'absolute', right: -3, top: -3, minWidth: 18, height: 18, paddingHorizontal: 3, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.red },
  badgeText: { color: colors.surface, fontSize: 9, fontWeight: '900' },
  avatar: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft },
  avatarText: { color: colors.primaryDark, fontSize: 15, fontWeight: '900' },
  segment: { flexDirection: 'row', padding: 4, marginTop: 10, borderRadius: 12, backgroundColor: '#E8F0FA' },
  segmentItem: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 10, borderWidth: 1, borderColor: 'transparent' },
  segmentItemActive: { borderColor: '#C7DBF6', backgroundColor: colors.surface, ...shadows.card },
  segmentText: { color: colors.muted, fontSize: 13, fontWeight: '800' },
  segmentTextActive: { color: colors.primary },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.34)' },
  picker: { maxHeight: '72%', paddingHorizontal: 18, paddingTop: 10, paddingBottom: 30, borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: colors.canvas },
  pickerHandle: { width: 42, height: 5, borderRadius: 3, alignSelf: 'center', marginBottom: 18, backgroundColor: '#C9D4CD' },
  pickerEyebrow: { color: colors.primary, fontSize: 12, fontWeight: '800', letterSpacing: 0.8 },
  pickerTitle: { color: colors.ink, fontSize: 20, lineHeight: 28, fontWeight: '900', marginTop: 5, marginBottom: 16 },
  subjectList: { gap: 9 },
  subjectRow: { minHeight: 72, flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 18, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  subjectRowSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  subjectIcon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft },
  subjectIconSelected: { backgroundColor: colors.primary },
  subjectCopy: { flex: 1, marginLeft: 11 },
  subjectName: { color: colors.ink, fontSize: 15, fontWeight: '900' },
  subjectMeta: { color: colors.muted, fontSize: 11, marginTop: 4 },
});
