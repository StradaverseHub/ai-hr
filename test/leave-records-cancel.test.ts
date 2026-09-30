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
 *  2. EDIT A PENDING REQUEST (`EditLeaveDialog` → `editLeaveRequest`). Subject-only. GENUINELY LOST.
 *  3. WITHDRAW A PENDING REQUEST (`CancelLeaveDialog` → `cancelOwnLeave`). Subject-only. NOT LOST.
 *  4. GIVE BACK DATES ON APPROVED LEAVE (`CancelDatesDialog` → `requestLeaveCancellation`). NOT LOST.
 *
 *     CORRECTION (afd0a87c). This file used to claim that for an HR ADMIN the Requests table was "the
 *     ONLY place their own leave can be edited, withdrawn or partly given back". That was FALSE for 3
 *     and 4. components/planned-absences.tsx gates `cancelEligible` and `selfCancelEligible` on
 *     `personId === viewerPersonId` with NO admin exclusion — only `adminCancelEligible` carries a
 *     self-ban — and planned-absences-grid.tsx renders both dialogs off those flags for every viewer.
 *     So withdrawing and giving back your own leave both still work from the dashboard calendar,
 *     bounded only by its visible week/month window. Only 2 (edit a pending request) is truly homeless
 *     for an admin, and withdraw-and-reapply is the workaround. Disclosed in the approved plan.
 *  5. ELEVEN FILTERS with no equivalent. GENUINELY LOST, disclosed and accepted.
 *  6. THE FILTERED EXPORT `/leave/export`. Its route is DELETED in the same change rather than left
 *     unreachable — an admin download nothing links to is worse than none.
 *
 * THE HOLD IS OVER. The reporter has asked plainly for the removal, with no relocation, and said they
 * will redesign Employee Leave Record separately. §3 below therefore inverts from "HELD, and here is what
 * it alone can do" into "REMOVED, and here is where each item now lives or that it is an accepted loss".
 *
 * Composition is asserted from SOURCE — the RSC pages cannot render in this suite (same precedent as
 * test/leave-inquiry-surfaces.test.ts). The gate helper is pure, so it is exercised directly.
 */
import { existsSync, readFileSync } from 'node:fs';
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

// ── §3 REMOVED: where each capability went, or that its loss was accepted ─────────────────────────
describe('§3 the Requests subsection is REMOVED — where each of its six capabilities went', () => {
  it('1. the ORG-WIDE register is an ACCEPTED LOSS; Employee Leave Records stays one employee at a time', () => {
    // The destination is unchanged and still per-employee, which is exactly why it is not a replacement.
    expect(recordsPage).toContain('employmentIds: [selected.employmentId]');
    /**
     * ⚠️ 9949f91a (r369) — UPDATED, with the retired call quoted: this read
     *     expect(recordsPage).toContain('pickInquiryEmployee(employees, sp.emp)');
     * The property this case is about — "stays one employee at a time" — is unchanged and is carried by the
     * line above. What moved is only the FALLBACK: `pickInquiryEmployee` opened the screen on the first
     * employee when `?emp=` was absent, and the reporter asked for "Select an employee to view their leave
     * records" instead. `selectInquiryEmployee` is the same narrowing with no fallback; the export route still
     * calls the original (lib/leave-inquiry.ts says why).
     */
    expect(recordsPage).toContain('selectInquiryEmployee(employees, sp.emp)');
    // And /leave no longer runs an UNNARROWED org-wide request read at all.
    //
    // UPDATED BY 5f2e20fb (AGENTS rule 18): the accepted loss is the org-wide REGISTER, not the read's
    // name. The employee's own My Leave History now uses the paginated read for its date/leave-type
    // filter, narrowed to the viewer's own employments — which is the opposite of a register. Asserted
    // on the narrowing, which is what made the old call org-wide in the first place.
    for (const call of leavePage.match(/listLeaveRequestsPage\(session, \{[\s\S]*?\n\s*\}\)/g) ?? []) {
      expect(call).toContain('employmentIds:');
      expect(call).not.toContain('companyIds:');
    }
  });

  it('2. editing your OWN pending request is the one real loss for an admin', () => {
    // EditLeaveDialog SURVIVES in source and still works for an ordinary employee — it is built from
    // `selfHistory`, which is the viewer's own rows. What an ADMIN loses is REACHING it, and 388e53c2
    // made that more explicit rather than changing it: the arm used to be `selfHistory = admin ? [] : …`,
    // and it is now an early return at the top of the page, so an administrator renders none of the
    // self-service surface at all. Employee Leave Records cannot stand in because an admin there is never
    // the subject. Withdraw-and-reapply is the workaround; disclosed in the approved plan.
    expect(leavePage).toContain('<EditLeaveDialog');
    expect(leavePage).toContain('if (me == null || admin) {');
    // 5f2e20fb moved the newest-first ordering into SQL (sort 'start', dir 'desc'), so the JS re-sort it
    // used to need is gone. `selfHistory` is still the viewer's own rows and still what EditLeaveDialog is
    // built from, which is the property this case is about.
    expect(leavePage).toContain('const selfHistory = historyShown.rows;');
    // The early return really does precede the dialog it fences off.
    expect(leavePage.indexOf('if (me == null || admin) {')).toBeLessThan(leavePage.indexOf('<EditLeaveDialog'));
    expect(recordsPage.includes('<EditLeaveDialog')).toBe(false);
    // The service is untouched — nothing about the ability was deleted, only the surface that reached it.
    expect(read('core/leave.ts')).toContain('export async function editLeaveRequest');
  });

  it('3-4. withdraw and give-back are NOT lost — the dashboard calendar already carries both', () => {
    // This is the claim the old header got wrong. Asserted at the surviving home so it cannot rot again.
    const absences = read('components/planned-absences.tsx');
    const grid = read('components/planned-absences-grid.tsx');
    // Neither self-service gate excludes an admin; only the admin-cancel one self-bans.
    expect(absences).toContain('const cancelEligible = (personId: string, l: Leave): boolean =>');
    expect(absences).toContain('const selfCancelEligible = (personId: string, l: Leave): boolean =>');
    expect(absences).toContain('(viewerPersonId == null || personId !== viewerPersonId) &&');
    // …and the grid renders both dialogs off those flags for every viewer.
    expect(grid).toContain('<CancelLeaveDialog');
    expect(grid).toContain('<CancelDatesDialog');
    // The services stay the authority and are untouched.
    const core = read('core/leave.ts');
    expect(core).toContain('export async function cancelOwnLeave');
    expect(core).toContain('export async function requestLeaveCancellation');
  });

  it('5. the eleven filters are an ACCEPTED LOSS — gone from /leave, never present on records', () => {
    for (const f of ["name: 'bu'", "name: 'loc'", "name: 'duration'", "name: 'appliedFrom'", "name: 'appliedTo'", "name: 'pendingWith'", "name: 'approvedBy'"]) {
      expect(leavePage.includes(f), `/leave should no longer have ${f}`).toBe(false);
      expect(recordsPage.includes(f), `records never had ${f}`).toBe(false);
    }
  });

  it('6. /leave/export is DELETED, not left orphaned', () => {
    expect(existsSync(root + 'app/leave/export/route.ts')).toBe(false);
    expect(leavePage).not.toContain('/leave/export?');
    // The surviving per-employee download is untouched.
    expect(existsSync(root + 'app/leave/employee-records/export/route.ts')).toBe(true);
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

  it('the two COMPUTED keys resolve — check C of i18n-coverage cannot see them', () => {
    // `t(`status.${r.status}`)` and `t(`filters.stage.${r.currentStepKind}`)` are computed, so the
    // coverage guard's literal-key regex is blind to them. The value sets are closed and small:
    // the four leave statuses, and the two approver kinds the source narrows to before calling t().
    for (const loc of LOCALES) {
      const leave = JSON.parse(read(`messages/${loc}.json`)).leave;
      for (const s of ['pending', 'approved', 'rejected', 'cancelled']) {
        expect(String(leave.status?.[s] ?? '').trim(), `${loc}.leave.status.${s}`).not.toBe('');
      }
      for (const k of ['direct_manager', 'hr_admin']) {
        expect(String(leave.filters?.stage?.[k] ?? '').trim(), `${loc}.leave.filters.stage.${k}`).not.toBe('');
      }
      for (const k of ['decidedByLine', 'pendingWithLine']) {
        expect(String(leave.filters?.[k] ?? ''), `${loc}.leave.filters.${k}`).toMatch(/\{(name|stage)\}/);
      }
    }
    // And the source really does narrow to those two before computing the key.
    expect(recordsPage).toContain("r.currentStepKind === 'direct_manager' || r.currentStepKind === 'hr_admin'");
  });
});
