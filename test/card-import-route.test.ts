import { beforeEach, expect, it, vi } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import { CARD_IMPORT_MAX_BYTES } from '../lib/card-import';
const calls = vi.hoisted(() => ({ session: vi.fn(), preview: vi.fn(), commit: vi.fn(), revalidate: vi.fn() }));
vi.mock('../lib/session', () => ({ getSession: calls.session }));
vi.mock('../lib/scope', () => ({ getScopeIds: async () => ['allowed-company'] }));
vi.mock('../core/read', () => ({ allowedCompanies: async () => [{ id: 'allowed-company' }] }));
vi.mock('../packs/attendance/service', () => ({ previewCardImport: calls.preview, commitCardImport: calls.commit }));
vi.mock('next/cache', () => ({ revalidatePath: calls.revalidate }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => createTranslator({ locale: 'en', messages: { cardImport: en.cardImport }, namespace: 'cardImport' }) }));
import { POST } from '../app/(app)/admin/card-assignment/import/route';
beforeEach(() => { vi.clearAllMocks(); calls.session.mockResolvedValue({ roles: ['hr_admin'] }); calls.preview.mockResolvedValue({ rows: [] }); calls.commit.mockResolvedValue({ total: 1 }); });
function request(operation = 'preview', extra: Record<string, string> = {}, origin = 'http://localhost') {
  const form = new FormData(); form.set('file', new File(['Fictional workbook bytes'], 'cards.xlsx')); form.set('operation', operation);
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return new Request('http://localhost/admin/card-assignment/import', { method: 'POST', headers: { Origin: origin }, body: form });
}
it('rejects a foreign origin before resolving a session or accepting an upload', async () => {
  expect((await POST(request('preview', {}, 'https://foreign.example'))).status).toBe(403);
  expect(calls.session).not.toHaveBeenCalled(); expect(calls.preview).not.toHaveBeenCalled(); expect(calls.commit).not.toHaveBeenCalled();
});
it('refuses an ordinary employee and a company outside the current selection', async () => {
  calls.session.mockResolvedValueOnce({ roles: ['employee'] });
  expect((await POST(request())).status).toBe(403);
  expect((await POST(request('preview', { company: 'foreign-company' }))).status).toBe(403);
  expect(calls.preview).not.toHaveBeenCalled(); expect(calls.commit).not.toHaveBeenCalled();
});
it('bounds the entire multipart stream before parsing or invoking an owner', async () => {
  const response = await POST(new Request('http://localhost/admin/card-assignment/import', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'multipart/form-data; boundary=fixture' }, body: 'x'.repeat(CARD_IMPORT_MAX_BYTES + 200_001) }));
  expect(response.status).toBe(413); expect(calls.preview).not.toHaveBeenCalled(); expect(calls.commit).not.toHaveBeenCalled();
});
it('keeps preview write-free and forwards the exact reviewed bytes, selection and acknowledgment to confirmation', async () => {
  const preview = await POST(request());
  expect(preview.headers.get('cache-control')).toContain('no-store'); expect(calls.commit).not.toHaveBeenCalled(); expect(calls.revalidate).not.toHaveBeenCalled();
  expect(calls.preview.mock.calls[0][2]).toEqual(Buffer.from('Fictional workbook bytes'));
  const confirmed = await POST(request('confirm', { receipt: 'reviewed-receipt', selection: '[3]', confirmReplacements: 'true' }));
  expect(confirmed.status).toBe(200);
  expect(calls.commit).toHaveBeenCalledWith({ roles: ['hr_admin'] }, ['allowed-company'], Buffer.from('Fictional workbook bytes'), 'cards.xlsx', 'reviewed-receipt', [3], true);
  expect(calls.revalidate).toHaveBeenCalledWith('/admin/card-assignment');
});
