import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, shadows } from './theme';

export type WorkMode = 'consumer' | 'provider';
export type TabKey = 'home' | 'market' | 'assets' | 'orders' | 'workspace' | 'resources' | 'publish' | 'messages' | 'profile';
type IconName = ComponentProps<typeof Ionicons>['name'];

export function BrandHeader({
  title = 'KAI CloudPay',
  subtitle,
  onSearch,
  onMessages,
  unread = 0,
}: {
  title?: string;
  subtitle?: string;
  onSearch?: () => void;
  onMessages?: () => void;
  unread?: number;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.brandBlock}>
        <View style={styles.logo}>
          <Text style={styles.logoText}>K</Text>
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.headerTitle}>{title}</Text>
          {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
        </View>
      </View>
      <View style={styles.headerActions}>
        {onSearch ? (
          <Pressable accessibilityRole="button" accessibilityLabel="搜索" onPress={onSearch} style={styles.iconButton}>
            <Ionicons name="search-outline" size={24} color={colors.ink} />
          </Pressable>
        ) : null}
        {onMessages ? (
          <Pressable accessibilityRole="button" accessibilityLabel="消息" onPress={onMessages} style={styles.iconButton}>
            <Ionicons name="chatbubble-ellipses-outline" size={25} color={colors.ink} />
            {unread > 0 ? (
              <View style={styles.headerBadge}>
                <Text style={styles.headerBadgeText}>{unread}</Text>
              </View>
            ) : null}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function SectionTitle({
  title,
  caption,
  action,
  onAction,
}: {
  title: string;
  caption?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.sectionTitleRow}>
      <View style={styles.sectionCopy}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {caption ? <Text style={styles.sectionCaption}>{caption}</Text> : null}
      </View>
      {action ? (
        <Pressable onPress={onAction} hitSlop={8}>
          <Text style={styles.sectionAction}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function StatusPill({ online, label }: { online: boolean; label?: string }) {
  return (
    <View style={[styles.statusPill, online ? styles.onlinePill : styles.offlinePill]}>
      <View style={[styles.statusDot, online ? styles.onlineDot : styles.offlineDot]} />
      <Text style={[styles.statusText, online ? styles.onlineText : styles.offlineText]}>
        {label ?? (online ? '服务端在线' : '连接中断')}
      </Text>
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

const mainTabs: Array<{ key: TabKey; label: string; icon: IconName; activeIcon: IconName }> = [
  { key: 'home', label: '首页', icon: 'home-outline', activeIcon: 'home' },
  { key: 'market', label: '市场', icon: 'storefront-outline', activeIcon: 'storefront' },
  { key: 'assets', label: '我的资产', icon: 'cube-outline', activeIcon: 'cube' },
  { key: 'messages', label: '消息', icon: 'chatbubble-ellipses-outline', activeIcon: 'chatbubble-ellipses' },
  { key: 'profile', label: '我的', icon: 'person-outline', activeIcon: 'person' },
];

export function BottomNav({
  active,
  mode,
  onChange,
  unread,
}: {
  active: TabKey;
  mode: WorkMode;
  onChange: (tab: TabKey) => void;
  unread: number;
}) {
  const insets = useSafeAreaInsets();
  void mode;

  return (
    <View style={[styles.navShell, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {mainTabs.map((tab) => {
        const selected = tab.key === active;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={tab.label}
            onPress={() => onChange(tab.key)}
            style={styles.navItem}
          >
            <View style={styles.navIconWrap}>
              <Ionicons
                name={selected ? tab.activeIcon : tab.icon}
                size={23}
                color={selected ? colors.primary : colors.muted}
              />
              {tab.key === 'messages' && unread > 0 ? (
                <View style={styles.navBadge}>
                  <Text style={styles.navBadgeText}>{unread}</Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.navLabel, selected && styles.navLabelActive]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: 72,
    paddingHorizontal: 18,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    backgroundColor: colors.canvas,
  },
  brandBlock: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  logo: {
    width: 46,
    height: 46,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  logoText: { color: colors.surface, fontSize: 25, fontWeight: '900' },
  headerCopy: { flex: 1, marginLeft: 12 },
  headerTitle: { color: colors.ink, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  headerSubtitle: { color: colors.muted, fontSize: 12, marginTop: 2 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerBadge: {
    position: 'absolute',
    right: 2,
    top: 2,
    minWidth: 19,
    height: 19,
    paddingHorizontal: 4,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.red,
  },
  headerBadgeText: { color: colors.surface, fontSize: 10, fontWeight: '800' },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 14 },
  sectionCopy: { flex: 1 },
  sectionTitle: { color: colors.ink, fontSize: 22, fontWeight: '800', letterSpacing: -0.4 },
  sectionCaption: { color: colors.muted, fontSize: 13, marginTop: 4, lineHeight: 19 },
  sectionAction: { color: colors.primary, fontSize: 14, fontWeight: '700', marginLeft: 10, paddingBottom: 2 },
  statusPill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
  onlinePill: { backgroundColor: '#DDF4E3' },
  offlinePill: { backgroundColor: '#FDE8E8' },
  statusDot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  onlineDot: { backgroundColor: '#16A34A' },
  offlineDot: { backgroundColor: '#DC2626' },
  statusText: { fontSize: 12, fontWeight: '700' },
  onlineText: { color: colors.green },
  offlineText: { color: '#B91C1C' },
  card: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.line, ...shadows.card },
  navShell: {
    flexDirection: 'row',
    paddingTop: 8,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    ...shadows.card,
  },
  navItem: { flex: 1, alignItems: 'center', justifyContent: 'flex-start', minHeight: 58 },
  navIconWrap: { width: 42, height: 30, alignItems: 'center', justifyContent: 'center' },
  navLabel: { color: colors.muted, fontSize: 10, fontWeight: '600', marginTop: 1 },
  navLabelActive: { color: colors.primary, fontWeight: '800' },
  navBadge: { position: 'absolute', right: 1, top: -2, minWidth: 17, height: 17, borderRadius: 9, paddingHorizontal: 3, backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center' },
  navBadgeText: { color: colors.surface, fontSize: 9, fontWeight: '800' },
});
