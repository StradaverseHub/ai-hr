/**
 * a1a80747 r2 — the Payroll Process list's refresh island (app/payroll/outstanding-refresh.tsx), proved by rendering.
 *
 * It asks ONCE for the runs whose stored "still owed processing" answer is due, follows that one job, says so while it
 * works, and refreshes the server render when the job finishes, so the list's Reprocess Required counts catch up by
 * themselves. It never asks twice for the same runs (a remount follows the same request), asks for nothing when no run
 * is due, and stops quietly when nothing was queued or the job ended without finishing. The two server actions are
 * stubbed: their behaviour against a real database is test/payroll-run-outstanding-a1a80747.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { StrictMode } from 'react';
import messages from '../messages/en.json';

const { refresh, request, read } = vi.hoisted(() => ({
  refresh: vi.fn(),
  request: vi.fn(),
  read: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('../app/payroll/outstanding-actions', () => ({
  requestPayrollOutstandingRefreshAction: request,
  readPayrollOutstandingRefreshAction: read,
}));
import { PayrollOutstandingRefresh } from '../app/payroll/outstanding-refresh';

const UPDATING = 'Checking which payrolls still have employees to process…';
const mount = (ids: string[]) =>
  render(
    <StrictMode>
      <NextIntlClientProvider locale="en" messages={messages}>
        <PayrollOutstandingRefresh batchIds={ids} />
      </NextIntlClientProvider>
    </StrictMode>,
  );
/** Let pending promises settle and advance the poll timer. */
const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockReset();
  request.mockReset();
  read.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a1a80747 r2 — the list keeps its Reprocess Required counts current', () => {
  it('asks once for the due runs, says so while the job runs, and refreshes the list when it finishes', async () => {
    request.mockResolvedValue({ jobId: 'job-1' });
    read.mockResolvedValueOnce('running').mockResolvedValueOnce('done');
    mount(['b1', 'b2']);
    await tick();
    // StrictMode mounts the effect twice: still ONE request, for exactly the runs given, in order.
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(['b1', 'b2']);
    expect(screen.getByRole('status').textContent).toBe(UPDATING);
    expect(refresh).not.toHaveBeenCalled();
    await tick(2_000);
    expect(read).toHaveBeenCalledWith('job-1');
    expect(refresh).not.toHaveBeenCalled();
    await tick(2_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('asks for nothing when no run is due, and renders nothing', async () => {
    const { container } = mount([]);
    await tick(10_000);
    expect(request).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });

  it('stops quietly when nothing was queued, and never refreshes for a job that did not finish', async () => {
    request.mockResolvedValueOnce({ jobId: null });
    const first = mount(['b1']);
    await tick(10_000);
    expect(read).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    first.unmount();

    request.mockResolvedValueOnce({ jobId: 'job-2' });
    read.mockResolvedValue('failed');
    mount(['b3']);
    await tick(2_000);
    expect(read).toHaveBeenCalledWith('job-2');
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('gives up following a job that is still running after ninety seconds, without refreshing', async () => {
    request.mockResolvedValue({ jobId: 'job-3' });
    read.mockResolvedValue('running');
    mount(['b4']);
    await tick();
    for (let i = 0; i < 50; i++) await tick(2_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const calls = read.mock.calls.length;
    await tick(10_000);
    expect(read.mock.calls.length).toBe(calls);
  });
});
