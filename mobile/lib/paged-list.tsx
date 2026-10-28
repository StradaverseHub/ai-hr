/**
 * A v2 cursor list: first load, empty, error, stale-after-failed-refresh, pull-to-refresh, load-more on
 * scroll, virtualised by FlatList. States render through the shared LoadState (ui.tsx), so a list says
 * what every other data screen says.
 *
 *   const list = usePagedResource(NOTIFICATIONS, { employmentId }, keyOf, signOut);
 *   <PagedList list={list} keyOf={keyOf} renderItem={...} header={<Title>…</Title>} />
 *
 * `usePagedResource` reads through apiGetPage, i.e. the shared read coordinator (in-flight dedupe, server
 * backoff, scope reset on identity change). A change of scope (identity, company connection, locale,
 * employment or any parameter) hides the previous scope's rows in the same render and discards its late
 * responses. No row outlives the hook: nothing is persisted.
 *
 * FlatList owns its scrolling, so a PagedList is a screen's body, never a child of ui.tsx `Screen`
 * (a ScrollView); put titles in `header`.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { FlatList, RefreshControl, View, type StyleProp, type ViewStyle } from 'react-native';
import type { Page } from '../../lib/mobile-api/v2/common';
import { apiGetPage, type V2Page } from './api';
import { authGeneration } from './auth';
import { config, identityNamespace } from './config';
import { RequestRejectedError, SignInRequiredError } from './errors';
import { appLocale, t } from './i18n';
import { Button, LoadState, Muted } from './ui';

export type PageLoader<T> = (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>;
type Busy = 'first' | 'refresh' | 'more' | null;
type State<T> = { scope: string; items: T[]; nextCursor: string | null; loaded: boolean; busy: Busy; error: Error | null; moreError: Error | null };
export type PagedListState<T> = {
  items: T[];
  /** First page in flight with nothing to show. */
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  /** First-page or refresh failure. With `items` still shown, they are stale. */
  error: Error | null;
  /** Load-more failure: rows already shown are kept; it is retried by `retryMore`, never by scrolling. */
  moreError: Error | null;
  stale: boolean;
  empty: boolean;
  hasMore: boolean;
  refresh: () => void;
  loadMore: () => void;
  retry: () => void;
  retryMore: () => void;
};
const initial = <T,>(scope: string): State<T> => ({ scope, items: [], nextCursor: null, loaded: false, busy: 'first', error: null, moreError: null });

export function usePagedList<T>(scope: string, load: PageLoader<T>, keyOf: (item: T) => string, onSignInRequired: () => void): PagedListState<T> {
  const [state, setState] = useState<State<T>>(() => initial(scope));
  const latest = useRef({ load, keyOf, onSignInRequired, state, scope });
  latest.current = { load, keyOf, onSignInRequired, state, scope };
  // Synchronous in-flight record: two scroll events before a re-render must not start two loads.
  const flight = useRef<{ controller: AbortController; mode: Exclude<Busy, null> } | null>(null);
  const sequence = useRef(0);

  const begin = useCallback((mode: Exclude<Busy, null>, cursor: string | null) => {
    const owner = latest.current.scope;
    flight.current?.controller.abort();
    const controller = new AbortController();
    flight.current = { controller, mode };
    const token = ++sequence.current;
    const mine = () => token === sequence.current && latest.current.scope === owner;
    setState((s) => s.scope !== owner ? s : { ...s, busy: mode, ...(mode === 'more' ? { moreError: null } : { error: null }) });
    latest.current.load(cursor, controller.signal).then((page) => {
      if (!mine()) return;
      flight.current = null;
      const key = latest.current.keyOf;
      setState((s) => {
        if (s.scope !== owner) return s;
        const base = mode === 'more' ? s.items : [];
        const seen = new Set(base.map(key));
        const items = [...base];
        for (const item of page.items) { const k = key(item); if (!seen.has(k)) { seen.add(k); items.push(item); } }
        return { ...s, items, nextCursor: page.nextCursor, loaded: true, busy: null, error: null, moreError: null };
      });
    }, (error: Error) => {
      if (!mine()) return;
      flight.current = null;
      if (error instanceof SignInRequiredError) latest.current.onSignInRequired();
      // A refused or signed-out read keeps nothing on screen; an outage keeps what was shown, labelled stale.
      const drop = error instanceof SignInRequiredError || error instanceof RequestRejectedError;
      setState((s) => s.scope !== owner ? s : drop ? { ...initial<T>(owner), busy: null, error }
        : mode === 'more' ? { ...s, busy: null, moreError: error } : { ...s, busy: null, error });
    });
  }, []);

  useEffect(() => {
    setState(initial(scope));
    begin('first', null);
    return () => { sequence.current += 1; flight.current?.controller.abort(); flight.current = null; };
  }, [scope, begin]);

  const refresh = useCallback(() => {
    const s = latest.current.state;
    if (flight.current && flight.current.mode !== 'more') return; // a refresh supersedes a load-more, not itself
    begin(s.loaded ? 'refresh' : 'first', null);
  }, [begin]);
  const loadMore = useCallback(() => {
    const s = latest.current.state;
    if (flight.current || !s.loaded || !s.nextCursor || s.error || s.moreError) return;
    begin('more', s.nextCursor);
  }, [begin]);
  const retryMore = useCallback(() => {
    const s = latest.current.state;
    if (flight.current || !s.nextCursor) return;
    begin('more', s.nextCursor);
  }, [begin]);

  // Hide the previous scope's rows in the render that changes scope, before effects run.
  const s = state.scope === scope ? state : initial<T>(scope);
  return {
    items: s.items, loading: !s.items.length && (s.busy === 'first' || s.busy === 'refresh'), refreshing: s.busy === 'refresh',
    loadingMore: s.busy === 'more', error: s.error, moreError: s.moreError, stale: !!s.error && s.items.length > 0,
    empty: s.loaded && !s.busy && !s.error && !s.items.length, hasMore: s.loaded && s.nextCursor !== null,
    refresh, loadMore, retry: refresh, retryMore,
  };
}

/** usePagedList over a registered v2 page resource, scoped like useApi (identity, connection, locale, params). */
export function usePagedResource<T>(resource: V2Page<T>, params: Record<string, string | undefined>, keyOf: (item: T) => string, onSignInRequired: () => void): PagedListState<T> {
  const snapshot = JSON.stringify(Object.entries(params).filter((e) => e[1] !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  const scope = JSON.stringify([identityNamespace(), config.apiUrl, appLocale(), authGeneration(), resource.path, snapshot]);
  const load = useCallback<PageLoader<T>>((cursor, signal) =>
    apiGetPage(resource, cursor, Object.fromEntries(JSON.parse(snapshot) as [string, string][]), signal), [resource, snapshot]);
  return usePagedList(scope, load, keyOf, onSignInRequired);
}

export function PagedList<T>({ list, keyOf, renderItem, header, emptyText, contentContainerStyle }: {
  list: PagedListState<T>; keyOf: (item: T) => string; renderItem: (item: T) => ReactElement;
  header?: ReactElement; emptyText?: string; contentContainerStyle?: StyleProp<ViewStyle>;
}) {
  const hasData = list.items.length > 0;
  return (
    <FlatList
      data={list.items}
      keyExtractor={keyOf}
      renderItem={({ item }) => renderItem(item)}
      contentContainerStyle={contentContainerStyle}
      ListHeaderComponent={<View>{header}{list.error || list.loading ? <LoadState loading={list.loading} error={list.error} hasData={hasData} onRetry={list.retry} /> : null}</View>}
      ListEmptyComponent={list.empty ? <Muted>{emptyText ?? t('listEmpty')}</Muted> : null}
      ListFooterComponent={list.moreError
        ? <View><Muted>{t('listMoreFailed')}</Muted><Button title={t('retry')} kind="quiet" onPress={list.retryMore} /></View>
        : list.loadingMore ? <Muted>{t('listLoadingMore')}</Muted> : null}
      onEndReached={list.loadMore}
      onEndReachedThreshold={0.5}
      refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} />}
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      windowSize={7}
    />
  );
}
