/**
 * Shared building blocks. Deliberately small: a screen, a card, a label/value row, and the one component
 * every data screen needs — a truthful loading / unavailable / error state with a retry that never signs
 * anyone out.
 */
import { MOBILE_ACCENTS } from '../../lib/mobile-design';
import { TenantBrand, useTenantDesign } from './design';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { UnavailableError } from './errors';
import { t } from './i18n';

export const colors = {
  bg: '#F5F6F8',
  card: '#FFFFFF',
  text: '#15171A',
  muted: '#5F6670',
  border: '#E3E6EA',
  accent: '#1F5EFF',
  warn: '#9A5B00',
  danger: '#B42318',
} as const;

export function Screen({
  children,
  refreshing = false,
  onRefresh,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const { palette, reload } = useTenantDesign();
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: palette.bg }]} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={() => { reload(); onRefresh(); }} /> : undefined}
      >
        <TenantBrand />{children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const { palette } = useTenantDesign();
  return <Text style={[styles.title, { color: palette.text }]}>{children}</Text>;
}

export function SectionLabel({ children }: { children: ReactNode }) {
  const { palette } = useTenantDesign();
  return <Text style={[styles.section, { color: palette.muted }]}>{children}</Text>;
}

export function Card({ children }: { children: ReactNode }) {
  const { palette, design } = useTenantDesign();
  return <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border, borderRadius: design.corners === 'soft' ? 18 : 3 }]}>{children}</View>;
}

export function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  const { palette } = useTenantDesign();
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: palette.muted }]}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.strong, { color: palette.text }]}>{value}</Text>
    </View>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  const { palette } = useTenantDesign();
  return <Text style={[styles.muted, { color: palette.muted }]}>{children}</Text>;
}

export function Button({ title, onPress, kind = 'primary', disabled = false }: { title: string; onPress: () => void; kind?: 'primary' | 'quiet'; disabled?: boolean }) {
  const { palette, design } = useTenantDesign();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: MOBILE_ACCENTS[design.accent].button, borderRadius: design.corners === 'soft' ? 18 : 6 }, kind === 'quiet' && styles.buttonQuiet, kind === 'quiet' && { borderColor: palette.border }, (pressed || disabled) && { opacity: 0.7 }]}
    >
      <Text style={[styles.buttonText, { color: MOBILE_ACCENTS[design.accent].onButton }, kind === 'quiet' && [styles.buttonTextQuiet, { color: palette.accent }]]}>{title}</Text>
    </Pressable>
  );
}

/** Loading, or a failure told apart: "can't reach us, still signed in" vs a plain error. Null when there is data. */
export function LoadState({ loading, error, onRetry }: { loading: boolean; error: Error | null; onRetry: () => void }) {
  const { palette } = useTenantDesign();
  if (error) {
    return (
      <Card>
        <Text style={[styles.body, { color: palette.text }]}>{error instanceof UnavailableError ? t('unavailable') : t('genericError')}</Text>
        <Button title={t('retry')} onPress={onRetry} kind="quiet" />
      </Card>
    );
  }
  if (loading) return <ActivityIndicator style={{ marginTop: 24 }} accessibilityLabel={t('loading')} />;
  return null;
}

/** Leave days: at most two decimals, trailing zeros dropped, singular for exactly one. */
export function fmtDays(n: number | null): string {
  if (n == null) return '—';
  const s = String(Math.round(n * 100) / 100);
  return n === 1 ? t('day', { n: s }) : t('days', { n: s });
}

/**
 * Money arrives as a decimal STRING and is formatted as a string: thousands separators on the integer
 * part, two decimals. It is never parsed to a float — the app does no arithmetic on money.
 */
export function fmtMoney(v: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v);
  if (!m) return v;
  const [, sign, int, frac = ''] = m;
  return `${sign}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(frac + '00').slice(0, 2)}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 16, paddingBottom: 32, gap: 12 },
  title: { fontSize: 26, fontWeight: '700', color: colors.text, marginBottom: 4 },
  section: { fontSize: 13, fontWeight: '600', color: colors.muted, textTransform: 'uppercase', marginTop: 8 },
  card: { backgroundColor: colors.card, borderRadius: 14, padding: 16, gap: 8, borderWidth: 1, borderColor: colors.border },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
  rowLabel: { fontSize: 15, color: colors.muted, flexShrink: 1 },
  rowValue: { fontSize: 15, color: colors.text, fontVariant: ['tabular-nums'] },
  strong: { fontSize: 17, fontWeight: '700' },
  muted: { fontSize: 14, color: colors.muted },
  body: { fontSize: 15, color: colors.text },
  button: { backgroundColor: colors.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  buttonQuiet: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  buttonTextQuiet: { color: colors.accent },
});
