/**
 * M10 (inbox part) — the caller's own notifications, paged, with read state; M14 (Home essentials) — Home's truthful
 * "what needs me" card.
 *
 * THE APP OPENS NOTHING THE SERVER DID NOT NAME. A row never carries a link: the server sends a typed `destination`
 * from its own allowlist (lib/mobile-api/notification-destination.ts), and the app maps it to one of four FIXED screens
 * (SCREEN_HREF). Anything else opens nothing. A tap first marks the row read on the server, which answers with the
 * row's destination re-derived NOW; only then does the app navigate, and the screen it opens fetches afresh under the
 * caller's session. A row that is gone, or whose destination no longer applies, says "This item is no longer
 * available". Screens are only reachable unlocked: the root Gate (mobile/app/_layout.tsx) renders no route while the
 * session is locked, and a command refuses while the app is not in the foreground (api.ts).
 *
 * HOME NEVER GUESSES. "Nothing needs you" shows only when BOTH the task count and the inbox count were read, are zero
 * and are not being refreshed. Loading shows loading; a part that could not be read shows "Couldn't check — retry".
 *
 * Nothing is kept: rows, counts and read marks live in this screen's memory only.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { DesignText as Text, useTenantDesign } from './design';
import { apiGetV2, apiPostV2 } from './api';
import { authGeneration } from './auth';
import { config, identityNamespace } from './config';
import { SignInRequiredError } from './errors';
import { appLocale, t, type MessageKey } from './i18n';
import { fmtInstant } from './attendance-format';
import { PagedList, usePagedList, type PageLoader, type PagedListState } from './paged-list';
import { useSession } from './session';
import { Button, Card, ListRow, LoadState, Muted, Title } from './ui';
import {
  HomeSummaryV2, NotificationReadResult, NotificationsPageV2,
  type NotificationDestination, type NotificationItemV2, type NotificationScreen,
} from '../../lib/mobile-api/v2/notifications';

type Href = '/leave' | '/leave/history' | '/approvals' | '/pay';
const SCREEN_HREF: Record<NotificationScreen, Href> = { leave: '/leave', leaveHistory: '/leave/history', approvals: '/approvals', pay: '/pay' };
const OPEN_LABEL: Record<NotificationScreen, MessageKey> = { leave: 'inboxOpenLeave', leaveHistory: 'inboxOpenLeaveHistory', approvals: 'inboxOpenApprovals', pay: 'inboxOpenPay' };
const READ = 'v2/notifications/read' as const;

/** The app's own screen for a server destination, or null. Closed: an unknown screen name opens nothing. */
export function notificationHref(destination: NotificationDestination | null | undefined): Href | null {
  const screen = destination?.screen;
  return typeof screen === 'string' && Object.hasOwn(SCREEN_HREF, screen) ? SCREEN_HREF[screen] : null;
}
const openLabel = (destination: NotificationDestination | null) =>
  destination && notificationHref(destination) ? t(OPEN_LABEL[destination.screen]) : null;
const itemKey = (item: NotificationItemV2) => item.id;
/** The app's own date-time style in the person's language and the company's business zone (as every other screen), never
 * the device's US-style default. */
const when = (iso: string) => (Number.isFinite(new Date(iso).getTime()) ? fmtInstant(iso, 'Asia/Kuala_Lumpur') : iso);

// ── Inbox ──────────────────────────────────────────────────────────────────────────────────────────────────────

type Meta = { scope: string; enabled: boolean; unreadCount: number };
export function useNotificationIndex(onSignInRequired: () => void): {
  list: PagedListState<NotificationItemV2>; scope: string; enabled: boolean | null; unreadCount: number | null; setUnreadCount: (n: number) => void;
} {
  const scope = JSON.stringify([identityNamespace(), config.apiUrl, appLocale(), authGeneration(), 'v2/notifications']);
  const [meta, setMeta] = useState<Meta | null>(null);
  const load = useCallback<PageLoader<NotificationItemV2>>(async (cursor, signal) => {
    const page = await apiGetV2('v2/notifications', NotificationsPageV2, cursor ? { cursor } : {}, signal);
    setMeta({ scope, enabled: page.enabled, unreadCount: page.unreadCount });
    return { items: page.items, nextCursor: page.nextCursor };
  }, [scope]);
  const list = usePagedList(scope, load, itemKey, onSignInRequired);
  const setUnreadCount = useCallback((n: number) => setMeta((m) => (m && m.scope === scope ? { ...m, unreadCount: n } : m)), [scope]);
  const current = meta?.scope === scope ? meta : null;
  return { list, scope, enabled: current?.enabled ?? null, unreadCount: current?.unreadCount ?? null, setUnreadCount };
}

export function NotificationRow({ item, read, busy, onPress }: { item: NotificationItemV2; read: boolean; busy: boolean; onPress: () => void }) {
  const { palette } = useTenantDesign();
  const unread = item.readAt == null && !read;
  const open = openLabel(item.destination);
  return <Pressable accessibilityRole="button" accessibilityLabel={[unread ? t('inboxUnreadLabel') : null, item.title, open].filter(Boolean).join('. ')}
    accessibilityState={{ disabled: busy }} disabled={busy} onPress={onPress}
    style={{ flexDirection: 'row', gap: 10, paddingVertical: 14, borderBottomWidth: 1, borderColor: palette.border }}>
    <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 8, backgroundColor: unread ? palette.accent : 'transparent' }} />
    <View style={{ flex: 1, gap: 4 }}>
      <Text style={{ color: palette.text, fontSize: 16, fontWeight: unread ? '700' : '400' }}>{item.title}</Text>
      {item.body ? <Muted>{item.body}</Muted> : null}
      <Muted>{when(item.createdAt)}</Muted>
      {open ? <Text style={{ color: palette.accent }}>{open}</Text> : null}
    </View>
  </Pressable>;
}

/** `prompt`: the route's push control (mobile/lib/push.tsx PushPrompt), shown under the counts; the list never needs it. */
export function InboxScreen({ prompt }: { prompt?: ReactNode } = {}) {
  const { palette } = useTenantDesign();
  const { signOut } = useSession();
  const { list, scope, enabled, unreadCount, setUnreadCount } = useNotificationIndex(signOut);
  const [readIds, setReadIds] = useState<{ scope: string; ids: ReadonlySet<string> } | null>(null);
  const [notice, setNotice] = useState<{ scope: string; key: MessageKey } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Synchronous guard: two taps before a re-render must not send two commands.
  const busy = useRef<string | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const markLocal = (owner: string, ids: readonly string[]) =>
    setReadIds((prior) => ({ scope: owner, ids: new Set([...(prior?.scope === owner ? prior.ids : []), ...ids]) }));
  const failed = (owner: string, error: unknown) => {
    if (scopeRef.current !== owner) return;
    if (error instanceof SignInRequiredError) { signOut(); return; }
    setNotice({ scope: owner, key: 'inboxActionFailed' });
  };
  const run = async (tag: string, work: (owner: string) => Promise<void>) => {
    if (busy.current) return;
    const owner = scope;
    busy.current = tag; setBusyId(tag); setNotice(null);
    try { await work(owner); } catch (error) { failed(owner, error); } finally { busy.current = null; setBusyId(null); }
  };

  /** Mark read, then open the destination the server re-derived just now; never the one the row was loaded with. */
  const open = (item: NotificationItemV2) => run(item.id, async (owner) => {
    const r = await apiPostV2(READ, NotificationReadResult, { ids: [item.id] });
    if (scopeRef.current !== owner) return;
    if (r.outcome !== 'read') { setNotice({ scope: owner, key: 'inboxGone' }); return; }
    setUnreadCount(r.unreadCount); markLocal(owner, [item.id]);
    const fresh = r.items.find((i) => i.id.toLowerCase() === item.id.toLowerCase());
    const href = fresh ? notificationHref(fresh.destination) : null;
    if (href) router.push(href);
    else if (!fresh || item.destination) setNotice({ scope: owner, key: 'inboxGone' });
  });
  const markAll = () => run('all', async (owner) => {
    const r = await apiPostV2(READ, NotificationReadResult, { all: true });
    if (scopeRef.current !== owner) return;
    if (r.outcome === 'read') { setUnreadCount(r.unreadCount); markLocal(owner, list.items.map(itemKey)); }
    list.refresh();
  });

  const read = readIds?.scope === scope ? readIds.ids : null;
  const shownNotice = notice?.scope === scope ? notice.key : null;
  return <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }} edges={['top']}>
    <PagedList list={list} keyOf={itemKey} emptyText={enabled === false ? t('notificationsOff') : t('inboxEmpty')} contentContainerStyle={{ padding: 20, gap: 8 }}
      header={<View style={{ gap: 12 }}>
        <Title>{t('tabInbox')}</Title>
        {enabled !== false && unreadCount != null ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Muted>{`${t('unreadCount', { n: unreadCount })} ·`}</Muted>
          <Button title={t('inboxMarkAll')} kind="quiet" disabled={unreadCount === 0 || busyId !== null} onPress={() => void markAll()} />
        </View> : null}
        {shownNotice ? <Text accessibilityRole="alert" style={{ color: palette.text }}>{t(shownNotice)}</Text> : null}
        {prompt ?? null}
      </View>}
      renderItem={(item) => <NotificationRow item={item} read={read?.has(item.id) ?? false} busy={busyId !== null} onPress={() => void open(item)} />} />
  </SafeAreaView>;
}

// ── Home ───────────────────────────────────────────────────────────────────────────────────────────────────────

type Read<T> = { data: T | null; error: Error | null; loading: boolean; reload: () => void };
/** Home's counts, scoped like useApi; `refreshToken` re-reads. A failure keeps nothing of the old answer. */
export function useHomeSummary(onSignInRequired: () => void, refreshToken = 0): Read<HomeSummaryV2> {
  const owner = authGeneration(), namespace = identityNamespace(), origin = config.apiUrl, locale = appLocale();
  const key = JSON.stringify([owner, namespace, origin, locale]);
  const [state, setState] = useState<{ key: string; data: HomeSummaryV2 | null; error: Error | null; loading: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setState((prior) => ({ key, data: prior?.key === key ? prior.data : null, error: null, loading: true }));
    apiGetV2('v2/home/summary', HomeSummaryV2, {}, controller.signal).then(
      (data) => { if (live && authGeneration() === owner) setState({ key, data, error: null, loading: false }); },
      (error: Error) => {
        if (!live || authGeneration() !== owner) return;
        if (error instanceof SignInRequiredError) onSignInRequired();
        setState({ key, data: null, error, loading: false });
      });
    return () => { live = false; controller.abort(); };
  }, [key, tick, refreshToken, onSignInRequired]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return state?.key === key ? { ...state, reload } : { data: null, error: null, loading: true, reload };
}

export type HomeNeedsView = { tasks: 'loading' | 'failed' | number; inbox: 'loading' | 'failed' | 'off' | number; allClear: boolean };
/** What Home may say. All clear ONLY when both parts were read, both are zero (or the inbox is off) and nothing is in flight. */
export function homeNeedsView(read: Pick<Read<HomeSummaryV2>, 'data' | 'error' | 'loading'>): HomeNeedsView {
  if (!read.data) { const s = read.error ? 'failed' : 'loading'; return { tasks: s, inbox: s, allClear: false }; }
  const tasks = read.data.tasks.status === 'ok' ? read.data.tasks.count : 'failed';
  const inbox = read.data.inbox.status !== 'ok' ? 'failed' : read.data.inbox.enabled ? read.data.inbox.unreadCount : 'off';
  return { tasks, inbox, allClear: !read.loading && !read.error && tasks === 0 && (inbox === 'off' || inbox === 0) };
}

/**
 * Home's "Needs you" card: two tappable rows — the approvals count (opens Approvals) and the unread count (opens the
 * Inbox) — or an honest state. A row shows only for a count that was read and is above zero.
 */
export function HomeNeeds({ refreshToken = 0 }: { refreshToken?: number }) {
  const { signOut } = useSession();
  const summary = useHomeSummary(signOut, refreshToken);
  const v = homeNeedsView(summary);
  const failed = v.tasks === 'failed' || v.inbox === 'failed';
  return <Card>
    <LoadState loading={summary.loading} hasData={summary.data != null} error={null} onRetry={summary.reload} />
    {typeof v.tasks === 'number' && v.tasks > 0 ? <ListRow label={t('approvalsTitle')} value={t('homeTasksCount', { n: v.tasks })} onPress={() => router.push('/approvals')} /> : null}
    {typeof v.inbox === 'number' && v.inbox > 0 ? <ListRow label={t('tabInbox')} value={t('unreadCount', { n: v.inbox })} onPress={() => router.navigate('/inbox')} /> : null}
    {failed && !summary.loading ? <Button title={t('homeCheckFailed')} kind="quiet" onPress={summary.reload} /> : null}
    {v.allClear ? <Muted>{t('nothingNeedsYou')}</Muted> : null}
    {/* The count could not be read: the way to the list itself stays. */}
    {v.tasks === 'failed' ? <ListRow label={t('openApprovals')} onPress={() => router.push('/approvals')} /> : null}
  </Card>;
}
