/**
 * App copy. ADR-0088 §6 puts mobile strings under a `mobile` namespace in the web's six `messages/*.json`
 * catalogues so there is one translation pipeline; this first slice keeps a local table instead, because
 * the web's i18n guards assert every catalogue key is rendered by a web component and a `mobile`
 * namespace would trip them. Moving these into `messages/` (and teaching the guards about the app) is a
 * named follow-up, not an oversight.
 *
 * Malay is first-class (most Malaysian HR apps ship English-only while many of their 1–2 star reviews are
 * written in Malay). These `ms` strings are machine-drafted and want a native speaker's read.
 */
import { getLocales } from 'expo-localization';

const en = {
  appName: 'AI HR',
  signInTitle: 'Sign in to AI HR',
  signInBody: 'Use the account your employer invited you with.',
  signInButton: 'Sign in',
  signingIn: 'Signing in…',
  signInFailed: 'Sign-in did not complete. Please try again.',
  notConfigured: 'This build is not configured to sign in.',
  unlockTitle: 'AI HR is locked',
  unlockButton: 'Unlock',
  unlockPrompt: 'Unlock AI HR',
  usePasscode: 'Use passcode',
  tabHome: 'Home',
  tabLeave: 'Leave',
  tabInbox: 'Inbox',
  tabMe: 'Me',
  hello: 'Hello, {name}',
  helloNoName: 'Hello',
  needsYou: 'Needs you',
  unreadCount: '{n} unread',
  nothingNeedsYou: 'Nothing needs you right now.',
  annualLeave: 'Annual leave',
  canApplyFor: 'You can apply for',
  balance: 'Balance',
  taken: 'Taken',
  pending: 'Pending approval',
  days: '{n} days',
  day: '{n} day',
  sharedPool: 'Shared with other leave types',
  noLeaveTypes: 'No leave types apply to you yet.',
  latestPayslip: 'Latest payslip',
  noPayslips: 'No payslips have been released to you yet.',
  payslips: 'Payslips',
  netPay: 'Net pay',
  grossPay: 'Gross',
  deductions: 'Deductions',
  inboxEmpty: 'You have no notifications.',
  employments: 'Employment',
  signOut: 'Sign out',
  retry: 'Try again',
  unavailable: 'Can’t reach AI HR right now. You are still signed in.',
  genericError: 'Something went wrong. Please try again.',
  payrollOff: 'Payslips are not enabled for your company.',
  notificationsOff: 'Notifications are not enabled for your company.',
  loading: 'Loading…',
} as const;

export type MessageKey = keyof typeof en;

const ms: Record<MessageKey, string> = {
  appName: 'AI HR',
  signInTitle: 'Log masuk ke AI HR',
  signInBody: 'Gunakan akaun yang dijemput oleh majikan anda.',
  signInButton: 'Log masuk',
  signingIn: 'Sedang log masuk…',
  signInFailed: 'Log masuk tidak selesai. Sila cuba lagi.',
  notConfigured: 'Binaan ini tidak dikonfigurasi untuk log masuk.',
  unlockTitle: 'AI HR dikunci',
  unlockButton: 'Buka kunci',
  unlockPrompt: 'Buka kunci AI HR',
  usePasscode: 'Guna kod laluan',
  tabHome: 'Utama',
  tabLeave: 'Cuti',
  tabInbox: 'Peti masuk',
  tabMe: 'Saya',
  hello: 'Hai, {name}',
  helloNoName: 'Hai',
  needsYou: 'Perlu tindakan anda',
  unreadCount: '{n} belum dibaca',
  nothingNeedsYou: 'Tiada apa-apa yang perlu tindakan anda sekarang.',
  annualLeave: 'Cuti tahunan',
  canApplyFor: 'Anda boleh memohon',
  balance: 'Baki',
  taken: 'Diambil',
  pending: 'Menunggu kelulusan',
  days: '{n} hari',
  day: '{n} hari',
  sharedPool: 'Dikongsi dengan jenis cuti lain',
  noLeaveTypes: 'Belum ada jenis cuti yang berkenaan dengan anda.',
  latestPayslip: 'Slip gaji terkini',
  noPayslips: 'Belum ada slip gaji yang dikeluarkan kepada anda.',
  payslips: 'Slip gaji',
  netPay: 'Gaji bersih',
  grossPay: 'Kasar',
  deductions: 'Potongan',
  inboxEmpty: 'Anda tiada pemberitahuan.',
  employments: 'Pekerjaan',
  signOut: 'Log keluar',
  retry: 'Cuba lagi',
  unavailable: 'Tidak dapat menghubungi AI HR sekarang. Anda masih log masuk.',
  genericError: 'Berlaku ralat. Sila cuba lagi.',
  payrollOff: 'Slip gaji tidak diaktifkan untuk syarikat anda.',
  notificationsOff: 'Pemberitahuan tidak diaktifkan untuk syarikat anda.',
  loading: 'Memuatkan…',
};

const catalogues: Record<string, Record<MessageKey, string>> = { en, ms };

/** The device language if we have it, else English. Sent to the API as Accept-Language too. */
export function appLocale(): 'en' | 'ms' {
  const code = getLocales()[0]?.languageCode ?? 'en';
  return code === 'ms' ? 'ms' : 'en';
}

export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  const table = catalogues[appLocale()] ?? en;
  return (table[key] ?? en[key]).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}
