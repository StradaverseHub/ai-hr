/** Clock presentation. The existing journey owns every capture, confirmation and receipt. */
import { View } from 'react-native';
import { Button } from './ui';
import { TimeDisplay } from './visual';
import { t } from './i18n';

export function DailySwitch({ working, seconds, disabled, busy, onPress, pendingLabel }: {
  working: boolean; seconds: number; disabled: boolean; busy: boolean; onPress: () => void; pendingLabel?: string;
}) {
  return <View style={{ gap: 8 }}>
    {working && <TimeDisplay compact seconds={seconds} label={t('workedTime', { hours: Math.floor(seconds / 3600), minutes: Math.floor(seconds % 3600 / 60).toString().padStart(2, '0') })} />}
    <Button title={busy ? pendingLabel ?? t('preparingClock') : t(working ? 'clockOut' : 'clockIn')} disabled={disabled || busy} onPress={onPress} />
  </View>;
}
