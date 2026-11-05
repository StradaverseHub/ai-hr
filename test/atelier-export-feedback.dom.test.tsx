import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { ExportDownloadLink } from '../components/export-download-link';

const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: notices }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function link() {
  render(<NextIntlClientProvider locale="en" messages={en}>
    <ExportDownloadLink href="/reports/export?id=example">Export report</ExportDownloadLink>
  </NextIntlClientProvider>);
  return screen.getByRole('link', { name: 'Export report' });
}

describe('export feedback', () => {
  it('keeps the action busy until an attachment is received and hands off only one download', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = () => 'blob:staff';
      static revokeObjectURL = () => {};
    });
    const save = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const button = link();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(notices.success).not.toHaveBeenCalled();
    resolve(new Response('csv', { headers: { 'Content-Disposition': 'attachment; filename="staff.csv"' } }));
    await waitFor(() => expect(notices.success).toHaveBeenCalledWith('staff.csv'));
    expect(button).toHaveAttribute('aria-busy', 'false');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('reports an error instead of saving an authentication page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Sign in</html>')));
    const save = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const button = link();
    fireEvent.click(button);
    await waitFor(() => expect(notices.error).toHaveBeenCalled());
    expect(button).toHaveAttribute('aria-busy', 'false');
    expect(save).not.toHaveBeenCalled();
    expect(notices.success).not.toHaveBeenCalled();
  });
});
