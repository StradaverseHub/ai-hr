import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
const { duplicate, remove, router } = vi.hoisted(() => ({ duplicate: vi.fn(), remove: vi.fn(), router: { push: vi.fn(), refresh: vi.fn() } }));
const catalogues = { en, ms, zh, ta, th, vi: viMessages };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }));
vi.mock('../app/(app)/reports/employee-master/actions', () => ({ duplicateEmployeeMaster: duplicate, deleteEmployeeMaster: remove }));
import { MasterReportActions } from '../app/(app)/reports/employee-master/MasterReportActions';
const reportId = '00000000-0000-4000-8000-000000000001', copiedId = '00000000-0000-4000-8000-000000000002';
function actions(locale: keyof typeof catalogues, canEdit: boolean) {
 return render(<NextIntlClientProvider locale={locale} timeZone="Asia/Kuala_Lumpur" messages={catalogues[locale]} onError={error => { throw error; }}><MasterReportActions id={reportId} canEdit={canEdit}/></NextIntlClientProvider>);
}
beforeEach(() => { vi.clearAllMocks(); duplicate.mockResolvedValue({ ok: true, id: copiedId }); remove.mockResolvedValue({ ok: true }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Actual action component and handlers; server owner permissions are not mocked into a security proof.
describe.each(['en','ms','zh','ta','th','vi'] as const)('Employee Master row actions in %s', locale => {
 it.each([true,false])('offers Run/Export/Duplicate and gates Edit/Delete using canEdit=%s', canEdit => {
  actions(locale, canEdit); const copy = catalogues[locale].employeeMasterReports;
  expect(screen.getByRole('link', { name: copy.runSavedReport })).toHaveAttribute('href', '/reports/employee-master/'+reportId);
  expect(screen.getByRole('button', { name: copy.export+' Excel' })).toBeEnabled();
  expect(screen.getByRole('button', { name: copy.duplicate })).toBeEnabled();
  const edit = screen.queryByRole('link', { name: copy.editSavedReport }), deletion = screen.queryByRole('button', { name: copy.delete });
  if (canEdit) { expect(edit).toHaveAttribute('href', '/reports/employee-master/'+reportId); expect(deletion).toBeEnabled(); }
  else { expect(edit).not.toBeInTheDocument(); expect(deletion).not.toBeInTheDocument(); }
 });
});
it('keeps Duplicate bound to the original id and opens the new private copy', async () => {
 actions('en', false); await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.employeeMasterReports.duplicate })); });
 expect(duplicate).toHaveBeenCalledWith(reportId); expect(router.push).toHaveBeenCalledWith('/reports/employee-master/'+copiedId); expect(router.refresh).toHaveBeenCalledTimes(1); expect(remove).not.toHaveBeenCalled();
});
it.each([false,true])('keeps Delete bound to the existing confirmation and owner action (confirmed=%s)', async confirmed => {
 const confirm = vi.spyOn(window, 'confirm').mockReturnValue(confirmed); actions('en', true);
 await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.employeeMasterReports.delete })); });
 expect(confirm).toHaveBeenCalledWith(en.employeeMasterReports.deleteConfirm);
 if (confirmed) { expect(remove).toHaveBeenCalledWith(reportId); expect(router.refresh).toHaveBeenCalledTimes(1); }
 else { expect(remove).not.toHaveBeenCalled(); expect(router.refresh).not.toHaveBeenCalled(); }
 expect(router.push).not.toHaveBeenCalled();
});
it('exports the existing saved id through the canonical XLSX endpoint without changing it', async () => {
 const fetch = vi.fn(async () => ({ ok: true, headers: { get: () => 'attachment; filename="Fictional-Master.xlsx"' }, blob: async () => new Blob(['fictional workbook']) }));
 const createObjectURL = vi.fn(() => 'blob:fictional-master'), revokeObjectURL = vi.fn(), BaseURL = globalThis.URL;
 vi.stubGlobal('fetch', fetch); vi.stubGlobal('URL', Object.assign(class extends BaseURL {}, { createObjectURL, revokeObjectURL }));
 const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {}); actions('en', false);
 await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.employeeMasterReports.export+' Excel' })); });
 expect(fetch).toHaveBeenCalledWith('/reports/employee-master/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: reportId, format: 'xlsx' }) });
 expect(createObjectURL).toHaveBeenCalledTimes(1); expect(click).toHaveBeenCalledTimes(1); expect(revokeObjectURL).toHaveBeenCalledWith('blob:fictional-master'); expect(router.refresh).toHaveBeenCalledTimes(1); expect(duplicate).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});
