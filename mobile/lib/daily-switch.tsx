/** The approved tactile instrument. All state and commands come from ClockPanel. */
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { DesignText as Text, useTenantDesign } from './design';
import { Icon } from './icon';
import { DAILY_SWITCH } from './daily-switch-theme';
import { TimeDisplay } from './visual';
import { t } from './i18n';
import { PressSurface } from './motion';

export function InstrumentDock({ children }: { children: ReactNode }) {
  const { appearance, palette } = useTenantDesign();
  const dark = appearance === 'dark';
  return <View style={{ padding: 10, gap: 8, borderRadius: 30, borderCurve: 'continuous', backgroundColor: dark ? '#292e31' : '#e6e7e8', borderWidth: 1, borderColor: dark ? '#4b5258' : '#d7dbe0', boxShadow: dark ? '0px 7px 16px rgba(0,0,0,0.28)' : '0px 7px 16px rgba(16,18,20,0.12)', experimental_backgroundImage: `linear-gradient(145deg, ${dark ? '#353b3f' : '#f7f8f9'} 0%, ${dark ? palette.card : '#dfe2e5'} 100%)` }}>{children}</View>;
}

export function DailySwitch({ working, seconds, disabled, busy, onPress, pendingLabel }: {
  working: boolean; seconds: number; disabled: boolean; busy: boolean; onPress: () => void; pendingLabel?: string;
}) {
  const { palette } = useTenantDesign();
  const label = working ? t('clockOut') : t('clockIn');
  return <InstrumentDock>
    <Pressable accessible={!working} accessibilityElementsHidden={working} importantForAccessibility={working ? "no-hide-descendants" : "auto"} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || busy, busy }} disabled={working || disabled || busy} onPress={onPress}
      style={({ pressed }) => [{ borderRadius: 23, borderCurve: 'continuous', backgroundColor: DAILY_SWITCH.edge, paddingBottom: 7, opacity: disabled && !busy ? .58 : 1 }]}>
      {({ pressed }) => <PressSurface pressed={pressed} disabled={disabled || busy} depth={3} scale={.99} style={{ minHeight: working ? 64 : 164, paddingHorizontal: 20, paddingVertical: working ? 12 : 26, borderRadius: 22, borderCurve: 'continuous', borderWidth: 1, borderColor: '#9db915', backgroundColor: palette.button, experimental_backgroundImage: `linear-gradient(160deg, ${palette.button} 2%, ${palette.button} 64%, ${palette.onButton === DAILY_SWITCH.ink ? '#afdb11' : palette.button} 100%)`, boxShadow: pressed ? 'inset 0px 2px 5px rgba(0,0,0,0.16)' : 'inset 0px 2px 2px rgba(255,255,255,0.70)', flexDirection: 'row', gap: 16, alignItems: 'center', justifyContent: 'center' }}>
        {busy ? <ActivityIndicator color={palette.onButton} size="large" /> : <Icon name="clock" color={palette.onButton} size={working ? 32 : 66} />}
        <Text accessible={false} style={{ color: palette.onButton, fontSize: working ? 36 : 76, fontWeight: '800', letterSpacing: -3 }}>IN</Text>
      </PressSurface>}
    </Pressable>
    {working && <TimeDisplay compact seconds={seconds} label={t('workedTime', { hours: Math.floor(seconds / 3600), minutes: Math.floor(seconds % 3600 / 60).toString().padStart(2, '0') })} />}
    {working ? <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || busy, busy }} disabled={disabled || busy} onPress={onPress}
      style={({ pressed }) => ({ minHeight: 50, borderRadius: 21, padding: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#252a2e', opacity: pressed || disabled ? .65 : 1, boxShadow: 'inset 0px 1px 1px rgba(255,255,255,0.18)' })}><Text style={{ color: '#f6f7fa', fontSize: 19, fontWeight: '600' }}>{busy ? pendingLabel ?? t('preparingClock') : label}</Text></Pressable>
      : <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: palette.text, fontSize: 19, fontWeight: '600', textAlign: 'center', paddingVertical: 4 }}>{busy ? pendingLabel ?? t('preparingClock') : label}</Text>}
  </InstrumentDock>;
}
