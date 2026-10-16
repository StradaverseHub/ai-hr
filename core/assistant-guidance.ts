/** Authorised deterministic workflow guidance; no model-authored routes or implied completion. */
import type { SessionContext } from '../db/client';
import { ASSISTANT_ROUTES } from '../lib/assistant-routes';
import type { AssistantHandoff } from '../lib/assistant-conversation-model';
import { isAdmin } from '../lib/authz-model';
import { isModuleEnabled } from './entitlements';
export function assistantWorkflowAllowed(ctx: SessionContext, route: AssistantHandoff) { const entry = ASSISTANT_ROUTES[route]; return !!ctx.userId && (!entry.admin || isAdmin(ctx)) && (!entry.module || isModuleEnabled(ctx, entry.module)); }
/** These statements describe only existing guarded workflow entry points. The destination's own
 * permissions, company picker and review determine what can actually be read or changed. */
const GUIDANCE: Record<AssistantHandoff, string> = {
    personnelCreate: 'Open Personnel Management > Create new employee. Choose the company, complete the required fields and save a draft. Review it in the existing draft workflow before activation. No employee is created by this answer.',
    personnelImport: 'Open the Personnel import workspace. Download its current template, complete it, upload it and review validation before applying. This answer does not upload or import any file.',
    ownProfile: 'Open My Profile and choose your employment when offered. Use its existing editing and confirmation controls. This answer changes no profile fields.',
    ownAttendance: 'Open Attendance for your records, clocking and correction workflow. Existing schedule, location, device, photo and approval checks still apply. This answer records no clock or correction.',
    ownLeave: 'Open Leave to check available balances and request time off. Use its existing date, balance and overlap validation, then review and submit. This answer submits no leave.',
    ownPayslips: 'Open your personal profile payroll area for released payslips. A processed but unreleased payslip is not available through self service. This answer changes no pay.',
    payrollProcess: 'Open Payroll Processing and select an authorised company, period and run. Review the existing inputs, exceptions and calculated results before the existing processing/close steps. This answer does not process, close or pay a run.',
    payrollTransactions: 'Open Payroll Transactions for individual payroll inputs. Choose the authorised employee and period in that workflow; its validation and review control all changes. This answer writes no transaction.',
    payrollExceptions: 'Open the Payroll Control Tower to review payroll exceptions. Only the separate reviewed confirmation for corrected supported bank/tax causes can close those exact findings; it never changes money.',
    statutorySetup: 'Open the authorised employee in Personnel Management, then the Bank & Statutory section. Use the country-specific existing controls and confirmations. EPF and tax figures remain canonical payroll calculations; this answer changes no election, registration or amount.',
    eaStatement: 'Open your personal payroll documents for the applicable employment and assessment year. The existing EA document owner determines available statements. This answer neither files nor certifies a statement.',
    attendanceAllowance:'Open Attendance Allowance to create or edit a policy draft. Review the conditions, recorded-day preview, effective assignments and existing activation controls. This answer changes no policy, assignment, payroll input or payment.',
    feedback: 'Open Feedback, review and edit the requested improvement, then explicitly submit it through the existing form. This answer raises no feedback item automatically.',
};
export function assistantProductGuidance(ctx: SessionContext, route: AssistantHandoff) { return assistantWorkflowAllowed(ctx, route) ? { route, href: ASSISTANT_ROUTES[route].href, guidance: GUIDANCE[route] } : null; }
