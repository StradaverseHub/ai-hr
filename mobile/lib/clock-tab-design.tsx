import { Pressable, StyleSheet, View } from 'react-native';
import type { ClockResponse } from './api';
import { DesignText as Text, useTenantDesign } from './design';
import { Icon } from './icon';
import { appLocale, t } from './i18n';

const zone = 'Asia/Kuala_Lumpur';

export function useClockTabTheme() {
  const { appearance, design, palette } = useTenantDesign();
  const dark = appearance === 'dark';
  const fieldNotes = design.schemaVersion === 1;
  const colors = dark
    ? { surface: '#111214', sheet: '#1d1f22', rule: '#3e434a', success: '#9ee1bd', successSurface: '#20382c' }
    : { surface: '#f6f7f9', sheet: '#ffffff', rule: '#d8dce2', success: '#25664c', successSurface: '#e7f3eb' };
  return {
    ...colors,
    ...(fieldNotes ? {} : { surface: palette.bg, sheet: palette.card, rule: palette.border, success: palette.text, successSurface: palette.bg }),
    text: palette.text,
    muted: palette.muted,
    accent: palette.accent,
    button: fieldNotes && design.accent === 'jade' ? '#c72b20' : palette.button,
    onButton: palette.onButton,
    fieldNotes,
  };
}

type Theme = ReturnType<typeof useClockTabTheme>;
type Receipt = { action: 'in' | 'out'; time: string; review: boolean };

export function ClockShiftTicket({ theme, current, receipt, action, busy, uncertain }: {
  theme: Theme;
  current: NonNullable<ClockResponse['state']>;
  receipt?: Receipt;
  action: 'in' | 'out';
  busy: boolean;
  uncertain: boolean;
}) {
  const latest = current.captures.at(-1);
  const recorded = receipt ?? (latest && { action: latest.direction, time: latest.recordedAt, review: !!latest.reviewReasons?.length });
  const openTime = current.clockedIn ? current.openSince : null;
  const time = recorded?.time ?? openTime;
  const confirmed = !!time && Number.isFinite(Date.parse(time)) && !busy && !uncertain;
  const status = uncertain ? t('clockUncertain') : busy ? t('preparingClock')
    : confirmed ? t((recorded?.action ?? 'in') === 'in' ? 'clockStatusIn' : 'clockStatusOut')
      : current.clockedIn ? t('onTheClock') : action === 'in' ? t('clockReadyIn') : t('offTheClock');
  const shift = current.shift;

  return <View style={{ gap: 22 }}>
    <Text style={{ color: theme.muted, fontSize: 14, fontWeight: '600' }}>
      {new Date(current.date + 'T12:00:00+08:00').toLocaleDateString(appLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: zone })}
    </Text>
    <View style={[styles.ticket, { backgroundColor: theme.sheet, borderColor: theme.rule }]}>
      <View style={styles.schedule}>
        <Text accessibilityRole="header" style={{ color: theme.text, fontSize: 25, ...(theme.fieldNotes ? { fontFamily: 'FieldEditorial' } : { fontWeight: '700' }) }}>{t('clockShiftTitle')}</Text>
        {shift.start && shift.end ? <>
          <View style={styles.shiftTimes}>
            <ShiftTime label={t('clockShiftStarts')} value={shift.start.slice(0, 5)} theme={theme} />
            <ShiftTime label={t('clockShiftEnds')} value={shift.end.slice(0, 5)} theme={theme} end />
          </View>
          <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.scale}>
            <View style={[styles.axis, { backgroundColor: theme.muted }]} />
            <View style={[styles.dot, { backgroundColor: theme.accent }]} />
            {Array.from({ length: 8 }, (_, index) => <View key={index} style={[styles.tick, { backgroundColor: theme.muted }]} />)}
            <View style={[styles.dot, { borderColor: theme.muted, borderWidth: 1.5, backgroundColor: theme.sheet }]} />
          </View>
        </> : <Text style={{ color: theme.muted, fontSize: 15 }}>{t('noShift')}</Text>}
      </View>
      <View style={[styles.seam, { borderColor: theme.rule }]}>
        <View pointerEvents="none" style={[styles.notch, { left: -6, backgroundColor: theme.surface }]} />
        <View pointerEvents="none" style={[styles.notch, { right: -6, backgroundColor: theme.surface }]} />
      </View>
      <View accessibilityLiveRegion="polite" style={styles.receipt}>
        <View style={styles.statusRow}>
          <View accessible={false} style={[styles.statusMark, confirmed
            ? { backgroundColor: theme.successSurface }
            : { borderColor: theme.rule, borderWidth: 1 }]}>
            {confirmed ? <Icon name="check" color={theme.success} size={14} />
              : <View style={{ width: 8, height: 1, backgroundColor: theme.muted }} />}
          </View>
          <Text style={{ flex: 1, color: theme.text, fontSize: 15, fontWeight: '700' }}>{status}</Text>
          {confirmed && <Text style={{ color: theme.text, fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] }}>
            {new Date(time!).toLocaleTimeString(appLocale(), { hour: 'numeric', minute: '2-digit', timeZone: zone })}
          </Text>}
        </View>
        {confirmed && recorded?.review && <Text style={{ color: theme.muted, fontSize: 13 }}>{t('clockNeedsReview')}</Text>}
      </View>
    </View>
  </View>;
}

function ShiftTime({ label, value, theme, end }: { label: string; value: string; theme: Theme; end?: boolean }) {
  return <View style={{ flex: 1, gap: 3, alignItems: end ? 'flex-end' : 'flex-start' }}>
    <Text style={{ color: theme.muted, fontSize: 13, fontWeight: '600', textAlign: end ? 'right' : 'left' }}>{label}</Text>
    <Text adjustsFontSizeToFit minimumFontScale={0.7} numberOfLines={1} style={{ color: theme.text, fontSize: 34, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{value}</Text>
  </View>;
}

export function ClockTabAction({ theme, label, busy, disabled, onPress }: {
  theme: Theme; label: string; busy: boolean; disabled: boolean; onPress: () => void;
}) {
  return <View style={[styles.footer, { backgroundColor: theme.surface }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ busy, disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.primary, { backgroundColor: theme.button, opacity: disabled ? 0.55 : pressed ? 0.78 : 1 }]}>
      <View style={{ width: 20 }} />
      <Text style={{ flex: 1, textAlign: 'center', color: theme.onButton, fontSize: 17, fontWeight: '700' }}>{label}</Text>
      <Icon name="arrowRight" color={theme.onButton} size={20} />
    </Pressable>
  </View>;
}

export function ClockTabDetails({ theme, expanded, onPress }: { theme: Theme; expanded: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={onPress}
    style={({ pressed }) => [styles.details, { borderColor: theme.rule, opacity: pressed ? 0.65 : 1 }]}>
    <Icon name="clock" color={theme.muted} size={20} />
    <Text style={{ flex: 1, color: theme.text, fontSize: 15, fontWeight: '600' }}>{t(expanded ? 'clockHideDetails' : 'clockShowDetails')}</Text>
    <Icon name={expanded ? 'chevronDown' : 'chevron'} color={theme.muted} size={15} />
  </Pressable>;
}

const styles = StyleSheet.create({
  ticket: { borderWidth: 1, borderRadius: 15 },
  schedule: { padding: 19, gap: 14 },
  shiftTimes: { flexDirection: 'row', gap: 12 },
  scale: { height: 10, justifyContent: 'space-between', flexDirection: 'row', alignItems: 'center' },
  axis: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth },
  tick: { width: StyleSheet.hairlineWidth, height: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  seam: { borderTopWidth: 1, borderStyle: 'dashed' },
  notch: { position: 'absolute', top: -6, width: 12, height: 12, borderRadius: 6 },
  receipt: { paddingHorizontal: 19, paddingVertical: 15, gap: 6 },
  statusRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  statusMark: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  footer: { paddingHorizontal: 20, paddingVertical: 12 },
  primary: { minHeight: 54, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8, flexDirection: 'row', gap: 8, alignItems: 'center' },
  details: { minHeight: 48, flexDirection: 'row', gap: 10, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 10 },
});
