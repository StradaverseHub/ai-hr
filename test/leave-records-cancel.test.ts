/**
 * fe3eb141 — "Remove Duplicate Request Subsection from Employee Details Page".
 *
 * BUILT: the Cancel Leave action (plus the leave REFERENCE and a Status column) now live on
 * Employee Leave Records, placed to the right of Final Approval Date exactly as the reporter asked.
 *
 * HELD: the removal of the Requests subsection on /leave. It is NOT a duplicate of Employee Leave
 * Records, and this file is the executable evidence for that — the r75 `4b90e548` discipline, where
 * two subsections asked to be deleted turned out to hold the only switch for multi-step approval and
 * the only editor for escalation settings.
 *
 * What the Requests subsection holds that Employee Leave Records does NOT, enumerated:
 *
 *  1. IT IS THE ORG-WIDE REGISTER. Employee Leave Records is hard-narrowed to ONE employment
 *     (`employmentIds: [selected.employmentId]`), chosen from a picker. "Show me every pending leave
 *     across the group" has no other home. §2 asserts both shapes.
 *  2. EDIT A PENDING REQUEST (`EditLeaveDialog` → `editLeaveRequest`). Subject-only.
 *  3. WITHDRAW A PENDING REQUEST (`CancelLeaveDialog` → `cancelOwnLeave`). Subject-only.
 *  4. GIVE BACK DATES ON APPROVED LEAVE (`CancelDatesDialog` → `requestLeaveCancellation`). Subject-only.
 *     2–4 matter more than they look: `ess = !admin` on /leave suppresses an HR admin's own
 *     self-service blocks, and /approvals self-bans the viewer's own rows. So for an HR ADMIN the
 *     Requests table is the ONLY place their own leave can be edited, withdrawn or partly given back.
 *     They cannot move to Employee Leave Records, because an admin there is never the subject.
 *  5. ELEVEN FILTERS with no equivalent: company, business unit, department, location, employee
 *     (multi), duration, applied-from, applied-to, pending-with, approved-by, and `q` in the panel.
 *  6. THE FILTERED EXPORT `/leave/export`, whose only link in the entire application source is that
 *     page (already pinned by test/leave-requests-not-approvals.test.ts).
 *
 * Composition is asserted from SOURCE — the RSC pages cannot render in this suite (same precedent as
 * test/leave-inquiry-surfaces.test.ts). The gate helper is pure, so it is exercised directly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canAdminCancelLeave, LEAVE_STATUS_PILL, LEAVE_STATUS_PILL_DEFAULT } from '../lib/leave-status';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const recordsPage = read('app/leave/employee-records/page.tsx');
const recordsExport = read('app/leave/employee-records/export/route.ts');
const leavePage = read('app/leave/page.tsx');
const leaveActionsSrc = read('app/leave/actions.ts');
const cancelDialog = read('components/leave/admin-cancel-leave-dialog.tsx');

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

// ── §1 BUILT: Cancel Leave on Employee Leave Records ───────────────────────────────────────────────
describe('§1 the Cancel Leave action now lives on Employee Leave Records', () => {
  it('renders the admin cancel dialog wired to the real server action', () => {
    expect(recordsPage).toContain('<AdminCancelLeaveDialog');
    expect(recordsPage).toContain('submitAction={adminCancelLeaveAction}');
    expect(recordsPage).toContain("back=\"/leave/employee-records\"");
  });

  it('places the action to the RIGHT of Final Approval Date, as specified', () => {
    // Column ORDER is the reporter's explicit instruction ("on the right side of the Final Approval
    // Date column"), so it is asserted as an order, not merely as presence.
    const finalApproval = recordsPage.indexOf("tInq('colFinalApproval')");
    const action = recordsPage.indexOf("t('colAction')");
    expect(finalApproval).toBeGreaterThan(-1);
    expect(action).toBeGreaterThan(finalApproval);
  });

  it('carries the selected employee back, so cancelling does not jump to someone else', () => {
    // /leave/employee-records picks its employee from ?emp=. A bare redirect would land on whoever
    // pickInquiryEmployee defaults to — a different person's records, right after a destructive act.
    expect(recordsPage).toContain('backEmp={selected?.employmentId}');
    expect(cancelDialog).toContain('name="backEmp"');
    expect(leaveActionsSrc).toContain("backRaw === '/leave/employee-records'");
    // Re-validated as a uuid server-side and never interpolated raw — the whitelist stays a whitelist.
    expect(leaveActionsSrc).toContain('/^[0-9a-f-]{36}$/i.test(backEmp)');
    expect(leaveActionsSrc).toContain('encodeURIComponent(backEmp)');
  });

  it('shows the outcome: both banners the redirect can produce', () => {
    expect(recordsPage).toContain("sp.toast === 'adminCancelled'");
    expect(recordsPage).toContain('{sp.error}');
    expect(leaveActionsSrc).toContain("withParam('toast=adminCancelled')");
    expect(leaveActionsSrc).toContain("revalidatePath('/leave/employee-records')");
  });

  it('answers the reporter’s question about the #reference: it is a real handle, so it is shown', () => {
    // listLeaveRequestsPage matches a uuid PREFIX in `q` (its `isRef` branch), so the id was already
    // searchable on this screen with nothing on screen to reveal it. It is now a column here and in
    // the export.
    expect(recordsPage).toContain('#{r.id.slice(0, 8)}');
    expect(recordsPage).toContain("t('filters.reference')");
    expect(recordsExport).toContain('`#${r.id.slice(0, 8)}`');
    expect(read('core/read.ts')).toContain('const isRef = !!refTerm');
  });

  it('renders a Status column, without which the missing button is unexplainable', () => {
    expect(recordsPage).toContain("sortableTh('status', t('filters.statusLabel'))");
    expect(recordsPage).toContain("t(`status.${r.status}`)");
    expect(recordsPage).toContain("t('cancelPendingBadge')");
  });

  it('the status pill palette has ONE definition, shared by both tables', () => {
    // Two screens describing the same records must not disagree about what "approved" looks like.
    expect(leavePage).toContain('const REQ_STATUS = LEAVE_STATUS_PILL;');
    expect(leavePage).toContain("from '@/lib/leave-status'");
    expect(recordsPage).toContain('LEAVE_STATUS_PILL');
    for (const s of ['pending', 'approved', 'rejected']) expect(LEAVE_STATUS_PILL[s]).toBeTruthy();
    // `cancelled` deliberately has no colour of its own and falls through to the muted default.
    expect(LEAVE_STATUS_PILL.cancelled).toBeUndefined();
    expect(LEAVE_STATUS_PILL_DEFAULT).toContain('muted');
  });

  it('renders Applied and Final Approval through the tenant timezone, not UTC', () => {
    // Both are INSTANTS. `toISOString().slice(0,10)` is UTC and this product runs at UTC+8, so the
    // previous rendering printed YESTERDAY between 00:00 and 08:00 MYT — on the very column this
    // item anchors its action to. Same class as r85's core/movement.ts fault.
    expect(recordsPage).toContain('todayInKualaLumpur(new Date(v))');
    expect(recordsPage).not.toContain("new Date(v).toISOString().slice(0, 10)");
    expect(recordsExport).toContain('todayInKualaLumpur(new Date(v))');
  });
});

// ── §2 the gate mirrors the service, and refuses what the service refuses ─────────────────────────
describe('§2 canAdminCancelLeave mirrors adminCancelLeave’s gates', () => {
  const row = (over: Partial<{ status: string; typeCode: string | null; personId: string | null }> = {}) => ({
    status: 'approved',
    typeCode: 'ANNUAL',
    personId: 'p-other',
    ...over,
  });

  it('offers the action on someone else’s pending or approved leave', () => {
    expect(canAdminCancelLeave(row({ status: 'pending' }), 'p-me')).toBe(true);
    expect(canAdminCancelLeave(row({ status: 'approved' }), 'p-me')).toBe(true);
  });

  it('never offers it on the viewer’s OWN row — the service self-bans below super_admin', () => {
    expect(canAdminCancelLeave(row({ personId: 'p-me' }), 'p-me')).toBe(false);
    // A viewer with no person (service account) is not the subject of anything.
    expect(canAdminCancelLeave(row(), null)).toBe(true);
  });

  it('never offers it on a decided row', () => {
    expect(canAdminCancelLeave(row({ status: 'rejected' }), 'p-me')).toBe(false);
    expect(canAdminCancelLeave(row({ status: 'cancelled' }), 'p-me')).toBe(false);
  });

  it('never offers it on APPROVED replacement leave — the register consume has no ledger inverse', () => {
    expect(canAdminCancelLeave(row({ status: 'approved', typeCode: 'REPLACEMENT' }), 'p-me')).toBe(false);
    // A PENDING replacement was never consumed, so it is cancellable — matching the service gate.
    expect(canAdminCancelLeave(row({ status: 'pending', typeCode: 'REPLACEMENT' }), 'p-me')).toBe(true);
  });

  it('the same four gates exist in the service, which stays the authority', () => {
    const src = read('core/leave.ts');
    expect(src).toContain('export async function adminCancelLeave');
    // The closed-payroll gate is a DB read and deliberately NOT mirrored in the pure helper: the
    // dialog surfaces that refusal as an error banner rather than hiding the button.
    expect(src).toContain('cancelDatePeriodClosed');
    expect(recordsPage).toContain('canAdminCancelLeave(r, session.personId)');
  });
});

// ── §3 HELD: why the Requests subsection is still mounted ─────────────────────────────────────────
describe('§3 the Requests subsection is HELD, and here is what it alone can do', () => {
  it('1. it is the ORG-WIDE register; Employee Leave Records is one employee at a time', () => {
    expect(recordsPage).toContain('employmentIds: [selected.employmentId]');
    expect(recordsPage).toContain('pickInquiryEmployee(employees, sp.emp)');
    // /leave passes no employmentIds narrowing of its own — it lists everyone in scope.
    expect(leavePage).toContain('companyIds: scopeIds');
    expect(leavePage).not.toContain('employmentIds: [selected.employmentId]');
  });

  it('2-4. edit / withdraw / give-back are SUBJECT-ONLY and cannot move to a per-employee admin screen', () => {
    for (const dialog of ['<EditLeaveDialog', '<CancelLeaveDialog', '<CancelDatesDialog']) {
      expect(leavePage.includes(dialog), dialog).toBe(true);
      expect(recordsPage.includes(dialog), dialog).toBe(false);
    }
    // The reason they cannot move: each of the three services asserts the caller IS the subject, and
    // an admin on Employee Leave Records is looking at somebody else by construction.
    const core = read('core/leave.ts');
    expect(core).toContain('export async function editLeaveRequest');
    expect(core).toContain('export async function cancelOwnLeave');
    expect(core).toContain('export async function requestLeaveCancellation');
    // And an HR admin's own self-service blocks on /leave are suppressed, so the Requests table is
    // the only surface that shows them their own rows with controls.
    expect(leavePage).toContain('const ess = !admin;');
  });

  it('5. eleven filters exist only on the Requests subsection', () => {
    const onlyThere = [
      "name: 'company'",
      "name: 'bu'",
      "name: 'dept'",
      "name: 'loc'",
      "name: 'emp'",
      "name: 'duration'",
      "name: 'appliedFrom'",
      "name: 'appliedTo'",
      "name: 'pendingWith'",
      "name: 'approvedBy'",
    ];
    for (const f of onlyThere) {
      expect(leavePage.includes(f), `/leave should have ${f}`).toBe(true);
      expect(recordsPage.includes(f), `records should NOT have ${f}`).toBe(false);
    }
  });

  it('6. /leave/export would be orphaned by the removal', () => {
    expect(leavePage).toContain('/leave/export?');
    expect(recordsPage).not.toContain('/leave/export?');
  });

  it('the hold is recorded where the next reader of the page will meet it', () => {
    // A finding that lives only in a report is a finding that gets re-litigated.
    expect(recordsPage).toContain('STEP 2 — deleting the Requests subsection — IS NOT DONE');
    expect(recordsPage).toContain('test/leave-records-cancel.test.ts');
  });
});

// ── §4 no new strings were invented; every key used already ships in six locales ──────────────────
describe('§4 i18n', () => {
  it('every key the new columns and banners use resolves in all six locales', () => {
    const leaveKeys = ['colAction', 'cancelPendingBadge', 'adminCancelledToast'];
    const filterKeys = ['reference', 'statusLabel'];
    const statusKeys = ['pending', 'approved', 'rejected', 'cancelled'];
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      for (const k of leaveKeys) {
        expect(String(msgs.leave?.[k] ?? '').trim(), `${loc}.leave.${k}`).not.toBe('');
      }
      for (const k of filterKeys) {
        expect(String(msgs.leave?.filters?.[k] ?? '').trim(), `${loc}.leave.filters.${k}`).not.toBe('');
      }
      for (const k of statusKeys) {
        expect(String(msgs.leave?.status?.[k] ?? '').trim(), `${loc}.leave.status.${k}`).not.toBe('');
      }
    }
  });
});
