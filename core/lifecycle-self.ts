/**
 * Lifecycle new-hire self-service (ADR-0095). A new hire sees ONLY their own onboarding checklist, through
 * two SECURITY DEFINER functions (migration 0516) that match the signed-in user's own person email to the
 * case's new-hire email. They are not module staff, so RLS shows them nothing in lc_case; the function
 * returns a FIXED allowlist of fields. It never carries the identity number, bank details, cost centre,
 * temporary passwords, notes, custom fields or staff names.
 *
 * Their one action is the Device Acceptance Acknowledgement. There is deliberately no public link: the form
 * is a signed-in action in their own view, so the app's unauthenticated perimeter does not widen. A public
 * link (the handover's design) is a DECISION REQUIRED for the owner (ADR-0095).
 */
import { sql } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { ONBOARDING_PHASES } from './lifecycle-defaults';
import { defaultStepDefs } from './lifecycle-config';
import { buildStepViews, progressOf, type StepDef } from './lifecycle-rules';
import { LifecycleError, clean, normEmail, withTenant } from './lifecycle-base';

export type MyOnboarding = {
  number: string;
  status: string;
  fullName: string;
  jobTitle: string | null;
  department: string | null;
  companyName: string;
  joinDate: string | null;
  supervisor: string | null;
  gbsTa: string | null;
  floorBuilding: string | null;
  laptopRequired: boolean;
  employeeNo: string;
  steps: { key: string; label: string; phase: number; ownerTeam: string; applicable: boolean; done: boolean }[];
  phases: Record<number, string>;
  progress: { done: number; total: number; percent: number };
  acknowledgement: { required: boolean; available: boolean; submittedAt: string | null };
};

type Raw = {
  case: {
    number: string; status: 'in_progress' | 'completed'; fullName: string; jobTitle: string | null; department: string | null; companyId: string; companyName: string;
    joinDate: string | null; supervisor: string | null; gbsTa: string | null; floorBuilding: string | null; laptopRequired: boolean; carparkRequired: boolean;
    employeeNo: string; daaSubmittedAt: string | null;
  };
  done: string[];
  defs: { key: string; phase: number; label: string; ownerTeam: string; rule: StepDef['rule']; sort: number; active: boolean }[];
};

/** The caller's own onboarding checklist, or null when no case is linked to their account. */
export async function getMyOnboarding(ctx: SessionContext): Promise<MyOnboarding | null> {
  return withTenant(ctx, async (tx) => {
    if (!ctx.userId) return null;
    const rows = (await tx.execute(sql`select app.lc_my_view() as v`)) as unknown as { v: Raw | null }[];
    const raw = rows[0]?.v;
    if (!raw) return null;
    const c = raw.case;
    const doneKeys = new Set(raw.done);
    const defs: StepDef[] = (raw.defs.length === 0
      ? defaultStepDefs('onboarding')
      : raw.defs.filter((d) => d.active || doneKeys.has(d.key)).map((d) => ({ key: d.key, phase: d.phase, label: d.label, ownerTeam: d.ownerTeam, hrms: false, rule: d.rule, sort: d.sort })));
    const views = buildStepViews(defs, raw.done.map((key) => ({ key, done: true })), {
      kind: 'onboarding', status: c.status, laptopRequired: c.laptopRequired, carparkRequired: c.carparkRequired, outcome: 'pending',
    });
    return {
      number: c.number, status: c.status, fullName: c.fullName, jobTitle: c.jobTitle, department: c.department, companyName: c.companyName,
      joinDate: c.joinDate, supervisor: c.supervisor, gbsTa: c.gbsTa, floorBuilding: c.floorBuilding, laptopRequired: c.laptopRequired, employeeNo: c.employeeNo,
      steps: views.filter((v) => v.applicability !== 'na').map((v) => ({ key: v.key, label: v.label, phase: v.phase, ownerTeam: v.ownerTeam, applicable: true, done: v.done })),
      phases: ONBOARDING_PHASES,
      progress: progressOf(views),
      acknowledgement: {
        required: c.laptopRequired,
        available: c.laptopRequired && c.status === 'in_progress' && !c.daaSubmittedAt && doneKeys.has('laptop_dist'),
        submittedAt: c.daaSubmittedAt,
      },
    };
  });
}

export type AcknowledgementInput = {
  contactNumber: string; accessories?: string | null; pcType?: string | null; serialNumber: string;
  hasMonitor?: boolean; monitorSerial?: string | null; acknowledged: boolean; receiptEmail?: string | null;
};

/** Submit the Device Acceptance Acknowledgement for the caller's own case. One submission only. */
export async function submitMyAcknowledgement(ctx: SessionContext, p: AcknowledgementInput): Promise<void> {
  if (p.acknowledged !== true) throw new LifecycleError('Please tick the acknowledgement to confirm you received the equipment.');
  const contact = clean(p.contactNumber, 40);
  const serial = clean(p.serialNumber, 100);
  if (!contact) throw new LifecycleError('Your contact number is required.');
  if (!serial) throw new LifecycleError('The serial number of your device is required.');
  if (p.hasMonitor && !clean(p.monitorSerial, 100)) throw new LifecycleError('Enter the monitor serial number, or untick the monitor.');
  const data = {
    contactNumber: contact, accessories: clean(p.accessories, 300), pcType: clean(p.pcType, 100), serialNumber: serial,
    hasMonitor: p.hasMonitor === true, monitorSerial: p.hasMonitor ? clean(p.monitorSerial, 100) : null,
    receiptEmail: normEmail(p.receiptEmail), acknowledged: true, submittedAt: new Date().toISOString(),
  };
  await withTenant(ctx, async (tx) => {
    if (!ctx.userId) throw new LifecycleError('Not signed in.', 'forbidden');
    let id: string;
    try {
      const rows = (await tx.execute(sql`select app.lc_my_daa_submit(${JSON.stringify(data)}::jsonb) as id`)) as unknown as { id: string }[];
      id = rows[0]!.id;
    } catch (e) {
      const m = (e as { cause?: { message?: string }; message?: string });
      const msg = m.cause?.message ?? m.message ?? '';
      if (/not available|not been marked|No onboarding case/.test(msg)) throw new LifecycleError(msg.replace(/^.*?:\s*/, ''), 'conflict');
      throw e;
    }
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'lifecycle-case', aggregateId: id, eventType: 'lifecycle-case.daa-submitted', actor: actorOf(ctx), payload: { action: 'daa.submitted' } });
  });
}
