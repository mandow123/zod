import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CloudPayNotification, CloudPaySnapshot } from '../api';
import { Card } from '../components';
import { providerOfferMessageActionLabel } from '../provider-next-navigation';
import { colors } from '../theme';

type IconName = ComponentProps<typeof Ionicons>['name'];
type MessageTone = 'green' | 'blue' | 'amber';

const toneMap: Record<MessageTone, { background: string; foreground: string }> = {
  green: { background: colors.primarySoft, foreground: colors.primary },
  blue: { background: colors.blueSoft, foreground: colors.blue },
  amber: { background: colors.amberSoft, foreground: colors.amber },
};

const categoryMap: Record<CloudPayNotification['category'], { label: string; tone: MessageTone; icon: IconName }> = {
  order: { label: '订单动态', tone: 'green', icon: 'receipt-outline' },
  payment: { label: '卡时动态', tone: 'amber', icon: 'wallet-outline' },
  delivery: { label: '交付进度', tone: 'blue', icon: 'cube-outline' },
  market: { label: '市场通知', tone: 'blue', icon: 'storefront-outline' },
  account: { label: '账户安全', tone: 'green', icon: 'shield-checkmark-outline' },
  system: { label: '系统通知', tone: 'amber', icon: 'notifications-outline' },
};

function messageTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function messageBody(value: string) {
  return value
    .replace(/(\d+\.\d*?[1-9])0+(?=\s)/g, '$1')
    .replace(/(\d+)\.0+(?=\s)/g, '$1');
}

type Props = {
  snapshot: CloudPaySnapshot;
  refreshing: boolean;
  onRefresh: () => void;
  onMarkRead: (notificationId: string) => void;
  onMarkAllRead: () => void;
  onOpenMessage: (message: CloudPayNotification) => void;
  onOpenProfile: () => void;
};

export function MessagesScreen({
  snapshot, refreshing, onRefresh, onMarkRead, onMarkAllRead, onOpenMessage, onOpenProfile,
}: Props) {
  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <View style={styles.headingRow}>
          <View style={styles.headingCopy}>
            <Text style={styles.eyebrow}>消息中心</Text>
            <Text style={styles.title}>消息</Text>
          </View>
          <View style={styles.unreadCount}>
            <Text style={styles.unreadNumber}>{snapshot.unreadCount > 99 ? '99+' : snapshot.unreadCount}</Text>
            <Text style={styles.unreadLabel}>未读</Text>
          </View>
        </View>

        {snapshot.authenticated && snapshot.unreadCount > 0 ? (
          <Pressable style={styles.readAllButton} onPress={onMarkAllRead}>
            <Ionicons name="checkmark-done-outline" size={17} color={colors.primary} />
            <Text style={styles.readAllText}>全部标为已读</Text>
          </Pressable>
        ) : null}

        {!snapshot.authenticated ? (
          <Card style={styles.emptyCard}>
            <View style={styles.emptyIcon}>
              <Ionicons name="lock-closed-outline" size={34} color={colors.primary} />
            </View>
            <Text style={styles.emptyTitle}>登录后查看消息</Text>
            <Text style={styles.emptyBody}>登录后可查看资源审核、卡时、订单、交付和账户安全通知。</Text>
            <Pressable style={styles.loginButton} onPress={onOpenProfile}>
              <Text style={styles.loginButtonText}>去登录</Text>
            </Pressable>
          </Card>
        ) : snapshot.notifications.length === 0 ? (
          <Card style={styles.emptyCard}>
            <View style={styles.emptyIcon}>
              <Ionicons name="checkmark-circle-outline" size={38} color={colors.green} />
            </View>
            <Text style={styles.emptyTitle}>暂无消息</Text>
            <Text style={styles.emptyBody}>资源审核、卡时、订单和交付状态更新会显示在这里。</Text>
          </Card>
        ) : (
          <Card style={styles.streamCard}>
            {snapshot.notifications.map((message, index) => {
              const category = categoryMap[message.category];
              const tone = toneMap[category.tone];
              const actionable = (
                (message.data.route === 'provider_offer' && typeof message.data.offerId === 'string')
                || ((message.data.route === 'provider_order' || message.data.route === 'buyer_order')
                  && typeof message.data.orderId === 'string')
                || (message.data.route === 'provider_resource' && typeof message.data.resourceId === 'string')
              );
              const actionLabel = message.data.route === 'provider_resource' ? '查看资源'
                : message.data.route === 'provider_order' || message.data.route === 'buyer_order' ? '查看订单'
                  : providerOfferMessageActionLabel(message.data.offerStatus);
              return (
                <Pressable
                  key={message.id}
                  style={styles.messageRow}
                  disabled={message.read && !actionable}
                  onPress={() => actionable ? onOpenMessage(message) : onMarkRead(message.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${message.title}${message.read ? '，已读' : '，未读'}${actionable ? `，${actionLabel}` : message.read ? '' : '，点按标记已读'}`}
                >
                  <View style={styles.rail}>
                    <View style={[styles.iconCircle, { backgroundColor: tone.background }]}>
                      <Ionicons name={category.icon} size={20} color={tone.foreground} />
                    </View>
                    {index < snapshot.notifications.length - 1 ? <View style={styles.line} /> : null}
                  </View>
                  <View style={styles.messageCopy}>
                    <View style={styles.messageMeta}>
                      <Text style={[styles.messageLabel, { color: tone.foreground }]}>{category.label}</Text>
                      <Text style={styles.time}>{messageTime(message.createdAt)}</Text>
                    </View>
                    <View style={styles.messageTitleRow}>
                      <Text style={styles.messageTitle}>{message.title}</Text>
                      {!message.read ? <View style={styles.unreadDot} /> : null}
                    </View>
                    <Text style={styles.messageBody}>{messageBody(message.body)}</Text>
                    {actionable ? (
                      <View style={styles.messageAction}>
                        <Text style={styles.messageActionText}>{actionLabel}</Text>
                        <Ionicons name="arrow-forward" size={14} color={colors.primary} />
                      </View>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </Card>
        )}

        <View style={styles.localNote}>
          <Ionicons name={snapshot.pushReady ? 'notifications-outline' : 'phone-portrait-outline'} size={19} color={colors.muted} />
          <Text style={styles.localText}>
            {snapshot.pushReady
              ? '应用内消息和系统通知均已开启。'
              : '应用内消息可正常查看，系统通知暂未开启。'}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: 16, paddingBottom: 38 },
  headingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 10, marginBottom: 18 },
  headingCopy: { flex: 1, paddingRight: 12 },
  eyebrow: { color: colors.primary, fontSize: 11, fontWeight: '900', letterSpacing: 1.8, marginBottom: 8 },
  title: { color: colors.ink, fontSize: 28, lineHeight: 36, fontWeight: '900', letterSpacing: -0.8 },
  unreadCount: { minWidth: 62, height: 62, paddingHorizontal: 9, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  unreadNumber: { color: colors.surface, fontSize: 21, fontWeight: '900', lineHeight: 23 },
  unreadLabel: { color: 'rgba(255,255,255,0.78)', fontSize: 10, fontWeight: '700' },
  readAllButton: { alignSelf: 'flex-end', minHeight: 40, marginBottom: 10, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 13, backgroundColor: colors.primarySoft },
  readAllText: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  streamCard: { paddingHorizontal: 17, paddingVertical: 8 },
  messageRow: { minHeight: 132, flexDirection: 'row', paddingTop: 18 },
  rail: { width: 48, alignItems: 'center' },
  iconCircle: { width: 42, height: 42, borderRadius: 15, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  line: { position: 'absolute', top: 58, bottom: -20, width: 1, backgroundColor: colors.line },
  messageCopy: { flex: 1, paddingLeft: 8, paddingRight: 2, paddingBottom: 18, borderBottomWidth: 1, borderBottomColor: colors.line },
  messageMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  messageLabel: { fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  time: { color: colors.subtle, fontSize: 10 },
  messageTitleRow: { flexDirection: 'row', alignItems: 'center', marginTop: 7 },
  messageTitle: { flexShrink: 1, color: colors.ink, fontSize: 16, fontWeight: '800' },
  unreadDot: { width: 7, height: 7, borderRadius: 4, marginLeft: 7, backgroundColor: colors.red },
  messageBody: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 6 },
  messageAction: { minHeight: 32, marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 4 },
  messageActionText: { color: colors.primary, fontSize: 11, fontWeight: '900' },
  emptyCard: { padding: 26, alignItems: 'center' },
  emptyIcon: { width: 72, height: 72, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft, marginBottom: 16 },
  emptyTitle: { color: colors.ink, fontSize: 18, fontWeight: '900', textAlign: 'center' },
  emptyBody: { color: colors.muted, fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: 8 },
  loginButton: { minHeight: 44, marginTop: 18, paddingHorizontal: 20, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  loginButtonText: { color: colors.surface, fontSize: 14, fontWeight: '800' },
  localNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, marginTop: 16, paddingHorizontal: 8 },
  localText: { flex: 1, color: colors.muted, fontSize: 12, lineHeight: 18 },
});
