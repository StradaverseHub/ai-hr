/** One icon vocabulary for the app: an SF Symbol on iOS, the matching Material symbol on Android (expo-symbols). */
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ColorValue } from 'react-native';

export const ICONS = {
  leave: { ios: 'calendar.badge.plus', android: 'event_available' },
  overtime: { ios: 'clock.badge.checkmark', android: 'more_time' },
  payslip: { ios: 'banknote', android: 'payments' },
  attendance: { ios: 'list.bullet.clipboard', android: 'fact_check' },
  approvals: { ios: 'checkmark.seal', android: 'approval' },
  teamCalendar: { ios: 'calendar', android: 'calendar_month' },
  directory: { ios: 'person.2', android: 'groups' },
  profile: { ios: 'person.crop.circle', android: 'account_circle' },
  settings: { ios: 'gearshape', android: 'settings' },
  faceId: { ios: 'faceid', android: 'face' },
  touchId: { ios: 'touchid', android: 'fingerprint' },
  lock: { ios: 'lock.shield', android: 'shield_lock' },
  eye: { ios: 'eye', android: 'visibility' },
  eyeOff: { ios: 'eye.slash', android: 'visibility_off' },
  chevron: { ios: 'chevron.right', android: 'chevron_right' },
  bell: { ios: 'bell', android: 'notifications' },
  search: { ios: 'magnifyingglass', android: 'search' },
  phone: { ios: 'phone', android: 'call' },
  mail: { ios: 'envelope', android: 'mail' },
  clock: { ios: 'clock', android: 'schedule' },
  sparkle: { ios: 'sparkles', android: 'auto_awesome' },
  away: { ios: 'airplane', android: 'flight' },
} as const satisfies Record<string, SymbolViewProps['name']>;
export type IconName = keyof typeof ICONS;

export function Icon({ name, color, size = 22 }: { name: IconName; color: ColorValue; size?: number }) {
  return <SymbolView name={ICONS[name]} tintColor={color} size={size} accessibilityElementsHidden importantForAccessibility="no" />;
}
