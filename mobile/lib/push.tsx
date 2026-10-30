/**
 * M10 (D6) native push and D8 shift reminders — what is mounted: the lifecycle inside the signed-in tree, the sign-out
 * watcher, the Inbox's push control and the Me screen's reminder switch. The logic is mobile/lib/push-core.ts.
 *
 * WHAT A TAP OPENS. A push carries `{notificationId}` and generic text only. After unlock (PushLifecycle renders only
 * inside the signed-in, visible tree) the id is resolved through POST v2/notifications/read, which answers the
 * destination the server derives NOW from its allowlist; the app opens that fixed screen, or the Inbox. Nothing else in
 * a push can steer navigation, and no business record changes (reading marks the notification read, as the Inbox does).
 * A shift reminder opens the Clock tab.
 *
 * WHEN REMINDERS ARE RE-PLANNED: sign-in/unlock, every return to the foreground, an employment switch, the clock or
 * roster screen reading again (shift-reminder-signal.ts), a push arriving in the foreground, and the switch or the
 * permission changing. Any sign-out removes them (PushSessionWatcher).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Pressable, Switch, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import { router, type Href } from 'expo-router';
import { apiPostV2 } from './api';
import { DesignText as Text, useTenantDesign } from './design';
import { SignInRequiredError } from './errors';
import { t, type MessageKey } from './i18n';
import { notificationHref } from './inbox';
import {
  PUSH_HANDLER, afterReminders, askNotificationPermission, cancelShiftReminders, forgetEnrollment, identityKey, openNotificationSettings,
  preferences, pushView, readPushPreferences, reminderView, requestShiftReminders, savePreference, syncPush, turnOffNotifications,
  turnOnNotifications, type PushPreferences, type PushView, type ReminderView,
} from './push-core';
import { useSession } from './session';
import { onShiftReminderRefresh } from './shift-reminder-signal';
import { isShiftReminder } from './shift-reminders';
import { Button, Card, ListRow, Muted } from './ui';
import { NotificationReadResult } from '../../lib/mobile-api/v2/notifications';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Store hooks ──────────────────────────────────────────────────────────────────────────────────────────────────

export function usePushPreferences(): PushPreferences | null {
  const value = useSyncExternalStore(preferences.subscribe, preferences.get, preferences.get);
  useEffect(() => { void readPushPreferences(); }, []);
  return value;
}

export function usePushView(): PushView {
  const current = useSyncExternalStore(pushView.subscribe, pushView.get, pushView.get);
  return current.key === identityKey() ? current.value : 'checking';
}

export function useReminderView(): ReminderView {
  const current = useSyncExternalStore(reminderView.subscribe, reminderView.get, reminderView.get);
  return current.key === identityKey() ? current.value : 'checking';
}

// ── Opening a notification ───────────────────────────────────────────────────────────────────────────────────────

const handled = new Set<string>();
/** The validated notification id a push carries, or null. Nothing else in a push is read. */
export function pushNotificationId(response: Notifications.NotificationResponse | null | undefined): string | null {
  const value = (response?.notification.request.content.data as Record<string, unknown> | null | undefined)?.notificationId;
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}
/** Resolve the id through the server's read command and allowlist; open that fixed screen, or the Inbox. */
export async function openPushedNotification(notificationId: string | null): Promise<void> {
  if (!notificationId) { router.push('/inbox' as Href); return; }
  try {
    const answer = await apiPostV2('v2/notifications/read', NotificationReadResult, { ids: [notificationId] });
    const fresh = answer.outcome === 'read' ? answer.items.find((i) => i.id.toLowerCase() === notificationId) : undefined;
    router.push(notificationHref(fresh?.destination) ?? ('/inbox' as Href));
  } catch { router.push('/inbox' as Href); }
}
/** One tap, handled once. Navigation waits a tick: a cold-start tap is read while the root Stack is still mounting. */
export function respondToNotification(response: Notifications.NotificationResponse) {
  const request = response.notification.request, once = `${request.identifier}:${response.notification.date}:${response.actionIdentifier}`;
  if (handled.has(once)) return;
  handled.add(once);
  try { Notifications.clearLastNotificationResponse(); } catch { /* older native module */ }
  const reminder = isShiftReminder(request.identifier), id = pushNotificationId(response);
  setTimeout(() => { if (reminder) router.push('/clock' as Href); else void openPushedNotification(id); }, 0);
}

// ── Mounted pieces ───────────────────────────────────────────────────────────────────────────────────────────────

/** Mounted once inside the signed-in, visible tree (mobile/app/_layout.tsx ThemedStack). Renders nothing. */
export function PushLifecycle() {
  const { employmentId, signOut } = useSession();
  const employment = useRef(employmentId), exit = useRef(signOut);
  employment.current = employmentId;
  exit.current = signOut;
  const refused = (error: unknown) => { if (error instanceof SignInRequiredError) void exit.current(); };
  useEffect(() => { Notifications.setNotificationHandler(PUSH_HANDLER); }, []);
  useEffect(() => {
    syncPush(employmentId).catch(refused);
    void requestShiftReminders(employmentId);
  }, [employmentId]); // `refused` reads refs only
  useEffect(() => {
    const appState = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      syncPush(employment.current).catch(refused);
      void requestShiftReminders(employment.current);
    });
    const token = Notifications.addPushTokenListener(() => { syncPush(employment.current, true).catch(() => undefined); });
    const received = Notifications.addNotificationReceivedListener((n) => { if (!isShiftReminder(n.request.identifier)) void requestShiftReminders(employment.current); });
    const tapped = Notifications.addNotificationResponseReceivedListener(respondToNotification);
    const signal = onShiftReminderRefresh(() => { void requestShiftReminders(employment.current); });
    const last = Notifications.getLastNotificationResponse();
    if (last) respondToNotification(last);
    return () => { appState.remove(); token.remove(); received.remove(); tapped.remove(); signal(); };
  }, []); // the listeners read refs only
  return null;
}

/** Mounted under the SessionProvider for the app's whole life: any sign-out removes this phone's shift reminders. */
export function PushSessionWatcher() {
  const { status } = useSession();
  useEffect(() => {
    if (status !== 'signedOut') return;
    forgetEnrollment();
    void afterReminders(async () => { try { await cancelShiftReminders(); } catch { /* nothing scheduled, or no module */ } });
  }, [status]);
  return null;
}

/** The Inbox's contextual push control. Absent when push does not apply; the inbox itself never depends on it. */
export function PushPrompt({ compact = false }: { compact?: boolean } = {}) {
  const { employmentId } = useSession();
  const view = usePushView();
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<unknown>) => { if (busy) return; setBusy(true); void work().catch(() => undefined).finally(() => setBusy(false)); };
  if (view === 'checking' || view === 'module_off' || view === 'unsupported') return null;
  // The Inbox's contextual nudge: only the one action, only while notifications are off. Me holds the full control.
  if (compact) return view === 'off' ? <Button title={t('pushTurnOn')} kind="quiet" disabled={busy} onPress={() => run(() => turnOnNotifications(employmentId))} /> : null;
  const body = view === 'on' ? 'pushOnBody' : view === 'server_off' ? 'pushServerOffBody' : view === 'denied' ? 'pushDeniedBody' : view === 'unavailable' ? 'pushUnavailableBody' : 'pushOffBody';
  return <Card>
    <Muted>{t(body)}</Muted>
    {view === 'off' ? <Button title={t('pushTurnOn')} disabled={busy} onPress={() => run(() => turnOnNotifications(employmentId))} /> : null}
    {view === 'denied' ? <Button title={t('pushOpenSettings')} kind="quiet" onPress={openNotificationSettings} /> : null}
    {view === 'unavailable' ? <Button title={t('pushRetry')} kind="quiet" disabled={busy} onPress={() => run(() => syncPush(employmentId, true))} /> : null}
    {view === 'on' || view === 'server_off' ? <Button title={t('pushTurnOff')} kind="quiet" disabled={busy} onPress={() => run(() => turnOffNotifications(employmentId))} /> : null}
  </Card>;
}

const PUSH_STATE: Partial<Record<PushView, MessageKey>> = { on: 'pushStateOn', off: 'pushStateOff', denied: 'pushStateDenied', server_off: 'pushStateServerOff', unavailable: 'pushStateUnavailable' };
/** Me → This phone: one "Notifications" row with its state; the full control (and its explanation) is one tap away. */
export function NotificationsRow() {
  const view = usePushView();
  const state = PUSH_STATE[view];
  if (!state) return null;
  return <ListRow label={t('notificationsRow')} value={t(state)} onPress={() => router.push('/notifications' as Href)} />;
}

/**
 * Me → This phone: the shift-reminder row — the switch, ONE line saying what will actually happen (with an inline
 * "Allow" when the phone's permission is what blocks them), and the full explanation behind the "i". The switch keeps
 * the effective-state rule: switched on but blocked by the phone's permission shows OFF; turning it on then asks (or
 * opens Settings when denied).
 */
export function ShiftReminderSetting() {
  const { employmentId } = useSession();
  const { palette } = useTenantDesign();
  const prefs = usePushPreferences();
  const view = useReminderView();
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(false);
  const on = prefs?.reminders ?? true;
  const toggle = (value: boolean) => { void savePreference({ reminders: value }).then(() => requestShiftReminders(employmentId)); };
  const allow = () => {
    if (busy) return;
    setBusy(true);
    void askNotificationPermission().then(() => { void syncPush(employmentId, true).catch(() => undefined); return requestShiftReminders(employmentId); })
      .catch(() => undefined).finally(() => setBusy(false));
  };
  const blocked = on && (view === 'needs_permission' || view === 'denied');
  const change = (value: boolean) => { if (value && blocked) { if (view === 'denied') openNotificationSettings(); else allow(); return; } toggle(value); };
  const note: MessageKey | null = !on ? 'reminderOffNote' : view === 'needs_permission' ? 'reminderNeedsPermission' : view === 'denied' ? 'reminderDenied'
    : view === 'not_offered' ? 'reminderNotOffered' : view === 'unavailable' ? 'reminderUnavailable' : null;
  const state: MessageKey | null = !on ? 'reminderStateOff' : blocked ? 'reminderStateBlocked' : view === 'not_offered' ? 'reminderStateNotOffered'
    : view === 'unavailable' ? 'reminderStateUnavailable' : view === 'on' ? 'reminderStateOn' : null;
  const detail = [note ? t(note) : null, t('reminderExplain')].filter(Boolean).join(' ');
  return <View style={{ borderBottomWidth: 1, borderColor: palette.border, paddingVertical: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44 }}>
      <Text style={{ color: palette.text, fontSize: 16, flex: 1 }}>{t('reminderToggle')}</Text>
      <Switch accessibilityLabel={t('reminderToggle')} value={on && !blocked} disabled={prefs == null || busy} onValueChange={change} />
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      {state ? <Muted>{t(state)}</Muted> : null}
      {blocked ? <Pressable accessibilityRole="button" disabled={busy} onPress={view === 'denied' ? openNotificationSettings : allow} style={{ minHeight: 44, minWidth: 44, justifyContent: 'center' }}>
        <Text style={{ color: palette.accent, fontWeight: '600' }}>{t('reminderAllowShort')}</Text>
      </Pressable> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={t('moreInfo')} accessibilityHint={detail} accessibilityState={{ expanded: info }} onPress={() => setInfo(!info)} style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: palette.accent, fontSize: 16 }}>ⓘ</Text>
      </Pressable>
    </View>
    {info ? <Muted>{detail}</Muted> : null}
  </View>;
}
