import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';
import type { CloudPayFulfillmentIssue } from './api';
import { fulfillmentIssuePresentation, issueKindLabel } from './fulfillment-issue-ui';
import { colors } from './theme';
import { creditAmount } from './format';

export function FulfillmentIssueCard({ issue, side }: Readonly<{
  issue: CloudPayFulfillmentIssue;
  side: 'buyer' | 'provider';
}>) {
  const copy = fulfillmentIssuePresentation(issue, side);
  return <View style={[styles.card, issue.status === 'open' ? styles.openCard : styles.resolvedCard]}>
    <View style={styles.top}>
      <View style={styles.copy}><Text style={styles.eyebrow}>{issueKindLabel(issue.kind)}</Text><Text style={styles.title}>{copy.title}</Text></View>
      <View style={styles.pill}><Ionicons name={issue.status === 'open' ? 'time-outline' : 'shield-checkmark-outline'} size={15} color={issue.status === 'open' ? colors.amber : colors.green} /><Text style={styles.pillText}>{copy.label}</Text></View>
    </View>
    <Text style={styles.description}>{copy.description}</Text>
    <View style={styles.statement}><Text style={styles.statementLabel}>{side === 'buyer' ? '你的说明' : '买方说明'}</Text><Text style={styles.statementText}>{issue.description}</Text><Text style={styles.time}>{formatTime(issue.openedAt)} 提交</Text></View>
    {issue.status === 'resolved' && issue.reason ? <View style={styles.decision}><Text style={styles.decisionLabel}>平台裁定说明</Text><Text style={styles.decisionText}>{issue.reason}</Text>{issue.decidedAt ? <Text style={styles.time}>{formatTime(issue.decidedAt)} 完成裁定</Text> : null}</View> : null}
    {issue.status === 'resolved' && issue.settlement ? <View style={styles.settlement}>
      <Text style={styles.settlementTitle}>本单卡时结果</Text>
      <MoneyRow label="平台核定实耗" value={issue.settlement.meteredCredits} />
      <MoneyRow label="未使用退回" value={issue.settlement.unusedCredits} />
      <MoneyRow label="问题补偿" value={issue.settlement.remedyRefundCredits} />
      <View style={styles.divider} />
      <MoneyRow label="买方退回合计" value={issue.settlement.buyerRefundCredits} strong />
      <MoneyRow label="提供方待结算" value={issue.settlement.providerCredits} strong />
      <Text style={styles.settlementNote}>{issue.outcome === 'full_refund'
        ? '买方退回全部冻结卡时，提供方结算为 0。'
        : '提供方卡时进入 7 天待结算，未使用与补偿部分退回买方。'}</Text>
    </View> : null}
  </View>;
}

function MoneyRow({ label, value, strong = false }: Readonly<{ label: string; value: string; strong?: boolean }>) {
  return <View style={styles.moneyRow}><Text style={[styles.moneyLabel, strong && styles.strong]}>{label}</Text><Text style={[styles.moneyValue, strong && styles.strongValue]}>{creditAmount(value)} KAI 卡时</Text></View>;
}
function formatTime(value: string) { const date = new Date(value); return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }

const styles = StyleSheet.create({
  card: { padding: 16, marginTop: 14, borderWidth: 1, borderRadius: 20 }, openCard: { borderColor: '#B9D2F7', backgroundColor: colors.primarySoft }, resolvedCard: { borderColor: '#B8DEC2', backgroundColor: '#F6FCF7' }, top: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 }, copy: { flex: 1 }, eyebrow: { color: colors.primary, fontSize: 9, fontWeight: '900' }, title: { color: colors.ink, fontSize: 16, lineHeight: 22, fontWeight: '900', marginTop: 4 }, pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.surface }, pillText: { color: colors.ink, fontSize: 9, fontWeight: '900' }, description: { color: colors.muted, fontSize: 10, lineHeight: 17, marginTop: 8 }, statement: { padding: 12, marginTop: 12, borderRadius: 14, backgroundColor: colors.surface }, statementLabel: { color: colors.primary, fontSize: 9, fontWeight: '900' }, statementText: { color: colors.ink, fontSize: 11, lineHeight: 18, marginTop: 6 }, time: { color: colors.subtle, fontSize: 8, marginTop: 7 }, decision: { paddingTop: 12, marginTop: 12, borderTopWidth: 1, borderTopColor: colors.line }, decisionLabel: { color: colors.primary, fontSize: 9, fontWeight: '900' }, decisionText: { color: colors.ink, fontSize: 11, lineHeight: 18, marginTop: 6 }, settlement: { padding: 13, marginTop: 13, borderRadius: 15, backgroundColor: colors.surface }, settlementTitle: { color: colors.ink, fontSize: 12, fontWeight: '900', marginBottom: 6 }, moneyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 30 }, moneyLabel: { color: colors.muted, fontSize: 9 }, moneyValue: { color: colors.ink, fontSize: 10, fontWeight: '800' }, strong: { color: colors.ink, fontWeight: '900' }, strongValue: { color: colors.primaryDark, fontSize: 12, fontWeight: '900' }, divider: { height: 1, marginVertical: 5, backgroundColor: colors.line }, settlementNote: { color: colors.muted, fontSize: 8, lineHeight: 14, marginTop: 8 },
});
