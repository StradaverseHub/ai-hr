import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import {ExportDownloadForm} from '../components/export-download-form';
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
    await waitFor(() => expect(notices.success).toHaveBeenCalledWith('File prepared: staff.csv. Your browser handles saving it.'));
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
  it('keeps a POST export form disabled until complete attachment bytes arrive and preserves its submitted options',async()=>{
    let resolve!:(response:Response)=>void;const fetcher=vi.fn((_input:RequestInfo|URL,_options?:RequestInit)=>new Promise<Response>(done=>{resolve=done;}));vi.stubGlobal('fetch',fetcher);
    vi.stubGlobal('URL',class extends URL {static createObjectURL=()=> 'blob:chart';static revokeObjectURL=()=>{};});vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
    render(<NextIntlClientProvider locale="en" messages={en}><ExportDownloadForm action="/org/export"><input name="scope" defaultValue="branch"/><input name="root" defaultValue="employee-1"/><button type="submit">Create PDF</button></ExportDownloadForm></NextIntlClientProvider>);
    const button=screen.getByRole('button',{name:'Create PDF'}),form=button.closest('form')!;fireEvent.submit(form);fireEvent.submit(form);expect(fetcher).toHaveBeenCalledTimes(1);expect(button).toBeDisabled();expect(notices.success).not.toHaveBeenCalled();
    const options=fetcher.mock.calls[0][1] as RequestInit,body=options.body as FormData;expect(options.method).toBe('POST');expect(body.get('scope')).toBe('branch');expect(body.get('root')).toBe('employee-1');
    resolve(new Response('PDF',{headers:{'Content-Disposition':'attachment; filename="chart.pdf"'}}));await waitFor(()=>expect(notices.success).toHaveBeenCalledWith('File prepared: chart.pdf. Your browser handles saving it.'));expect(button).toBeEnabled();
  });

});
