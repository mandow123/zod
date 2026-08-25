import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import {
  Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { qixiangAmount, qixiangAmountInputCents } from './qixiang-topups.ts';
import { colors } from './theme';

const packages = [
  { amountCents: 5_000, label: '轻量' },
  { amountCents: 10_000, label: '常用' },
  { amountCents: 30_000, label: '进阶' },
  { amountCents: 50_000, label: '畅用' },
  { amountCents: 100_000, label: '大额' },
] as const;

function previewCredit(amount: string) {
  try {
    const cents = qixiangAmountInputCents(amount, 100, 100_000);
    return qixiangAmount(Math.floor((cents * 1000) / 1002));
  } catch {
    return '—';
  }
}

function Summary({ label, value }: Readonly<{ label: string; value: string }>) {
  return <View style={styles.summaryRow}><Text style={styles.summaryLabel}>{label}</Text>
    <Text style={styles.summaryValue}>{value}</Text></View>;
}

export function LocalQixiangPreviewShell({ children: _children }: Readonly<{ children: ReactNode }>) {
  const [amount, setAmount] = useState('100.00');
  const [confirming, setConfirming] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  const credit = useMemo(() => previewCredit(amount), [amount]);
  const valid = credit !== '—';

  if (previewed) {
    return <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <StatusBar style="dark" />
      <View style={styles.previewBar}><View style={styles.dot} /><Text style={styles.previewBarText}>本地预览</Text>
        <Text style={styles.previewBarMeta}>不连接真实支付</Text></View>
      <View style={styles.centered}>
        <View style={styles.successIcon}><Ionicons name="checkmark-circle-outline" size={42} color={colors.green} /></View>
        <Text style={styles.successTitle}>本地流程预览完成</Text>
        <Text style={styles.successText}>已演示 ¥{amount} 的确认流程，没有创建订单、没有调用七相、没有发生扣款。</Text>
        <Pressable onPress={() => { setPreviewed(false); setConfirming(false); }} style={styles.primary}>
          <Text style={styles.primaryText}>返回充值预览</Text>
        </Pressable>
      </View>
    </SafeAreaView>;
  }

  if (confirming) {
    return <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <StatusBar style="dark" />
      <View style={styles.previewBar}><View style={styles.dot} /><Text style={styles.previewBarText}>本地预览</Text>
        <Text style={styles.previewBarMeta}>不连接真实支付</Text></View>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable onPress={() => setConfirming(false)} style={styles.back}>
          <Ionicons name="arrow-back" size={18} color={colors.primary} /><Text style={styles.backText}>返回卡时</Text>
        </Pressable>
        <Text style={styles.eyebrow}>七相支付 · 本地预览</Text><Text style={styles.title}>确认支付</Text>
        <View style={styles.summaryCard}>
          <Summary label="运营主体" value="上海申比芯人工智能科技有限公司" />
          <Summary label="实付" value={`¥ ${amount}`} />
          <Summary label="预计卡时" value={`${credit} KAI 卡时`} />
          <Summary label="支付通道" value="七相支付（支付宝）" />
        </View>
        <View style={styles.rules}>
          <Text style={styles.rule}>换算快照：实付金额按 1.002 向下取整到两位</Text>
          <Text style={styles.rule}>到账卡时有效期 364 天；不可转让，不可提现或兑换现金</Text>
          <Text style={styles.rule}>这是本地交互预览，不会打开支付宝或创建真实订单</Text>
        </View>
        <Pressable onPress={() => setPreviewed(true)} style={styles.primary}>
          <Text style={styles.primaryText}>模拟确认（不会扣款）</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>;
  }

  return <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
    <StatusBar style="dark" />
    <View style={styles.previewBar}><View style={styles.dot} /><Text style={styles.previewBarText}>本地预览</Text>
      <Text style={styles.previewBarMeta}>数据与正式环境隔离 · 不连接真实支付</Text></View>
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.header}><View><Text style={styles.eyebrow}>KAI 卡时</Text><Text style={styles.accountTitle}>卡时账户</Text></View>
        <View style={styles.close}><Ionicons name="close" size={25} color={colors.ink} /></View></View>
      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>可用卡时</Text><Text style={styles.balanceValue}>0.00</Text>
        <Text style={styles.balanceUnit}>KAI 卡时</Text><View style={styles.divider} />
        <View style={styles.balanceFacts}><View><Text style={styles.factLabel}>订单预留</Text><Text style={styles.factValue}>0.00</Text></View>
          <View><Text style={styles.factLabel}>待结算</Text><Text style={styles.factValue}>0.00</Text></View></View>
      </View>
      <Text style={styles.sectionTitle}>充值卡时</Text><Text style={styles.help}>支付通道：七相支付（支付宝）</Text>
      <Text style={styles.fieldLabel}>充值套餐</Text>
      <View style={styles.packageGrid}>{packages.map((item) => {
        const selected = amount === qixiangAmount(item.amountCents);
        return <Pressable key={item.amountCents} onPress={() => setAmount(qixiangAmount(item.amountCents))}
          style={[styles.packageCard, selected && styles.packageSelected]}>
          <Text style={[styles.packageLabel, selected && styles.packageLabelSelected]}>{item.label}</Text>
          <Text style={[styles.packageAmount, selected && styles.packageAmountSelected]}>¥{qixiangAmount(item.amountCents)}</Text>
        </Pressable>;
      })}</View>
      <Text style={styles.fieldLabel}>自定义金额（元）</Text>
      <View style={styles.amountField}><TextInput accessibilityLabel="本地预览实付金额" value={amount}
        onChangeText={setAmount} keyboardType="decimal-pad" style={styles.amountInput} /><Text style={styles.currency}>元</Text></View>
      <View style={styles.quoteCard}><Text style={styles.quoteLabel}>预计获得</Text>
        <Text style={styles.quoteValue}>{credit} KAI 卡时</Text>
        <Text style={styles.meta}>按 1.002 向下取整到两位 · 有效期 364 天</Text></View>
      <Text style={styles.operator}>运营主体：上海申比芯人工智能科技有限公司</Text>
      <Pressable disabled={!valid} onPress={() => setConfirming(true)} style={[styles.primary, !valid && styles.disabled]}>
        <Text style={styles.primaryText}>使用七相支付</Text>
      </Pressable>
      <Text style={styles.disclosure}>本地预览不会发送网络支付请求，也不会生成真实充值记录。</Text>
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  previewBar: { minHeight: 32, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, backgroundColor: colors.surface },
  dot: { width: 7, height: 7, borderRadius: 4, marginRight: 7, backgroundColor: colors.primary },
  previewBarText: { color: colors.primaryDark, fontSize: 11, fontWeight: '900' },
  previewBarMeta: { color: colors.muted, fontSize: 9, fontWeight: '700', marginLeft: 7 },
  content: { padding: 16, paddingBottom: 42, gap: 12 },
  header: { minHeight: 84, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { color: colors.primary, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  accountTitle: { color: colors.ink, fontSize: 27, fontWeight: '900', marginTop: 5 },
  title: { color: colors.ink, fontSize: 25, fontWeight: '900', marginTop: 2, marginBottom: 8 },
  close: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  balanceCard: { padding: 18, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: '#D5E5FA' },
  balanceLabel: { color: colors.muted, fontSize: 11 }, balanceValue: { color: colors.primaryDark, fontSize: 40, fontWeight: '900', marginTop: 10 },
  balanceUnit: { color: colors.primary, fontSize: 11, marginTop: 4 }, divider: { height: 1, backgroundColor: colors.line, marginVertical: 18 },
  balanceFacts: { flexDirection: 'row', gap: 90 }, factLabel: { color: colors.muted, fontSize: 10 }, factValue: { color: colors.ink, fontSize: 18, fontWeight: '900', marginTop: 7 },
  sectionTitle: { color: colors.ink, fontSize: 19, fontWeight: '900', marginTop: 2 }, help: { color: colors.muted, fontSize: 10, marginTop: -8 },
  fieldLabel: { color: colors.ink, fontSize: 10, fontWeight: '800', marginTop: 2 }, packageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  packageCard: { width: '31%', minWidth: 88, minHeight: 64, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  packageSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft }, packageLabel: { color: colors.muted, fontSize: 9, fontWeight: '800' },
  packageLabelSelected: { color: colors.primary }, packageAmount: { color: colors.ink, fontSize: 14, fontWeight: '900', marginTop: 4 }, packageAmountSelected: { color: colors.primaryDark },
  amountField: { minHeight: 58, paddingHorizontal: 14, borderWidth: 1, borderColor: '#B7CEF4', borderRadius: 12, backgroundColor: colors.surface, flexDirection: 'row', alignItems: 'center' },
  amountInput: { flex: 1, color: colors.ink, fontSize: 24, fontWeight: '900' }, currency: { color: colors.muted, fontSize: 12 },
  quoteCard: { padding: 16, borderRadius: 14, backgroundColor: colors.primarySoft, borderWidth: 1, borderColor: '#D5E5FA' },
  quoteLabel: { color: colors.muted, fontSize: 9 }, quoteValue: { color: colors.primaryDark, fontSize: 21, fontWeight: '900', marginTop: 6 },
  meta: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 5 }, operator: { color: colors.muted, fontSize: 9, lineHeight: 14 },
  primary: { minHeight: 50, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  primaryText: { color: colors.surface, fontSize: 12, fontWeight: '900' }, disabled: { opacity: 0.45 }, disclosure: { color: colors.muted, fontSize: 9, lineHeight: 15, textAlign: 'center' },
  back: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start' }, backText: { color: colors.primary, fontSize: 11, fontWeight: '800' },
  summaryCard: { padding: 16, gap: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 }, summaryLabel: { color: colors.muted, fontSize: 10 }, summaryValue: { flex: 1, color: colors.ink, fontSize: 11, fontWeight: '800', textAlign: 'right' },
  rules: { padding: 14, gap: 7, borderRadius: 12, backgroundColor: colors.primarySoft }, rule: { color: colors.muted, fontSize: 9, lineHeight: 15 },
  centered: { flex: 1, padding: 28, alignItems: 'center', justifyContent: 'center' }, successIcon: { width: 82, height: 82, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.greenSoft },
  successTitle: { color: colors.ink, fontSize: 23, fontWeight: '900', marginTop: 18 }, successText: { color: colors.muted, fontSize: 11, lineHeight: 18, textAlign: 'center', marginTop: 9, marginBottom: 22 },
});
