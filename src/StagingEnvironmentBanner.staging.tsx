import { StyleSheet, Text, View } from 'react-native';
import { colors } from './theme';

export function StagingEnvironmentBanner() {
  return <View accessibilityRole="text" accessibilityLabel="测试环境" style={styles.bar}>
    <View style={styles.dot} />
    <Text style={styles.label}>测试环境</Text>
    <Text style={styles.separator}>·</Text>
    <Text style={styles.meta}>数据与正式环境隔离</Text>
  </View>;
}

const styles = StyleSheet.create({
  bar: {
    minHeight: 26,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface,
  },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 6, backgroundColor: colors.primary },
  label: { color: colors.primaryDark, fontSize: 10, fontWeight: '900' },
  separator: { color: colors.subtle, fontSize: 10, marginHorizontal: 5 },
  meta: { color: colors.muted, fontSize: 9, fontWeight: '700' },
});
