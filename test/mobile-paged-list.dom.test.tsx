/** The shipped paged list (mobile/lib/paged-list.tsx) with only native views, transport and identity ports injected. */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as errors from '../mobile/lib/errors';

type Item = { id: string };
type Page = { items: Item[]; nextCursor: string | null };
type Call = { cursor: string | null; signal: AbortSignal; resolve: (page: Page) => void; reject: (error: Error) => void };
function fixture() {
  const identity = { namespace: 'company-one', generation: 1 };
  const apiGetPage = vi.fn<(...args: unknown[]) => Promise<Page>>(async () => ({ items: [], nextCursor: null }));
  const ports: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    'react-native': {
      View: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
      RefreshControl: (p: { refreshing: boolean; onRefresh: () => void }) => <button aria-busy={p.refreshing} onClick={p.onRefresh}>pull</button>,
      FlatList: (p: any) => <div>{p.refreshControl}{p.ListHeaderComponent}
        {p.data.length ? p.data.map((item: Item) => <div key={p.keyExtractor(item)}>{p.renderItem({ item })}</div>) : p.ListEmptyComponent}
        {p.ListFooterComponent}<button onClick={p.onEndReached}>end</button><output>{`window ${p.windowSize}`}</output></div>,
    },
    './api': { apiGetPage }, './auth': { authGeneration: () => identity.generation },
    './config': { config: { apiUrl: 'https://hr.test' }, identityNamespace: () => identity.namespace },
    './errors': errors, './i18n': { appLocale: () => 'en', t: (key: string) => key },
    './ui': {
      Muted: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
      Button: (p: { title: string; onPress: () => void }) => <button onClick={p.onPress}>{p.title}</button>,
      LoadState: (p: { loading: boolean; error: Error | null; hasData: boolean; onRetry: () => void }) => p.error
        ? <div>{'error:' + p.error.name}{p.hasData && ' staleData'}<button onClick={p.onRetry}>retry-load</button></div>
        : p.loading ? <span role="progressbar" /> : null,
    },
  };
  const module = { exports: {} as any };
  runInNewContext(transpileModule(readFileSync('mobile/lib/paged-list.tsx', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, AbortController, require: (id: string) => { if (id in ports) return ports[id]; throw new Error('Unexpected paged-list dependency ' + id); } });
  const calls: Call[] = [];
  const loader = vi.fn((cursor: string | null, signal: AbortSignal) => new Promise<Page>((resolve, reject) => { calls.push({ cursor, signal, resolve, reject }); }));
  const onSignIn = vi.fn();
  const { usePagedList, usePagedResource, PagedList } = module.exports;
  function Harness({ scope }: { scope: string }) {
    const list = usePagedList(scope, loader, (i: Item) => i.id, onSignIn);
    return <PagedList list={list} keyOf={(i: Item) => i.id} renderItem={(i: Item) => <p>{'row ' + i.id}</p>} header={<h1>Title</h1>} />;
  }
  function Resource({ employmentId }: { employmentId: string }) {
    const list = usePagedResource({ kind: 'page', path: 'v2/test-items', schema: null }, { employmentId }, (i: Item) => i.id, onSignIn);
    return <PagedList list={list} keyOf={(i: Item) => i.id} renderItem={(i: Item) => <p>{'row ' + i.id}</p>} />;
  }
  return { Harness, Resource, calls, loader, onSignIn, apiGetPage, identity };
}
const rows = () => screen.queryAllByText(/^row /).map((n) => n.textContent);
const page = (ids: string[], nextCursor: string | null = null): Page => ({ items: ids.map((id) => ({ id })), nextCursor });
async function settle(call: Call, result: Page | Error) { await act(async () => { if (result instanceof Error) call.reject(result); else call.resolve(result); }); }
afterEach(cleanup);

describe('paged list states', () => {
  it('shows a first-load indicator, then rows under the header, virtualised', async () => {
    const f = fixture();
    render(<f.Harness scope="a" />);
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.getByText('Title')).toBeTruthy();
    expect(f.calls[0].cursor).toBeNull();
    await settle(f.calls[0], page(['1', '2']));
    expect(rows()).toEqual(['row 1', 'row 2']);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('window 7')).toBeTruthy();
  });

  it('says the list is empty only once a page answered with nothing', async () => {
    const f = fixture();
    render(<f.Harness scope="a" />);
    expect(screen.queryByText('listEmpty')).toBeNull();
    await settle(f.calls[0], page([]));
    expect(screen.getByText('listEmpty')).toBeTruthy();
  });

  it('shows a first-load failure with retry, without calling it stale', async () => {
    const f = fixture();
    render(<f.Harness scope="a" />);
    await settle(f.calls[0], new errors.UnavailableError());
    expect(screen.getByText('error:UnavailableError')).toBeTruthy();
    expect(screen.queryByText(/staleData/)).toBeNull();
    expect(screen.queryByText('listEmpty')).toBeNull();
    fireEvent.click(screen.getByText('retry-load'));
    expect(f.calls[1].cursor).toBeNull();
    await settle(f.calls[1], page(['1']));
    expect(rows()).toEqual(['row 1']);
  });

  it('keeps rows after a failed pull-to-refresh, labelled stale, and replaces them after a good one', async () => {
    const f = fixture();
    render(<f.Harness scope="a" />);
    await settle(f.calls[0], page(['1', '2'], 'c1'));
    fireEvent.click(screen.getByText('pull'));
    expect(screen.getByText('pull').getAttribute('aria-busy')).toBe('true');
    expect(f.calls[1].cursor).toBeNull();
    await settle(f.calls[1], new errors.UnavailableError());
    expect(rows()).toEqual(['row 1', 'row 2']);
    expect(screen.getByText(/staleData/)).toBeTruthy();
    fireEvent.click(screen.getByText('pull'));
    await settle(f.calls[2], page(['3']));
    expect(rows()).toEqual(['row 3']);
    expect(screen.queryByText(/staleData/)).toBeNull();
  });
});

describe('paged list loading more', () => {
  it('loads the next cursor on scroll once, appends without duplicates and stops at the last page', async () => {
    const f = fixture();
    render(<f.Harness scope="a" />);
    await settle(f.calls[0], page(['1', '2'], 'c1'));
    fireEvent.click(screen.getByText('end'));
    fireEvent.click(screen.getByText('end'));
    expect(f.loader).toHaveBeenCalledTimes(2);
    expect(f.calls[1].cursor).toBe('c1');
    expect(screen.getByText('listLoadingMore')).toBeTruthy();
    await settle(f.calls[1], page(['2', '3']));
    expect(rows()).toEqual(['row 1', 'row 2', 'row 3']);
    fireEvent.click(screen.getByText('end'));
    expect(f.loader).toHaveBeenCalledTimes(2);
  });

  it('keeps rows after a load-more failure and retries only from the footer', async () => {
    const f = fixture();
    render(<f.Harness scope="a" />);
    await settle(f.calls[0], page(['1'], 'c1'));
    fireEvent.click(screen.getByText('end'));
    await settle(f.calls[1], new errors.UnavailableError());
    expect(rows()).toEqual(['row 1']);
    expect(screen.getByText('listMoreFailed')).toBeTruthy();
    fireEvent.click(screen.getByText('end'));
    expect(f.loader).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText('retry'));
    expect(f.calls[2].cursor).toBe('c1');
    await settle(f.calls[2], page(['2']));
    expect(rows()).toEqual(['row 1', 'row 2']);
    expect(screen.queryByText('listMoreFailed')).toBeNull();
  });

  it('a refresh supersedes an in-flight load-more, whose late page is discarded', async () => {
    const f = fixture();
    render(<f.Harness scope="a" />);
    await settle(f.calls[0], page(['1'], 'c1'));
    fireEvent.click(screen.getByText('end'));
    fireEvent.click(screen.getByText('pull'));
    expect(f.calls[1].signal.aborted).toBe(true);
    await settle(f.calls[2], page(['9']));
    await settle(f.calls[1], page(['late']));
    expect(rows()).toEqual(['row 9']);
  });
});

describe('paged list scope and session', () => {
  it('hides the previous scope’s rows in the render that changes scope and ignores its late answer', async () => {
    const f = fixture();
    const ui = render(<f.Harness scope="employment-a" />);
    await settle(f.calls[0], page(['a1'], 'ca'));
    fireEvent.click(screen.getByText('end'));
    ui.rerender(<f.Harness scope="employment-b" />);
    expect(rows()).toEqual([]);
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(f.calls[1].signal.aborted).toBe(true);
    await settle(f.calls[1], page(['a2']));
    expect(rows()).toEqual([]);
    await settle(f.calls[2], page(['b1']));
    expect(rows()).toEqual(['row b1']);
  });

  it('drops every row and signs out when the server requires sign-in again', async () => {
    const f = fixture();
    render(<f.Harness scope="a" />);
    await settle(f.calls[0], page(['1']));
    fireEvent.click(screen.getByText('pull'));
    await settle(f.calls[1], new errors.SignInRequiredError());
    expect(f.onSignIn).toHaveBeenCalledOnce();
    expect(rows()).toEqual([]);
    expect(screen.queryByText(/staleData/)).toBeNull();
  });

  it('reads a registered resource through apiGetPage, re-scoped by employment and identity', async () => {
    const f = fixture();
    f.apiGetPage.mockResolvedValueOnce(page(['e1'], 'n1'));
    const ui = render(<f.Resource employmentId="e1" />);
    await act(async () => {});
    expect(rows()).toEqual(['row e1']);
    expect(f.apiGetPage.mock.calls[0].slice(0, 3)).toEqual([{ kind: 'page', path: 'v2/test-items', schema: null }, null, { employmentId: 'e1' }]);
    f.apiGetPage.mockResolvedValueOnce(page(['e2']));
    ui.rerender(<f.Resource employmentId="e2" />);
    expect(rows()).toEqual([]);
    await act(async () => {});
    expect(rows()).toEqual(['row e2']);
    expect(f.apiGetPage.mock.calls[1][2]).toEqual({ employmentId: 'e2' });
    f.identity.namespace = 'company-two';
    f.apiGetPage.mockResolvedValueOnce(page(['other']));
    ui.rerender(<f.Resource employmentId="e2" />);
    expect(rows()).toEqual([]);
    await act(async () => {});
    expect(rows()).toEqual(['row other']);
  });
});
