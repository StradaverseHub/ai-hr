/**
 * M10 (D6) native push and D8 shift reminders — the logic, without React components or the session. mobile/lib/push.tsx
 * mounts it; mobile/lib/session.tsx calls releasePushOnExit before a sign-out clears the tokens (this module never
 * imports the session, so neither file imports the other in a cycle).
 *
 * PUSH (D6). Permission is asked IN CONTEXT only: "Turn on notifications" on the Inbox or "Allow notifications" beside
 * the shift-reminder switch on Me — never at launch. A denied permission never blocks the inbox, which keeps reading over
 * the API. With permission granted and push not turned off on this phone, the device token is enrolled after sign-in
 * (POST v2/push/enrollment, bound by the server to tenant, user and THIS installation — the id the integrity enrollment
 * uses), again when the OS rotates the token, and otherwise at most every RESYNC_MS. "Turn off" and leaving the account
 * (releasePushOnExit: sign-out, company switch) revoke it. An employment switch keeps the same tenant and login, so the
 * binding stays (D6 binds no employment); only the reminders are re-planned.
 *
 * SHIFT REMINDERS (D8). Local notifications planned by shift-reminders.ts from the v2 roster and records, re-planned by
 * requestShiftReminders — cancel every reminder, then schedule the plan, serialised and coalesced. ON by default; the
 * only things kept on the phone are two booleans (the reminder switch and push "turned off"). No roster data, no
 * location, no background fetch.
 */
import { Linking, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import { apiGetV2, apiPostV2 } from './api';
import { assertAuthGeneration, authGeneration } from './auth';
import { config, identityNamespace } from './config';
import { SignInRequiredError, UnavailableError } from './errors';
import { appLocale, t } from './i18n';
import { nativeIntegrityInstallationId } from './submission-native';
import { isShiftReminder, planShiftReminders, reminderWindow, type PlannedReminder } from './shift-reminders';
import { PushEnrollmentResult, PushRevokeResult, type PushPermission, type PushRevokeReason } from '../../lib/mobile-api/v2/push';
import { AttendanceRecordsV2, AttendanceRosterV2 } from '../../lib/mobile-api/v2/attendance';

export const PUSH_CHANNEL = 'aihr-updates';
export const REMINDER_CHANNEL = 'aihr-reminders';
/** Re-enroll an unchanged token at most this often (the server meters enrollment 10/hour per login). */
export const RESYNC_MS = 12 * 3_600_000;
/** Leaving the account never waits longer than this for the server to hear about it. */
export const EXIT_BUDGET_MS = 3000;
const OPT_OUT_KEY = 'aihr.push.optOut', REMINDERS_KEY = 'aihr.reminders.enabled';
const STORE = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

// ── Small stores ─────────────────────────────────────────────────────────────────────────────────────────────────

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) { if (next !== value) { value = next; for (const l of [...listeners]) l(); } },
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  };
}
function serial() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T,>(fn: () => Promise<T>): Promise<T> => { const run = chain.then(fn, fn); chain = run.catch(() => undefined); return run; };
}

// ── This phone's two booleans ────────────────────────────────────────────────────────────────────────────────────

export type PushPreferences = { pushOff: boolean; reminders: boolean };
export const preferences = store<PushPreferences | null>(null);
let loading: Promise<PushPreferences> | null = null;
/** Push not turned off, reminders on — unless this phone says otherwise. Unreadable storage keeps the defaults. */
export function readPushPreferences(): Promise<PushPreferences> {
  const known = preferences.get();
  if (known) return Promise.resolve(known);
  loading ??= (async () => {
    let next: PushPreferences = { pushOff: false, reminders: true };
    try {
      const [off, reminders] = await Promise.all([SecureStore.getItemAsync(OPT_OUT_KEY, STORE), SecureStore.getItemAsync(REMINDERS_KEY, STORE)]);
      next = { pushOff: off === '1', reminders: reminders !== '0' };
    } catch { /* defaults */ }
    preferences.set(preferences.get() ?? next);
    return preferences.get()!;
  })().finally(() => { loading = null; });
  return loading;
}
export async function savePreference(patch: Partial<PushPreferences>) {
  const next = { ...(await readPushPreferences()), ...patch };
  preferences.set(next);
  try {
    if (patch.pushOff !== undefined) await SecureStore.setItemAsync(OPT_OUT_KEY, patch.pushOff ? '1' : '0', STORE);
    if (patch.reminders !== undefined) await SecureStore.setItemAsync(REMINDERS_KEY, patch.reminders ? '1' : '0', STORE);
  } catch { /* the choice still applies until the app restarts */ }
}

// ── Permission and channels ──────────────────────────────────────────────────────────────────────────────────────

export type NotificationPermission = { status: PushPermission; canAskAgain: boolean };
const allowed = (s: PushPermission) => s === 'granted' || s === 'provisional';
function permissionOf(p: Notifications.NotificationPermissionsStatus): NotificationPermission {
  const provisional = p.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  return { status: p.granted ? 'granted' : provisional ? 'provisional' : p.status === 'denied' ? 'denied' : 'undetermined', canAskAgain: p.canAskAgain !== false };
}
export async function readNotificationPermission(): Promise<NotificationPermission> {
  try { return permissionOf(await Notifications.getPermissionsAsync()); } catch { return { status: 'undetermined', canAskAgain: false }; }
}
/** Android 8+ shows a notification only on a channel; both are private on the lock screen (ADR-0088 §3). */
async function ensureChannels() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(PUSH_CHANNEL, { name: t('pushChannelName'), importance: Notifications.AndroidImportance.DEFAULT, lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE, showBadge: false });
  await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL, { name: t('reminderChannelName'), importance: Notifications.AndroidImportance.HIGH, lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE, showBadge: false });
}
/** The OS prompt, only ever from an explicit tap. */
export async function askNotificationPermission(): Promise<NotificationPermission> {
  try {
    await ensureChannels();
    return permissionOf(await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: true } }));
  } catch { return readNotificationPermission(); }
}
export const openNotificationSettings = () => { void Linking.openSettings().catch(() => undefined); };

/** What a notification looks like when it arrives with the app open: a banner of its own generic text, no badge. */
export const PUSH_HANDLER: Notifications.NotificationHandler = {
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
};

// ── Push enrollment ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * checking — not read yet; off — not turned on here (no permission yet, or turned off); denied — the OS says no;
 * on — enrolled and the server can deliver; server_off — enrolled, but this server has no push keys yet;
 * unavailable — this phone could not be enrolled now (no token, offline, refused); module_off — the company does not
 * use notifications; unsupported — not a phone.
 */
export type PushView = 'checking' | 'off' | 'denied' | 'on' | 'server_off' | 'unavailable' | 'module_off' | 'unsupported';
export const pushView = store<{ key: string; value: PushView }>({ key: '', value: 'checking' });
/** One signed-in identity on one connection; a view or enrollment of another identity is never shown or reused. */
export const identityKey = () => JSON.stringify([authGeneration(), identityNamespace(), config.apiUrl]);
let enrolled: { key: string; installationId: string; token: string; at: number; view: PushView } | null = null;
let revokedOff: string | null = null;
/** Forget the in-memory enrollment (any sign-out): the next identity always enrolls afresh. */
export function forgetEnrollment() { enrolled = null; revokedOff = null; }
const pushes = serial();
const platformOf = (): 'ios' | 'android' | null => (Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : null);
const employmentParams = (employmentId: string | null) => (employmentId ? { employmentId } : {});

/** One command, retried once with the SAME requestId when its answer was lost; the server's receipt replays it. */
async function command<T>(send: () => Promise<T>): Promise<T> {
  try { return await send(); }
  catch (error) { if (error instanceof UnavailableError) return send(); throw error; }
}
async function revoke(reason: PushRevokeReason, employmentId: string | null, check: () => void): Promise<boolean> {
  const installationId = await nativeIntegrityInstallationId(check);
  const body = { requestId: randomUUID(), installationId, reason };
  const answer = await command(() => apiPostV2('v2/push/revoke', PushRevokeResult, body, employmentParams(employmentId), { assertCurrent: check }));
  enrolled = null;
  return answer.outcome === 'revoked';
}

async function runPushSync(employmentId: string | null, force: boolean): Promise<PushView> {
  const key = identityKey(), owner = authGeneration(), check = () => assertAuthGeneration(owner);
  const platform = platformOf();
  if (!platform) return 'unsupported';
  const [prefs, permission] = await Promise.all([readPushPreferences(), readNotificationPermission()]);
  if (prefs.pushOff) {
    // Turned off here: make sure the server heard it once per sign-in (a revoke may have failed offline).
    if (revokedOff !== key && allowed(permission.status)) { try { await revoke('turned_off', employmentId, check); revokedOff = key; } catch { /* next time */ } }
    return 'off';
  }
  if (!allowed(permission.status)) return permission.status === 'denied' ? 'denied' : 'off';
  let token: string, installationId: string;
  try {
    await ensureChannels();
    const device = await Notifications.getDevicePushTokenAsync();
    if (typeof device.data !== 'string') return 'unavailable';
    token = device.data;
    installationId = await nativeIntegrityInstallationId(check);
  } catch { return 'unavailable'; }
  if (!force && enrolled && enrolled.key === key && enrolled.installationId === installationId && enrolled.token === token && Date.now() - enrolled.at < RESYNC_MS) return enrolled.view;
  const body = { requestId: randomUUID(), installationId, platform, token, permission: permission.status, locale: appLocale(), appVersion: Constants.expoConfig?.version ?? null };
  let answer: PushEnrollmentResult;
  try { answer = await command(() => apiPostV2('v2/push/enrollment', PushEnrollmentResult, body, employmentParams(employmentId), { assertCurrent: check })); }
  catch (error) { if (error instanceof SignInRequiredError) throw error; return 'unavailable'; }
  if (answer.outcome === 'refused') return answer.code === 'notifications_off' ? 'module_off' : answer.code === 'permission_not_granted' ? 'off' : 'unavailable';
  const view: PushView = answer.delivery === 'available' ? 'on' : 'server_off';
  enrolled = { key, installationId, token, at: Date.now(), view };
  return view;
}
/** Re-read and (re-)enroll if needed; the view follows. Never throws except a definitive sign-in refusal. */
export function syncPush(employmentId: string | null, force = false): Promise<PushView> {
  return pushes(async () => {
    const key = identityKey();
    let value: PushView;
    try { value = await runPushSync(employmentId, force); }
    catch (error) { if (error instanceof SignInRequiredError) throw error; value = 'unavailable'; }
    if (identityKey() === key) pushView.set({ key, value });
    return value;
  });
}

/** Inbox "Turn on notifications": the OS prompt, then enrollment, then the reminders that now may show. */
export async function turnOnNotifications(employmentId: string | null): Promise<PushView> {
  const permission = await askNotificationPermission();
  if (!allowed(permission.status)) { pushView.set({ key: identityKey(), value: permission.status === 'denied' ? 'denied' : 'off' }); return pushView.get().value; }
  await savePreference({ pushOff: false });
  revokedOff = null;
  void requestShiftReminders(employmentId);
  return syncPush(employmentId, true);
}
/** "Turn off": remembered on this phone first, then revoked on the server (retried on a later sync if offline now). */
export async function turnOffNotifications(employmentId: string | null): Promise<void> {
  const key = identityKey(), owner = authGeneration();
  await savePreference({ pushOff: true });
  pushView.set({ key, value: 'off' });
  await pushes(async () => { try { await revoke('turned_off', employmentId, () => assertAuthGeneration(owner)); revokedOff = key; } catch { revokedOff = null; } });
}

/**
 * Leaving this account BEFORE the tokens are cleared: the session's signOut (every sign-out the app asks for) and the
 * Change company exit call this. It removes this phone's shift reminders and revokes its push binding on the server.
 * Bounded by EXIT_BUDGET_MS and never throws: an unreachable server must not keep anyone signed in. A binding the server
 * never heard about (offline, or a session the server already ended) is replaced by the next login on this phone, and
 * the sweep re-checks the login at send time.
 */
export async function releasePushOnExit(intent: 'logout' | 'company', employmentId: string | null): Promise<void> {
  const owner = authGeneration();
  forgetEnrollment();
  const work = (async () => {
    try { await cancelShiftReminders(); } catch { /* the sign-out watcher retries */ }
    try { await revoke(intent === 'company' ? 'company_switch' : 'logout', employmentId, () => assertAuthGeneration(owner)); } catch { /* bounded, best effort */ }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, EXIT_BUDGET_MS); })]);
  clearTimeout(timer);
}

// ── Shift reminders ──────────────────────────────────────────────────────────────────────────────────────────────

/** on — planned; off — switched off; needs_permission / denied — the OS permission; not_offered — no attendance for
 * this employment; unavailable — the roster could not be read now (the previous plan is kept); checking — not yet. */
export type ReminderView = 'checking' | 'on' | 'off' | 'needs_permission' | 'denied' | 'not_offered' | 'unavailable';
export const reminderView = store<{ key: string; value: ReminderView }>({ key: '', value: 'checking' });
const reminders = serial();
/** Run after any reminder plan in flight, so a cancel never interleaves with a schedule. */
export const afterReminders = <T,>(fn: () => Promise<T>) => reminders(fn);
let reminderQueued: Promise<ReminderView> | null = null, reminderFor: string | null = null;

/** Cancel every shift reminder this app scheduled, and nothing else. */
export async function cancelShiftReminders(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const request of scheduled) if (isShiftReminder(request.identifier)) await Notifications.cancelScheduledNotificationAsync(request.identifier);
}
function reminderContent(r: PlannedReminder): Notifications.NotificationContentInput {
  return { title: t('reminderTitle'), body: t(r.kind === 'start' ? 'reminderStartBody' : 'reminderForgotOutBody'), data: { aihrReminder: r.kind }, sound: true };
}
async function runReminders(employmentId: string | null): Promise<ReminderView> {
  const owner = authGeneration(), namespace = identityNamespace();
  const current = () => authGeneration() === owner && identityNamespace() === namespace;
  const [prefs, permission] = await Promise.all([readPushPreferences(), readNotificationPermission()]);
  if (!prefs.reminders) { await cancelShiftReminders(); return 'off'; }
  if (!allowed(permission.status)) { await cancelShiftReminders(); return permission.status === 'denied' ? 'denied' : 'needs_permission'; }
  const params = { ...reminderWindow(Date.now()), ...employmentParams(employmentId) };
  let roster: AttendanceRosterV2;
  try { roster = await apiGetV2('v2/attendance/roster', AttendanceRosterV2, params); }
  catch (error) { if (error instanceof SignInRequiredError) throw error; return 'unavailable'; }
  const records = await apiGetV2('v2/attendance/records', AttendanceRecordsV2, params).catch(() => null);
  if (!current()) return 'unavailable';
  const plan = planShiftReminders(roster, records, Date.now());
  await ensureChannels();
  await cancelShiftReminders();
  if (!current()) return 'unavailable';
  for (const r of plan) {
    await Notifications.scheduleNotificationAsync({
      identifier: r.id, content: reminderContent(r),
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: r.at, channelId: REMINDER_CHANNEL },
    });
  }
  return roster.enabled && roster.employmentId ? 'on' : 'not_offered';
}
/** Re-plan soon. Bursts collapse into one run after the current one; the newest employment wins. */
export function requestShiftReminders(employmentId: string | null): Promise<ReminderView> {
  reminderFor = employmentId;
  reminderQueued ??= reminders(async () => {
    reminderQueued = null;
    const key = identityKey();
    let value: ReminderView;
    try { value = await runReminders(reminderFor); }
    catch { value = 'unavailable'; }
    if (identityKey() === key) reminderView.set({ key, value });
    return value;
  });
  return reminderQueued;
}
