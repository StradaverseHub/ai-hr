import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({
  session: vi.fn(), admin: vi.fn(), list: vi.fn(), build: vi.fn(), vocabulary: vi.fn(), translations: vi.fn(),
}));
vi.mock('../lib/session', () => ({ getSession: mocks.session }));
vi.mock('../lib/authz-model', () => ({ isAdmin: mocks.admin }));
vi.mock('../core/pay-components', () => ({ listPayComponents: mocks.list }));
vi.mock('../core/pay-component-import', () => ({ payItemVocabulary: mocks.vocabulary }));
vi.mock('../lib/pay-component-workbook', () => ({ buildPayItemWorkbook: mocks.build }));
vi.mock('next-intl/server', () => ({ getTranslations: mocks.translations }));
import { GET } from '../app/(app)/admin/pay-components/template/route';

beforeEach(() => { vi.resetAllMocks(); mocks.build.mockResolvedValue(Buffer.from('fictional template bytes')); });
describe('Pay Items single template entry point and canonical authorized catalogue', () => {
  it('retains only the import modal link while retaining import, CSV and create controls', () => {
    const page = readFileSync(new URL('../app/(app)/admin/pay-components/page.tsx', import.meta.url), 'utf8');
    const modal = readFileSync(new URL('../app/(app)/admin/pay-components/import-pay-items.tsx', import.meta.url), 'utf8');
    expect(page).not.toContain("t('downloadTemplate')");
    expect(modal.match(/href="\/admin\/pay-components\/template"/g)).toHaveLength(1);
    expect(page).toContain('<ImportPayItems />');
    expect(page).toContain('<DownloadCsv columns={exportColumns} rows={exportRows} filename="pay-items.csv" />');
    expect(page).toContain("t('createNew')");
  });
  it('refuses non-administrators before any catalogue access or workbook generation', async () => {
    const ctx = { tenantId: 'fictional tenant' }; mocks.session.mockResolvedValue(ctx); mocks.admin.mockReturnValue(false);
    expect((await GET()).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.build).not.toHaveBeenCalled();
  });
  it('passes only the authenticated current tenant read (including inactive rows) to the workbook and disallows caching', async () => {
    const ctx = { tenantId: 'fictional authorized tenant' }, catalogue = [{ code: 'ACTUAL_FICTIONAL', archivedAt: new Date() }], vocabulary = { kind: [] };
    mocks.session.mockResolvedValue(ctx); mocks.admin.mockReturnValue(true); mocks.list.mockResolvedValue(catalogue); mocks.vocabulary.mockReturnValue(vocabulary);
    const response = await GET();
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith(ctx, { includeArchived: true });
    expect(mocks.build).toHaveBeenCalledExactlyOnceWith(vocabulary, catalogue);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-disposition')).toMatch(/PayItems_Import_Template_\d{8}\.xlsx/);
    expect(await response.text()).toBe('fictional template bytes');
  });
});
