/**
 * Shared building blocks. Deliberately small: a screen, a card, a label/value row, and the one component
 * every data screen needs — a truthful loading / unavailable / error state with a retry that never signs
 * anyone out.
 */
import { DesignText as Text, TenantBrand, useTenantDesign } from './design';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
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
  back = false,
  footer,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** A detail screen: the compact header back arrow (HeaderBack) instead of a full-width "Back" button. */
  back?: boolean;
  /** Pinned under the scrolling content (above the tab bar on a tab screen): a screen's one bottom action bar. */
  footer?: ReactNode;
}) {
  const { palette, reload, design } = useTenantDesign();
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: palette.bg }]} edges={design.schemaVersion === 2 && design.composition.navigation.style === 'top' ? [] : ['top']}>
      <ScrollView
        // A tap on a button while the keyboard is up acts at once (it used to only dismiss the keyboard, and the shifted
        // layout could put the next tap on another control).
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.scroll, design.schemaVersion === 2 && { padding: design.composition.layout.padding, gap: design.composition.layout.gap, paddingBottom: 32 }]}
        refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={() => { reload(); onRefresh(); }} /> : undefined}
      >
        {back ? <HeaderBack /> : null}<TenantBrand />{children}
      </ScrollView>
      {footer ?? null}
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const { palette, design } = useTenantDesign();
  return <Text style={[styles.title, { color: palette.text, ...(design.schemaVersion === 2 ? { fontSize: 29 } : {}) }]}>{children}</Text>;
}

export function SectionLabel({ children }: { children: ReactNode }) {
  const { palette } = useTenantDesign();
  return <Text style={[styles.section, { color: palette.muted }]}>{children}</Text>;
}

export function Card({ children }: { children: ReactNode }) {
  const { palette, design } = useTenantDesign();
  return <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border, borderRadius: design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 18 : 3 }]}>{children}</View>;
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

/**
 * Also the app's chip: a row of Buttons with the chosen one `primary`. Never disable the chosen chip to mark it — the
 * disabled fade turned the tenant colour into a different tint; pass `selected` for assistive technology instead.
 * Every button is at least 44×44 pt with side padding, so a one-glyph "‹" is a touch target, not a sliver.
 */
export function Button({ title, onPress, kind = 'primary', disabled = false,accessibilityLabel,selected }: { title: string; onPress: () => void; kind?: 'primary' | 'quiet'; disabled?: boolean;accessibilityLabel?:string;selected?:boolean }) {
  const { palette, design } = useTenantDesign();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={selected === undefined ? { disabled } : { disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: design.schemaVersion === 2 && design.composition.layout.button !== 'solid' ? design.composition.layout.button === 'soft' ? palette.card : 'transparent' : palette.button, borderColor: palette.text, borderWidth: design.schemaVersion === 2 && design.composition.layout.button === 'outline' ? 1 : 0, borderRadius: design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 18 : 6 }, kind === 'quiet' && styles.buttonQuiet, kind === 'quiet' && { borderColor: palette.border }, (pressed || disabled) && { opacity: 0.7 }]}
    >
      <Text style={[styles.buttonText, { color: design.schemaVersion === 2 && design.composition.layout.button !== 'solid' ? palette.text : palette.onButton }, kind === 'quiet' && [styles.buttonTextQuiet, { color: palette.accent }]]}>{title}</Text>
    </Pressable>
  );
}

/**
 * The one back control of a detail screen: a compact "‹" at the top-left, a 44×44 pt target, announced as "Back".
 * Replaces the full-width quiet "Back" button every detail screen used to end with.
 */
/** `onPress` overrides the stack's back for an in-screen panel (e.g. a list that replaced the form). */
export function HeaderBack({ onPress }: { onPress?: () => void } = {}) {
  const { palette } = useTenantDesign();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={t('back')} hitSlop={8} onPress={onPress ?? (() => router.back())}
      style={({ pressed }) => [styles.back, pressed && { opacity: 0.6 }]}>
      <Text style={{ color: palette.accent, fontSize: 30, lineHeight: 32 }}>‹</Text>
    </Pressable>
  );
}

/** A plain list row: a label, an optional value, a chevron. The whole row is the 44 pt+ target. */
export function ListRow({ label, value, onPress, accessibilityLabel }: { label: string; value?: string | null; onPress: () => void; accessibilityLabel?: string }) {
  const { palette } = useTenantDesign();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? (value ? `${label}, ${value}` : label)} onPress={onPress}
      style={({ pressed }) => [styles.listRow, { borderColor: palette.border }, pressed && { opacity: 0.6 }]}>
      <Text style={{ color: palette.text, fontSize: 16, flex: 1 }}>{label}</Text>
      {value ? <Text style={{ color: palette.muted, fontSize: 15, fontVariant: ['tabular-nums'] }}>{value}</Text> : null}
      <Text style={{ color: palette.muted, fontSize: 20 }}>›</Text>
    </Pressable>
  );
}

/**
 * A short line with its longer explanation behind an "i": the explanation is still one tap away and read in full by a
 * screen reader (the control's hint), so moving an assurance here never removes it.
 */
export function InfoNote({ short, detail }: { short: string; detail: string }) {
  const { palette } = useTenantDesign();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 4 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={short} accessibilityHint={detail} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}
        style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[styles.muted, { color: palette.muted, flexShrink: 1 }]}>{short}</Text>
        <Text style={{ color: palette.accent, fontSize: 16 }}>ⓘ</Text>
      </Pressable>
      {open ? <Text style={[styles.muted, { color: palette.muted }]}>{detail}</Text> : null}
    </View>
  );
}

/**
 * A compact choice chip: a 44 pt touch height but only as wide as its words (12 pt side padding), so a row of them
 * wraps instead of stacking full-width buttons. The chosen one is filled; `selected` is announced.
 */
export function Chip({ title, onPress, selected = false, disabled = false, accessibilityLabel }: { title: string; onPress: () => void; selected?: boolean; disabled?: boolean; accessibilityLabel?: string }) {
  const { palette } = useTenantDesign();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.chip, { borderColor: selected ? palette.accent : palette.border, backgroundColor: selected ? palette.accent : 'transparent' }, (pressed || disabled) && { opacity: 0.7 }]}>
      <Text style={{ color: selected ? palette.bg : palette.text, fontSize: 15, fontWeight: selected ? '600' : '400' }}>{title}</Text>
    </Pressable>
  );
}

/** A server-authored note kept to two muted lines; the "i" shows the whole text (and a screen reader reads it all). */
export function NoteLine({ text }: { text: string }) {
  const { palette } = useTenantDesign();
  const [open, setOpen] = useState(false);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={text} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text numberOfLines={open ? undefined : 2} style={[styles.muted, { color: palette.muted, flexShrink: 1 }]}>{text}</Text>
      <Text style={{ color: palette.accent, fontSize: 16 }}>ⓘ</Text>
    </Pressable>
  );
}

/** Distinguish first load, same-scope refresh and retained data after a failed refresh. */
export function LoadState({ loading, error, onRetry,hasData=false }: { loading: boolean; error: Error | null; onRetry: () => void;hasData?:boolean }) {
  const { palette } = useTenantDesign();
  if (error) {
    return (
      <Card>
        <Text style={[styles.body, { color: palette.text }]}>{error instanceof UnavailableError ? t('unavailable') : t('genericError')}</Text>
        {hasData&&<Muted>{t('staleData')}</Muted>}
        {error instanceof UnavailableError&&!!error.retryAfter&&<Muted>{t(error.retryAfter<=1?'retryAfterOne':'retryAfter',{seconds:Math.ceil(error.retryAfter)})}</Muted>}
        {error instanceof UnavailableError&&!!error.supportId&&<Muted>{t('supportReference',{id:error.supportId})}</Muted>}
        <Button title={t('retry')} onPress={onRetry} kind="quiet" />
      </Card>
    );
  }
  if (loading) return hasData?<Muted>{t('refreshing')}</Muted>:<ActivityIndicator style={{ marginTop: 24 }} accessibilityLabel={t('loading')} />;
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
  button: { backgroundColor: colors.accent, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  buttonQuiet: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  buttonTextQuiet: { color: colors.accent },
  chip: { minHeight: 44, minWidth: 44, paddingHorizontal: 12, borderWidth: 1, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  back: { alignSelf: 'flex-start', minWidth: 44, minHeight: 44, justifyContent: 'center', marginLeft: -6 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingVertical: 12, borderBottomWidth: 1 },
});
