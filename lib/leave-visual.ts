// Leave Type Visual Configuration Enhancement (feedback 639fdf77).
//
// Single source of truth for the OPTIONAL, DISPLAY-ONLY per-leave-type visual config: a colour theme (fixed
// 7-token palette) + an icon (curated Lucide registry). Shared by:
//   - core/admin.ts updateLeaveType — validation allow-lists (LEAVE_COLOR_TOKENS / LEAVE_ICON_KEYS)
//   - components/leave-type-panel.tsx — the admin "Leave Type Visual Configuration" sub-form
//   - app/me/page.tsx — the employee self-service Leave tab renders leaveVisual({...}).Icon + chipClass
//
// GUARDRAIL: nothing here is ever consulted for entitlement / eligibility / workflow / calculation. It only
// decides how a leave type LOOKS. Unconfigured (both null) reproduces today's exact ESS appearance via the
// code-keyed → _default fallback below.

import {
  Palmtree,
  Thermometer,
  Stethoscope,
  Baby,
  Heart,
  HeartHandshake,
  GraduationCap,
  Cake,
  Plane,
  Home,
  Gift,
  CalendarDays,
  CircleSlash,
  Umbrella,
  Briefcase,
  Users,
  type LucideIcon,
} from 'lucide-react';

// ── Colour palette ────────────────────────────────────────────────────────────────────────────────────
// The fixed 7 tokens the admin can pick from (feedback: Blue/Green/Orange/Purple/Red/Teal/Grey). Each maps
// to a chip (background + text) with explicit light + dark classes, reusing the same Tailwind colour
// vocabulary as components/planned-absences.tsx so the ESS chips speak the same visual language.
export const LEAVE_COLORS = {
  blue: {
    chip: 'bg-sky-100 text-sky-800 dark:bg-sky-500/30 dark:text-sky-50',
    bg: 'bg-sky-100 dark:bg-sky-500/30',
    text: 'text-sky-800 dark:text-sky-50',
  },
  green: {
    chip: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/30 dark:text-emerald-50',
    bg: 'bg-emerald-100 dark:bg-emerald-500/30',
    text: 'text-emerald-800 dark:text-emerald-50',
  },
  orange: {
    chip: 'bg-amber-100 text-amber-800 dark:bg-amber-500/30 dark:text-amber-50',
    bg: 'bg-amber-100 dark:bg-amber-500/30',
    text: 'text-amber-800 dark:text-amber-50',
  },
  purple: {
    chip: 'bg-violet-100 text-violet-800 dark:bg-violet-500/30 dark:text-violet-50',
    bg: 'bg-violet-100 dark:bg-violet-500/30',
    text: 'text-violet-800 dark:text-violet-50',
  },
  red: {
    chip: 'bg-rose-100 text-rose-800 dark:bg-rose-500/30 dark:text-rose-50',
    bg: 'bg-rose-100 dark:bg-rose-500/30',
    text: 'text-rose-800 dark:text-rose-50',
  },
  teal: {
    chip: 'bg-teal-100 text-teal-800 dark:bg-teal-500/30 dark:text-teal-50',
    bg: 'bg-teal-100 dark:bg-teal-500/30',
    text: 'text-teal-800 dark:text-teal-50',
  },
  grey: {
    chip: 'bg-slate-100 text-slate-800 dark:bg-slate-500/30 dark:text-slate-50',
    bg: 'bg-slate-100 dark:bg-slate-500/30',
    text: 'text-slate-800 dark:text-slate-50',
  },
} as const satisfies Record<string, { chip: string; bg: string; text: string }>;

export type LeaveColorToken = keyof typeof LEAVE_COLORS;

/** The closed 7-token allow-list — exported for service validation + admin swatch rendering. */
export const LEAVE_COLOR_TOKENS = Object.keys(LEAVE_COLORS) as LeaveColorToken[];

export function isLeaveColorToken(v: string): v is LeaveColorToken {
  return Object.prototype.hasOwnProperty.call(LEAVE_COLORS, v);
}

// ── Icon registry ─────────────────────────────────────────────────────────────────────────────────────
// A curated allow-list of leave-related icons (validated on write + small bundle). Each entry carries
// `keywords` so the admin picker can filter by keyword ("sick", "baby", "holiday", …). The keys cover the
// reporter's example set: Annual/Sick/Maternity/Paternity/Emergency/Marriage/Compassionate/Study/
// Replacement/Birthday/Custom (+ a few common extras).
export const LEAVE_ICONS = {
  palmtree: { Icon: Palmtree, keywords: ['annual', 'vacation', 'holiday', 'beach', 'palm', 'rest'] },
  plane: { Icon: Plane, keywords: ['travel', 'trip', 'vacation', 'annual', 'flight', 'holiday'] },
  umbrella: { Icon: Umbrella, keywords: ['annual', 'leisure', 'rest', 'holiday', 'beach'] },
  thermometer: { Icon: Thermometer, keywords: ['sick', 'fever', 'ill', 'unwell', 'medical'] },
  stethoscope: { Icon: Stethoscope, keywords: ['sick', 'medical', 'hospital', 'doctor', 'health', 'checkup'] },
  baby: { Icon: Baby, keywords: ['maternity', 'paternity', 'newborn', 'child', 'parental', 'birth'] },
  heart: { Icon: Heart, keywords: ['marriage', 'wedding', 'love', 'anniversary', 'romance'] },
  hearthandshake: { Icon: HeartHandshake, keywords: ['compassionate', 'bereavement', 'sympathy', 'care', 'support', 'condolence'] },
  graduationcap: { Icon: GraduationCap, keywords: ['study', 'exam', 'education', 'training', 'school', 'course'] },
  cake: { Icon: Cake, keywords: ['birthday', 'celebration', 'anniversary'] },
  gift: { Icon: Gift, keywords: ['birthday', 'reward', 'gift', 'celebration', 'present'] },
  home: { Icon: Home, keywords: ['emergency', 'family', 'personal', 'domestic', 'household'] },
  circleslash: { Icon: CircleSlash, keywords: ['unpaid', 'no-pay', 'nopay', 'leave-without-pay', 'absence', 'emergency'] },
  briefcase: { Icon: Briefcase, keywords: ['replacement', 'work', 'business', 'duty', 'toil', 'in-lieu'] },
  users: { Icon: Users, keywords: ['compassionate', 'family', 'team', 'group', 'community'] },
  calendardays: { Icon: CalendarDays, keywords: ['custom', 'general', 'other', 'default', 'calendar', 'day'] },
} as const satisfies Record<string, { Icon: LucideIcon; keywords: string[] }>;

export type LeaveIconKey = keyof typeof LEAVE_ICONS;

/** The closed icon-key allow-list — exported for service validation. */
export const LEAVE_ICON_KEYS = Object.keys(LEAVE_ICONS) as LeaveIconKey[];

export function isLeaveIconKey(v: string): v is LeaveIconKey {
  return Object.prototype.hasOwnProperty.call(LEAVE_ICONS, v);
}

// ── Code-keyed defaults ───────────────────────────────────────────────────────────────────────────────
// When a leave type has NO stored icon, fall back to a sensible default keyed on the seed leave-type CODE,
// then to a universal default. Mirrors components/planned-absences.tsx LEAVE so the two surfaces agree on
// the "obvious" icon for the standard MY leave types.
const CODE_ICON: Record<string, LeaveIconKey> = {
  ANNUAL: 'palmtree',
  SICK: 'thermometer',
  HOSPITALIZATION: 'stethoscope',
  MATERNITY: 'baby',
  PATERNITY: 'baby',
  MARRIAGE: 'heart',
  COMPASSIONATE: 'hearthandshake',
  EMERGENCY: 'home',
  STUDY: 'graduationcap',
  REPLACEMENT: 'briefcase',
  BIRTHDAY: 'cake',
  UNPAID: 'circleslash',
};

const DEFAULT_ICON: LeaveIconKey = 'calendardays';

// ── Resolver ──────────────────────────────────────────────────────────────────────────────────────────
export type LeaveVisualInput = {
  color?: string | null;
  icon?: string | null;
  code?: string | null;
};

export type LeaveVisual = {
  /** The resolved Lucide icon component to render beside the leave type name. Always defined. */
  Icon: LucideIcon;
  /** The chip class string (bg + text, light + dark) to apply to the ESS row, or '' when no theme is set. */
  chipClass: string;
  /** Whether an explicit colour theme was configured (false ⇒ caller keeps system default styling). */
  hasColor: boolean;
  /** The resolved icon key (for debugging / tests). */
  iconKey: LeaveIconKey;
};

/**
 * Resolve a leave type's stored visual config into a renderable icon + chip class.
 *
 * Fallback order per the spec: stored value → code-keyed default → universal `_default`.
 *   - icon: stored icon key (if valid) → CODE_ICON[code] → DEFAULT_ICON (calendardays).
 *   - colour: stored token (if valid) → '' (no chip). We deliberately do NOT invent a colour from the code:
 *     "no colour configured ⇒ system default styling" is a hard requirement, so the code-keyed fallback
 *     applies only to the ICON.
 */
export function leaveVisual(input: LeaveVisualInput): LeaveVisual {
  const iconKey: LeaveIconKey =
    input.icon && isLeaveIconKey(input.icon)
      ? input.icon
      : (input.code && CODE_ICON[input.code]) || DEFAULT_ICON;
  const hasColor = !!(input.color && isLeaveColorToken(input.color));
  const chipClass = hasColor ? LEAVE_COLORS[input.color as LeaveColorToken].chip : '';
  return { Icon: LEAVE_ICONS[iconKey].Icon, chipClass, hasColor, iconKey };
}
