/**
 * Request Leave relocation (feedback 48e69709) — static-source guard.
 *
 * The /leave apply surface moved from a collapsed <details> Card at the BOTTOM of the page to a prominent
 * "+" primary button in the PageHeader actions slot (visible for EVERY viewer, employees too) that opens the
 * same apply form inside a modal. Pure UI relocation — LeaveDurationFields, the Reason input, requestLeaveAction,
 * validations, permissions, and the previewLeaveDeductionAction wiring are unchanged. requestLeaveAction still
 * does revalidatePath('/leave') + redirect on success; the modal additionally closes itself onSubmit.
 *
 * DB-free / jsdom-free guard: fails loudly if a future edit half-reverts the relocation, drops the props the
 * form needs, re-hides the button behind the admin-only branch, or removes the i18n key.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

describe('Request Leave: relocated to a top-right primary "+" button', () => {
  const page = read('app/leave/page.tsx');

  it('drops the old bottom inline <details>/<summary> apply Card', () => {
    expect(page.includes('<details>')).toBe(false);
    expect(page.includes('<summary')).toBe(false);
    // The inline apply form no longer lives on the page (it now lives inside the dialog component).
    expect(page.includes("t('requestLeaveToggle')")).toBe(false);
    expect(page.includes('<LeaveDurationFields')).toBe(false);
  });

  it('renders <RequestLeaveDialog> in the PageHeader actions with the required props', () => {
    expect(page.includes('<RequestLeaveDialog')).toBe(true);
    for (const prop of ['types=', 'startDefault=', 'employeeOptions=', 'submitAction=', 'previewAction=']) {
      expect(page.includes(prop), prop).toBe(true);
    }
    // Wired to the unchanged server actions.
    expect(page.includes('submitAction={requestLeaveAction}')).toBe(true);
    expect(page.includes('previewAction={previewLeaveDeductionAction}')).toBe(true);
  });

  it('exposes the trigger to every SELF-SERVICE viewer — employees and managers, not admins (8ec63139)', () => {
    // 48e69709 put the trigger outside the `admin && (...)` block so employees got it too; 8ec63139 then
    // removed it from the HR-admin landing page, which is an employee-inquiry surface now. So the tag still
    // sits after the admin-guarded search/filter/export block, but inside the `ess` (= !admin) guard.
    // afd0a87c — this used to require the dialog to sit AFTER the first `{admin && (`, because the
    // admin-only search/filter/export block preceded it in source order. That block belonged to the
    // org-wide request table and has been removed, so the first `{admin && (` now comes LATER in the
    // file. Source ORDER was never the property under test; the ESS GUARD is. Asserted directly.
    const dialogAt = page.indexOf('<RequestLeaveDialog');
    expect(dialogAt).toBeGreaterThan(-1);
    expect(page).toMatch(/const ess = !admin;/);
    // The guard wraps the dialog — the nearest opening `{ess &&` before it is that guard.
    //
    // UPDATED BY ad965821 (AGENTS rule 18): the ESS guard — the property actually under test here — is
    // intact, but it is no longer the WHOLE condition. An employee who qualifies for no leave type at all
    // now gets no trigger rather than an empty form, mirroring the Replacement Leave button beside it. The
    // literal `{ess && (` was pinning the absence of that courtesy, which was never this case's subject.
    const guardAt = page.lastIndexOf('{ess &&', dialogAt);
    expect(guardAt, 'the trigger must sit inside an {ess && …} guard').toBeGreaterThan(-1);
    expect(
      page.slice(guardAt, dialogAt),
      'and offers nothing when the employee qualifies for nothing',
    ).toContain('requestLeaveTypeOptions.length > 0');
    // Nothing between the guard and the dialog may reopen an admin branch.
    expect(page.slice(guardAt, dialogAt).includes('{admin && (')).toBe(false);
    // A manager is not `admin`, so on-behalf-of application from this page is unaffected.
    expect(page).toContain('employeeOptions={canApplyOnBehalf ? requestLeaveEmployeeOptions : undefined}');
  });
});

describe('RequestLeaveDialog: client modal hosting the unchanged apply form', () => {
  const src = read('components/leave/request-leave-dialog.tsx');

  it('is a client island', () => {
    expect(src.startsWith("'use client'")).toBe(true);
  });

  it('uses a Radix Dialog with useState open + closes onSubmit', () => {
    expect(src.includes('Dialog.Root')).toBe(true);
    expect(src.includes('useState')).toBe(true);
    expect(src.includes('onSubmit={() => setOpen(false)}')).toBe(true);
  });

  it('primary "+" trigger uses btnPrimary + lucide Plus + the requestLeave label', () => {
    expect(src.includes('btnPrimary')).toBe(true);
    expect(src.includes('Plus')).toBe(true);
    expect(src.includes("t('requestLeave')")).toBe(true);
  });

  it('hosts the existing apply form: LeaveDurationFields + Reason + submit → submitAction (multipart)', () => {
    expect(src.includes('<LeaveDurationFields')).toBe(true);
    expect(src.includes('action={submitAction}')).toBe(true);
    expect(src.includes("encType=\"multipart/form-data\"")).toBe(true);
    expect(src.includes('name="reason"')).toBe(true);
    expect(src.includes('showDocumentFields')).toBe(true);
  });

  it('carries the onboarding-tour anchor moved off the old Card', () => {
    expect(src.includes('data-tour="leave-request"')).toBe(true);
  });
});

describe('Request Leave: i18n', () => {
  const locales = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

  it('every locale gains a non-empty leave.requestLeave label', () => {
    for (const loc of locales) {
      const msgs = JSON.parse(read(`messages/${loc}.json`)) as { leave: Record<string, string> };
      expect(msgs.leave.requestLeave, loc).toBeTruthy();
    }
  });
});
