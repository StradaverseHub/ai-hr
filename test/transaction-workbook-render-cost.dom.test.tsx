/**
 * Transaction workbooks without whole-tree re-renders (staging timing, 24 Nov 2026).
 *
 * Export to Excel used to redirect() from its server action. Next then fetched the workbook list from its own server
 * with the router state removed, so the whole tree, app shell included, rendered again inside the action: about 33
 * database transactions and ~0.75 s. The list then called router.refresh() every 3 s while a workbook prepared, which
 * re-rendered the whole tree each time. Now the action returns the list's address and the form navigates in-app, and
 * the list polls a small status route and re-renders only when a job changes. Fictional fixtures only.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push }) }));

const { RefreshWorkbookList } = await import('../app/payroll/transaction-view/workbooks/refresh');
const { WorkbookExportForm } = await import('../app/payroll/transaction-view/workbook-export-form');
const { workbookListActive, workbookListSignature } = await import('../app/payroll/transaction-view/workbooks/list');

const STATUS = '/payroll/transaction-view/workbooks/status';
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
const setVisibility = (state: DocumentVisibilityState) =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });

beforeEach(() => { vi.useFakeTimers(); refresh.mockReset(); push.mockReset(); setVisibility('visible'); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('workbook list signature', () => {
  it('changes exactly when a row appears or changes state', () => {
    const a = { id: 'job-a', state: 'running' as const };
    expect(workbookListSignature([a])).toBe('job-a:running');
    expect(workbookListSignature([{ ...a, state: 'completed' }])).not.toBe(workbookListSignature([a]));
    expect(workbookListSignature([{ id: 'job-b', state: 'queued' }, a])).not.toBe(workbookListSignature([a]));
    expect(workbookListActive([a])).toBe(true);
    const finished = [{ ...a, state: 'completed' as const }, { id: 'job-c', state: 'failed' as const }];
    expect(workbookListActive(finished)).toBe(false);
  });
});

describe('RefreshWorkbookList', () => {
  it('polls the status route and does not re-render the page while nothing changed', async () => {
    const fetch = vi.fn(() => json({ active: true, signature: 'job-a:running' }));
    vi.stubGlobal('fetch', fetch);
    render(<RefreshWorkbookList signature="job-a:running" />);
    expect(fetch).not.toHaveBeenCalled();
    await tick(); await tick(); await tick();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledWith(STATUS, { cache: 'no-store', redirect: 'manual' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('re-renders the page once the list changed', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ active: false, signature: 'job-a:completed' })));
    render(<RefreshWorkbookList signature="job-a:running" />);
    await tick();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('skips its ticks while the tab is hidden', async () => {
    const fetch = vi.fn(() => json({ active: true, signature: 'job-a:running' }));
    vi.stubGlobal('fetch', fetch);
    setVisibility('hidden');
    render(<RefreshWorkbookList signature="job-a:running" />);
    await tick(); await tick();
    expect(fetch).not.toHaveBeenCalled();
    setVisibility('visible');
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops when the poll is refused or redirected to sign-in, and retries a server error', async () => {
    const refused = vi.fn(() => json({}, 403));
    vi.stubGlobal('fetch', refused);
    const { unmount } = render(<RefreshWorkbookList signature="job-a:running" />);
    await tick(); await tick(); await tick();
    expect(refused).toHaveBeenCalledTimes(1);
    unmount();

    // redirect: 'manual' turns a sign-in redirect into an opaque response: not ok, status 0.
    const redirected = vi.fn(() => Promise.resolve({ ok: false, status: 0 } as Response));
    vi.stubGlobal('fetch', redirected);
    const second = render(<RefreshWorkbookList signature="job-a:running" />);
    await tick(); await tick();
    expect(redirected).toHaveBeenCalledTimes(1);
    second.unmount();

    const failing = vi.fn(() => json({}, 503));
    vi.stubGlobal('fetch', failing);
    render(<RefreshWorkbookList signature="job-a:running" />);
    await tick(); await tick(); await tick();
    expect(failing).toHaveBeenCalledTimes(3);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('stops polling when it unmounts', async () => {
    const fetch = vi.fn(() => json({ active: true, signature: 'job-a:running' }));
    vi.stubGlobal('fetch', fetch);
    const { unmount } = render(<RefreshWorkbookList signature="job-a:running" />);
    unmount();
    await tick(); await tick();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('WorkbookExportForm', () => {
  it('navigates in-app to the workbook list the action returns', async () => {
    vi.useRealTimers();
    const action = vi.fn(async () => '/payroll/transaction-view/workbooks?tab=history&job=job-a');
    render(<WorkbookExportForm action={action}><input type="hidden" name="scope" value="current" /><button type="submit">This view</button></WorkbookExportForm>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'This view' })); });
    expect(action).toHaveBeenCalledTimes(1);
    expect((action.mock.calls[0] as unknown as [FormData])[0].get('scope')).toBe('current');
    expect(push).toHaveBeenCalledWith('/payroll/transaction-view/workbooks?tab=history&job=job-a');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('never navigates anywhere but the workbook list', async () => {
    vi.useRealTimers();
    for (const href of ['https://example.invalid/payroll/transaction-view/workbooks', '/payroll/transaction-view/workbooks-other', '/']) {
      push.mockReset();
      const action = vi.fn(async () => href);
      const { unmount } = render(<WorkbookExportForm action={action}><button type="submit">Export</button></WorkbookExportForm>);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Export' })); });
      expect(action).toHaveBeenCalledTimes(1);
      expect(push, href).not.toHaveBeenCalled();
      unmount();
    }
  });
});

describe('the Transaction View export actions', () => {
  const page = readFileSync(resolve(__dirname, '..', 'app/payroll/transaction-view/page.tsx'), 'utf8');
  const actionBody = (name: string) => {
    const at = page.indexOf(`async function ${name}(`);
    expect(at, `${name} not found`).toBeGreaterThan(-1);
    const body = page.slice(at, page.indexOf('\n  }\n', at));
    expect(body.length).toBeGreaterThan(100);
    return body;
  };

  it('return the list address instead of redirecting, so no whole-tree render rides on the action', () => {
    for (const name of ['startWorkbookExport', 'startHistoryWorkbookExport']) {
      const body = actionBody(name);
      expect(body, name).toContain("'use server'");
      expect(body, name).toContain('await scopedAdmin()');
      expect(body, name).toContain('Promise<string>');
      expect(body, name).not.toMatch(/\bredirect\s*\(/);
      expect(body, name).toMatch(/return `\$\{\w+\}&job=\$\{row\.id\}`/);
    }
    expect(page).toContain('<WorkbookExportForm action={startWorkbookExport}>');
    expect(page).toContain('<WorkbookExportForm key={choice.scope} action={startHistoryWorkbookExport}>');
  });

  it('the list page hands its signature to the poller and reads through the shared list', () => {
    const list = readFileSync(resolve(__dirname, '..', 'app/payroll/transaction-view/workbooks/page.tsx'), 'utf8');
    const route = readFileSync(resolve(__dirname, '..', 'app/payroll/transaction-view/workbooks/status/route.ts'), 'utf8');
    expect(list).toContain('<RefreshWorkbookList signature={workbookListSignature(jobs)} />');
    expect(list).toContain('await readWorkbookList(s, scopeIds)');
    expect(route).toContain('await scopedAdmin()');
    expect(route).toContain('await readWorkbookList(s, scopeIds)');
    expect(route).toContain("'private, no-store'");
  });
});
