/** Transaction View › Workbooks: while a workbook is being prepared the page polls a small read and re-renders once.
 *
 * Staging 24 Nov 2026 timed a full Workbooks render at 4.9 s (34 transactions, almost all of it the app shell), while
 * the old list re-rendered the whole page every 3 s on a timer, so a slow render overlapped the next one. Pinned here:
 *  - while a workbook is preparing, only the small poll runs: no page (and shell) re-render on a timer;
 *  - the next poll is asked only after the previous answer arrived, however slow it is (no overlap);
 *  - the page re-renders exactly once, when no workbook is preparing, and polling then stops;
 *  - a failed poll waits longer before the next one; a hidden tab is not polled; unmounting stops everything;
 *  - the page reads its list through the summary reader, not the whole job row. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
import { RefreshWorkbookList, WORKBOOK_POLL_MS, WORKBOOK_POLL_RETRY_MS } from '../app/payroll/transaction-view/workbooks/refresh';

let visibility: DocumentVisibilityState = 'visible';
beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockClear();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** A poll whose answers the test releases one at a time. */
function manualPoll() {
  const pending: Array<(answer: boolean | null) => void> = [];
  const poll = vi.fn(() => new Promise<boolean | null>((resolve) => { pending.push(resolve); }));
  const answer = (value: boolean | null) => act(async () => { pending.shift()!(value); await vi.advanceTimersByTimeAsync(0); });
  return { poll, answer, pending };
}

it('polls the small read while a workbook is preparing and never re-renders the page on a timer', async () => {
  const poll = vi.fn(async () => true);
  render(<RefreshWorkbookList preparing={poll} />);
  expect(poll).not.toHaveBeenCalled();
  await advance(WORKBOOK_POLL_MS);
  expect(poll).toHaveBeenCalledTimes(1);
  await advance(WORKBOOK_POLL_MS * 4);
  expect(poll).toHaveBeenCalledTimes(5);
  expect(refresh).not.toHaveBeenCalled();
});

it('asks again only after the previous answer arrived, however slow it is', async () => {
  const { poll, answer, pending } = manualPoll();
  render(<RefreshWorkbookList preparing={poll} />);
  await advance(WORKBOOK_POLL_MS);
  expect(poll).toHaveBeenCalledTimes(1);
  // A 30 s answer: no second poll and no re-render start while the first is in flight.
  await advance(30_000);
  expect(poll).toHaveBeenCalledTimes(1);
  expect(pending).toHaveLength(1);
  await answer(true);
  await advance(WORKBOOK_POLL_MS - 1);
  expect(poll).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(poll).toHaveBeenCalledTimes(2);
  expect(refresh).not.toHaveBeenCalled();
});

it('re-renders the page exactly once when no workbook is preparing, then stops', async () => {
  const { poll, answer } = manualPoll();
  render(<RefreshWorkbookList preparing={poll} />);
  await advance(WORKBOOK_POLL_MS);
  await answer(false);
  expect(refresh).toHaveBeenCalledTimes(1);
  await advance(WORKBOOK_POLL_MS * 10);
  expect(poll).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('waits longer after a failed poll and does not re-render on a failure', async () => {
  const { poll, answer } = manualPoll();
  render(<RefreshWorkbookList preparing={poll} />);
  await advance(WORKBOOK_POLL_MS);
  await answer(null);
  await advance(WORKBOOK_POLL_RETRY_MS - 1);
  expect(poll).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(poll).toHaveBeenCalledTimes(2);
  expect(refresh).not.toHaveBeenCalled();
});

it('does not poll a hidden tab and resumes when it is visible again', async () => {
  const poll = vi.fn(async () => true);
  visibility = 'hidden';
  render(<RefreshWorkbookList preparing={poll} />);
  await advance(WORKBOOK_POLL_MS * 5);
  expect(poll).not.toHaveBeenCalled();
  visibility = 'visible';
  await advance(WORKBOOK_POLL_MS);
  expect(poll).toHaveBeenCalledTimes(1);
});

it('stops when the list no longer shows a preparing workbook, even with an answer in flight', async () => {
  const { poll, answer } = manualPoll();
  const view = render(<RefreshWorkbookList preparing={poll} />);
  await advance(WORKBOOK_POLL_MS);
  view.unmount();
  await answer(false);
  await advance(WORKBOOK_POLL_MS * 5);
  expect(poll).toHaveBeenCalledTimes(1);
  expect(refresh).not.toHaveBeenCalled();
});

it('the page reads the summary list once and mounts the poll only while a workbook is preparing', () => {
  const root = join(__dirname, '..', 'app/payroll/transaction-view/workbooks');
  const page = readFileSync(join(root, 'page.tsx'), 'utf8');
  expect(page).toContain('listTransactionWorkbooks(s, scopeIds)');
  expect(page).not.toMatch(/listBulkJobsTx|select \*/);
  expect(page).toMatch(/preparing\.length > 0 && <RefreshWorkbookList key=\{preparing\.join\(','\)\} \/>/);
  const route = readFileSync(join(root, 'preparing/route.ts'), 'utf8');
  expect(route).toMatch(/export async function GET\(\)/);
  expect(route).toContain('scopedAdmin()');
  expect(route).toContain('transactionWorkbooksPreparing(s, scopeIds)');
  expect(route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  const refreshSource = readFileSync(join(root, 'refresh.tsx'), 'utf8');
  expect(refreshSource).not.toMatch(/setInterval/);
});
