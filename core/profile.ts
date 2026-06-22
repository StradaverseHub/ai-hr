/**
 * Employee self-service profile (ADR-0012). Two paths by risk:
 *  - low-risk contact fields → direct self-edit of `person` (RLS confines it to the caller's
 *    own row; this is the only writer that runs under an employee session and it never touches
 *    name/email/identity);
 *  - pay-affecting fields (bank, dependents, PCB category on employee_statutory_my) → a change
 *    request an admin approves before it applies. Reuses the shared `assertCanDecide` guard.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent, subjectEmploymentForPerson } from '../db/events';
import { employeeStatutoryMy, employment, person, profileChangeRequest } from '../db/schema';
import { assertCanDecide } from './approvals';

const clean = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};
const oneOf = (v: unknown, allowed: readonly string[]): string | null => {
  const s = clean(v);
  return s && allowed.includes(s) ? s : null;
};
export const GENDERS = ['male', 'female', 'undisclosed'] as const;
export const MARITAL_STATUSES = ['single', 'married', 'other'] as const;

export type ProfileChangeProposed = {
  bankName?: string | null;
  bankAccountNo?: string | null;
  taxCategory?: number;
  numChildren?: number;
};

/** Keep only the recognised, sanitised keys — the bundle is a jsonb patch we later apply. */
function sanitizeProposed(raw: ProfileChangeProposed): ProfileChangeProposed {
  const out: ProfileChangeProposed = {};
  if (raw.bankName !== undefined) out.bankName = clean(raw.bankName);
  if (raw.bankAccountNo !== undefined) out.bankAccountNo = clean(raw.bankAccountNo);
  if (raw.taxCategory !== undefined && [1, 2, 3].includes(Number(raw.taxCategory))) {
    out.taxCategory = Number(raw.taxCategory);
  }
  if (raw.numChildren !== undefined && Number.isFinite(Number(raw.numChildren))) {
    out.numChildren = Math.max(0, Math.floor(Number(raw.numChildren)));
  }
  return out;
}

/** The caller's own profile: editable contact fields + a read-only summary of the
 *  pay-affecting statutory fields (the employee sees their own). */
export function myProfile(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    if (!ctx.personId) return null;
    const [p] = await tx
      .select({
        fullName: person.fullName,
        primaryEmail: person.primaryEmail,
        phone: person.phone,
        address: person.address,
        dateOfBirth: person.dateOfBirth,
        gender: person.gender,
        maritalStatus: person.maritalStatus,
        emergencyContactName: person.emergencyContactName,
        emergencyContactPhone: person.emergencyContactPhone,
      })
      .from(person)
      .where(eq(person.id, ctx.personId))
      .limit(1);
    const [stat] = await tx
      .select({
        bankName: employeeStatutoryMy.bankName,
        bankAccountNo: employeeStatutoryMy.bankAccountNo,
        taxCategory: employeeStatutoryMy.taxCategory,
        numChildren: employeeStatutoryMy.numChildren,
      })
      .from(employeeStatutoryMy)
      .where(eq(employeeStatutoryMy.personId, ctx.personId))
      .limit(1);
    return { person: p ?? null, statutory: stat ?? null };
  });
}

/** Direct self-edit of low-risk contact fields on the caller's own person row. */
export async function updateOwnContact(
  ctx: SessionContext,
  p: {
    phone?: string | null;
    address?: string | null;
    dateOfBirth?: string | null;
    gender?: string | null;
    maritalStatus?: string | null;
    emergencyContactName?: string | null;
    emergencyContactPhone?: string | null;
  },
) {
  const personId = ctx.personId;
  if (!personId) throw new Error('This account is not linked to an employee profile.');
  return withTenant(ctx, async (tx) => {
    await tx
      .update(person)
      .set({
        phone: clean(p.phone),
        address: clean(p.address),
        dateOfBirth: clean(p.dateOfBirth),
        gender: oneOf(p.gender, GENDERS),
        maritalStatus: oneOf(p.maritalStatus, MARITAL_STATUSES),
        emergencyContactName: clean(p.emergencyContactName),
        emergencyContactPhone: clean(p.emergencyContactPhone),
      })
      .where(eq(person.id, personId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'person',
      aggregateId: personId,
      eventType: 'person.self-updated',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, personId),
      payload: { fields: Object.keys(p) },
    });
  });
}

/** Propose a change to pay-affecting fields. RLS confines the insert to the caller's own
 *  employment; approval (admin-only) applies it. */
export async function requestProfileChange(
  ctx: SessionContext,
  p: { employmentId: string; proposed: ProfileChangeProposed },
) {
  if (!ctx.personId) throw new Error('This account is not linked to an employee profile.');
  const proposed = sanitizeProposed(p.proposed);
  if (Object.keys(proposed).length === 0) throw new Error('Nothing to change.');
  // A bank change is all-or-nothing: approving an account number against a stale bank name (or
  // vice versa) is exactly the half-update the approval gate exists to prevent.
  if ((proposed.bankName != null) !== (proposed.bankAccountNo != null)) {
    throw new Error('A bank change needs both the bank name and the account number.');
  }
  const personId = ctx.personId;
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(profileChangeRequest)
      .values({ tenantId: ctx.tenantId, employmentId: p.employmentId, personId, proposed })
      .returning({ id: profileChangeRequest.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'profile-change',
      aggregateId: row.id,
      eventType: 'profile-change.requested',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // Audit the WHAT, not the values — bank account / dependents are PII and the event log is
      // append-only (PDPA erasure). The values live in profile_change_request.proposed (RLS-scoped,
      // consumed on decide); the apply event likewise records only field names.
      payload: { employmentId: p.employmentId, fields: Object.keys(proposed) },
    });
    return { requestId: row.id };
  });
}

/** Decide a profile change. Admin-only (bank/tax data is not a manager's call) and never
 *  self — approval applies the proposed patch to the statutory profile. */
export async function decideProfileChange(
  ctx: SessionContext,
  p: { requestId: string; decision: 'approved' | 'rejected'; deciderEmploymentId?: string },
) {
  return withTenant(ctx, async (tx) => {
    const [req] = await tx
      .select()
      .from(profileChangeRequest)
      .where(eq(profileChangeRequest.id, p.requestId))
      .limit(1);
    if (!req) throw new Error('profile change request not found (or not visible)');
    if (req.status !== 'pending') throw new Error(`profile change request is already ${req.status}`);

    await assertCanDecide(tx, ctx, req.employmentId, 'profile change'); // bans self
    const roles = ctx.roles ?? [];
    if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
      throw new Error('Only an admin can approve a profile change');
    }

    if (p.decision === 'approved') {
      const proposed = (req.proposed ?? {}) as ProfileChangeProposed;
      const set: Record<string, unknown> = {};
      if (proposed.bankName !== undefined) set.bankName = proposed.bankName;
      if (proposed.bankAccountNo !== undefined) set.bankAccountNo = proposed.bankAccountNo;
      if (proposed.taxCategory !== undefined) set.taxCategory = proposed.taxCategory;
      if (proposed.numChildren !== undefined) set.numChildren = proposed.numChildren;
      if (Object.keys(set).length > 0) {
        const [existing] = await tx
          .select({ id: employeeStatutoryMy.id })
          .from(employeeStatutoryMy)
          .where(eq(employeeStatutoryMy.personId, req.personId))
          .limit(1);
        if (!existing) {
          throw new Error('No statutory profile to apply to — set the employee’s IC first.');
        }
        await tx
          .update(employeeStatutoryMy)
          .set({ ...set, updatedAt: sql`now()` })
          .where(eq(employeeStatutoryMy.id, existing.id));
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'employee-statutory-my',
          aggregateId: existing.id,
          eventType: 'statutory.my.updated',
          actor: actorOf(ctx),
          subjectEmploymentId: req.employmentId,
          payload: { via: 'profile-change', requestId: req.id, fields: Object.keys(set) },
        });
      }
    }

    await tx
      .update(profileChangeRequest)
      .set({
        status: p.decision,
        decidedByEmploymentId: p.deciderEmploymentId ?? null,
        decidedAt: sql`now()`,
      })
      .where(eq(profileChangeRequest.id, req.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'profile-change',
      aggregateId: req.id,
      eventType: `profile-change.${p.decision}`,
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { decision: p.decision, deciderEmploymentId: p.deciderEmploymentId ?? null },
    });
    return { status: p.decision };
  });
}

/** Admin inbox — RLS trims to scope. Recent first. */
export function listProfileChangeRequests(
  ctx: SessionContext,
  opts: { companyIds?: string[]; status?: 'pending' | 'approved' | 'rejected' } = {},
) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: profileChangeRequest.id,
        employmentId: profileChangeRequest.employmentId,
        personId: profileChangeRequest.personId,
        employee: person.fullName,
        proposed: profileChangeRequest.proposed,
        status: profileChangeRequest.status,
        createdAt: profileChangeRequest.createdAt,
      })
      .from(profileChangeRequest)
      .innerJoin(employment, eq(employment.id, profileChangeRequest.employmentId))
      .innerJoin(person, eq(person.id, profileChangeRequest.personId))
      .where(
        and(
          opts.status ? eq(profileChangeRequest.status, opts.status) : undefined,
          opts.companyIds && opts.companyIds.length
            ? inArray(employment.companyId, opts.companyIds)
            : undefined,
        ),
      )
      .orderBy(desc(profileChangeRequest.createdAt))
      .limit(100),
  );
}

/** The caller's own recent profile-change requests (the /me history). */
export function myProfileChangeRequests(ctx: SessionContext, employmentId: string, limit = 5) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: profileChangeRequest.id,
        proposed: profileChangeRequest.proposed,
        status: profileChangeRequest.status,
        createdAt: profileChangeRequest.createdAt,
      })
      .from(profileChangeRequest)
      .where(eq(profileChangeRequest.employmentId, employmentId))
      .orderBy(desc(profileChangeRequest.createdAt))
      .limit(limit),
  );
}
