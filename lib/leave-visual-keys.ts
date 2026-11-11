// Leave Type Visual Configuration (feedback 639fdf77) — the closed allow-lists only, with no dependencies.
//
// core/admin.ts updateLeaveType validates a stored colour/icon against these lists on the server. They live
// apart from lib/leave-visual.ts because that module maps each icon key to its Lucide component, and Lucide
// creates a React context when it loads. A server module graph loaded under the `react-server` condition
// (the notification email sweep, the operator probation runtime, the bulk-job worker entry) has no
// createContext, so it must never reach Lucide just to validate a string. lib/leave-visual.ts keys its
// palette and icon registry by these types, so the compiler checks they cover exactly these keys.

const COLOR_TOKENS = ['blue', 'green', 'orange', 'purple', 'red', 'teal', 'grey'] as const;

export type LeaveColorToken = (typeof COLOR_TOKENS)[number];

/** The fixed 7 colour tokens the admin can pick from (feedback: Blue/Green/Orange/Purple/Red/Teal/Grey). */
export const LEAVE_COLOR_TOKENS: LeaveColorToken[] = [...COLOR_TOKENS];

const COLOR_TOKEN_SET: ReadonlySet<string> = new Set(COLOR_TOKENS);

export function isLeaveColorToken(v: string): v is LeaveColorToken {
  return COLOR_TOKEN_SET.has(v);
}

const ICON_KEYS = [
  'palmtree',
  'plane',
  'umbrella',
  'thermometer',
  'stethoscope',
  'baby',
  'heart',
  'hearthandshake',
  'graduationcap',
  'cake',
  'gift',
  'home',
  'circleslash',
  'briefcase',
  'users',
  'calendardays',
] as const;

export type LeaveIconKey = (typeof ICON_KEYS)[number];

/** The curated icon-key allow-list, in the admin picker's order. */
export const LEAVE_ICON_KEYS: LeaveIconKey[] = [...ICON_KEYS];

const ICON_KEY_SET: ReadonlySet<string> = new Set(ICON_KEYS);

export function isLeaveIconKey(v: string): v is LeaveIconKey {
  return ICON_KEY_SET.has(v);
}
