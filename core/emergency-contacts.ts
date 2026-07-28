/**
 * Personnel — Emergency contacts (feedback 23ad620e). A per-PERSON register of who to call in an emergency:
 * name, relationship, mobile phone, home phone, address, remark and a priority. Replaces the five flat
 * person.emergency_contact_* columns, which could only ever hold ONE contact — an employee could not record
 * a spouse AND a parent, and HR had nobody to try second.
 *
 * KEYING — personId, mirroring employee_dependent: an emergency contact is a PERSON fact, so keying it on one
 * employment would orphan it on termination and hide it from a second company's admin.
 *
 * PRIORITY — 'primary' | 'secondary' | 'other', the request's own vocabulary. At most ONE live 'primary' per
 * person: promoting a record DEMOTES the previous primary to 'secondary' in the same transaction (the
 * request's rule 4), and the partial unique index person_emergency_contact_one_primary_uq is the DB-level
 * backstop that makes a concurrent double-primary structurally impossible.
 *
 * RELATIONSHIP — catalog-backed with legacy tolerance against the profile_option 'relationship' category
 * (System Settings > System Labels > Profile Options), the SAME catalog the replaced person column used —
 * deliberately NOT the separate 'dependentRelationship' category the Family tab uses (core/dependents.ts
 * spells out why the two must not be conflated).
 *
 * SINGLE-CONTACT READERS — the screens that show "the" emergency contact (core/read.ts employeeDetail,
 * core/profile.ts myProfile, and hence /me) resolve through primaryEmergencyContactSql below: the live
 * 'primary' row, falling back to the next priority and then the oldest record. So every existing surface
 * keeps working while the fuller list lives on the Personnel (Admin) profile.
 *
 * Substrate discipline (ADR-0006 / ADR-0030 Layer 0): every write appends a DomainEvent whose payload carries
 * field NAMES + the priority only — never the contact's name, phone or address (that PII lives on the
 * RLS-protected row and must stay reachable by PDPA erasure, which the append-only event log is not).
 */
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent, subjectEmploymentForPerson } from '../db/events';
import { personEmergencyContact } from '../db/schema';
import { assertProfileValueAllowed } from './profile-options';

/** The three priorities the request enumerates. Order matters: it IS the display / resolution order. */
export const EMERGENCY_CONTACT_PRIORITIES = ['primary', 'secondary', 'other'] as const;
export type EmergencyContactPriority = (typeof EMERGENCY_CONTACT_PRIORITIES)[number];

export class EmergencyContactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmergencyContactValidationError';
  }
}

export type EmergencyContactRow = {
  id: string;
  personId: string;
  fullName: string;
  relationship: string | null;
  mobilePhone: string | null;
  homePhone: string | null;
  address: string | null;
  remarks: string | null;
  priority: string;
  archivedAt: Date | null;
};

/** The five fields the single-contact readers still project, resolved from the highest-priority record. */
export type PrimaryEmergencyContact = {
  emergencyContactName: string | null;
  emergencyContactRelationship: string | null;
  emergencyContactPhone: string | null;
  emergencyContactPhone2: string | null;
  emergencyContactAddress: string | null;
};

function trimOrNull(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
}

function normPriority(v: string | null | undefined): EmergencyContactPriority {
  const s = (v ?? '').trim();
  if ((EMERGENCY_CONTACT_PRIORITIES as readonly string[]).includes(s)) return s as EmergencyContactPriority;
  if (s === '') return 'other';
  throw new EmergencyContactValidationError('Priority must be Primary, Secondary or Other.');
}

/**
 * The SQL ordering that defines "the" emergency contact: primary first, then secondary, then other, oldest
 * first within a priority. Written as an explicit rank rather than an alphabetical sort on the text column —
 * 'other' < 'primary' < 'secondary' alphabetically, which is exactly wrong.
 */
const PRIORITY_RANK = sql`case ${personEmergencyContact.priority} when 'primary' then 0 when 'secondary' then 1 else 2 end`;

/**
 * A correlated sub-select projecting ONE field of a person's highest-priority live emergency contact, for the
 * readers that still show a single contact (employeeDetail / myProfile). Drops into an existing select list
 * with no join.
 *
 * The outer reference is written out as the LITERAL `"person"."id"` rather than interpolating the drizzle
 * column: in a single-table select drizzle renders `person.id` UNQUALIFIED, and a bare `"id"` inside this
 * sub-select binds to the INNER table (`ec.id`), silently comparing a contact's id to its person_id and
 * matching nothing. So the caller must have the unaliased `person` table in scope — both call sites do, and
 * test/emergency-contacts.test.ts pins each of them returning the primary contact.
 */
export function primaryEmergencyContactSql(
  column: 'full_name' | 'relationship' | 'mobile_phone' | 'home_phone' | 'address',
) {
  return sql<string | null>`(
    select ec.${sql.raw(column)} from person_emergency_contact ec
    where ec.person_id = "person"."id" and ec.archived_at is null
    order by case ec.priority when 'primary' then 0 when 'secondary' then 1 else 2 end, ec.created_at, ec.id
    limit 1
  )`;
}

/**
 * Active (non-archived) emergency contacts for a person, in resolution order (Primary → Secondary → Other,
 * oldest first within a priority). RLS scopes it (can_see_person), so a viewer who cannot see the person gets
 * an empty list rather than a leak.
 */
export function listEmergencyContacts(
  ctx: SessionContext,
  p: { personId: string },
): Promise<EmergencyContactRow[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: personEmergencyContact.id,
        personId: personEmergencyContact.personId,
        fullName: personEmergencyContact.fullName,
        relationship: personEmergencyContact.relationship,
        mobilePhone: personEmergencyContact.mobilePhone,
        homePhone: personEmergencyContact.homePhone,
        address: personEmergencyContact.address,
        remarks: personEmergencyContact.remarks,
        priority: personEmergencyContact.priority,
        archivedAt: personEmergencyContact.archivedAt,
      })
      .from(personEmergencyContact)
      .where(
        and(
          eq(personEmergencyContact.personId, p.personId),
          isNull(personEmergencyContact.archivedAt),
        ),
      )
      .orderBy(PRIORITY_RANK, asc(personEmergencyContact.createdAt), asc(personEmergencyContact.id)),
  );
}

/**
 * Demote the person's current live primary (all rows except `exceptId`) to 'secondary' — the request's rule 4,
 * run inside the caller's transaction so the partial unique index never trips on the happy path. Returns the
 * demoted row id (null when there was none) so the caller's event can record the transfer.
 */
async function demoteCurrentPrimary(tx: Tx, personId: string, exceptId: string | null): Promise<string | null> {
  const demoted = await tx
    .update(personEmergencyContact)
    .set({ priority: 'secondary', updatedAt: new Date() })
    .where(
      and(
        eq(personEmergencyContact.personId, personId),
        eq(personEmergencyContact.priority, 'primary'),
        isNull(personEmergencyContact.archivedAt),
        ...(exceptId ? [ne(personEmergencyContact.id, exceptId)] : []),
      ),
    )
    .returning({ id: personEmergencyContact.id });
  return demoted[0]?.id ?? null;
}

/** The stored relationship of a person's live contacts — the legacy values a catalog check must tolerate. */
async function storedRelationships(tx: Tx, personId: string): Promise<(string | null)[]> {
  const rows = await tx
    .select({ relationship: personEmergencyContact.relationship })
    .from(personEmergencyContact)
    .where(and(eq(personEmergencyContact.personId, personId), isNull(personEmergencyContact.archivedAt)));
  return rows.map((r) => r.relationship);
}

export type EmergencyContactInput = {
  fullName: string;
  relationship?: string | null;
  mobilePhone?: string | null;
  homePhone?: string | null;
  address?: string | null;
  remarks?: string | null;
  priority?: string | null;
};

/**
 * Add an emergency contact. Name is the only mandatory field (a contact with no name is not a contact);
 * everything else is optional, exactly as the replaced single form was. Choosing Primary demotes the previous
 * primary to Secondary in the same transaction. Appends `emergency-contact.added`.
 */
export async function addEmergencyContact(
  ctx: SessionContext,
  p: { personId: string } & EmergencyContactInput,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const fullName = trimOrNull(p.fullName);
    if (fullName === null) throw new EmergencyContactValidationError('Contact name is required.');
    const priority = normPriority(p.priority);
    const relationship = trimOrNull(p.relationship);
    // A NEW pick must be an active 'relationship' option — unless the value is already stored on one of this
    // person's contacts (the tolerance that keeps a deactivated/renamed option re-savable).
    if (relationship !== null && !(await storedRelationships(tx, p.personId)).includes(relationship)) {
      await assertProfileValueAllowed(tx, 'relationship', relationship, null);
    }
    const demotedId = priority === 'primary' ? await demoteCurrentPrimary(tx, p.personId, null) : null;
    const [row] = await tx
      .insert(personEmergencyContact)
      .values({
        tenantId: ctx.tenantId,
        personId: p.personId,
        fullName,
        relationship,
        mobilePhone: trimOrNull(p.mobilePhone),
        homePhone: trimOrNull(p.homePhone),
        address: trimOrNull(p.address),
        remarks: trimOrNull(p.remarks),
        priority,
      })
      .returning({ id: personEmergencyContact.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'person-emergency-contact',
      aggregateId: row.id,
      eventType: 'emergency-contact.added',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, p.personId),
      // Priority + relationship only — the name / phones / address are PII and stay on the row.
      payload: { priority, relationship, ...(demotedId ? { demotedId } : {}) },
    });
    return { id: row.id };
  });
}

async function loadContact(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      id: personEmergencyContact.id,
      personId: personEmergencyContact.personId,
      relationship: personEmergencyContact.relationship,
      priority: personEmergencyContact.priority,
      archivedAt: personEmergencyContact.archivedAt,
    })
    .from(personEmergencyContact)
    .where(eq(personEmergencyContact.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Edit one emergency contact WITHOUT touching the others (the request's rule 6). Patch semantics: only the
 * fields the caller passes change. Promoting to Primary demotes the previous holder in the same transaction.
 * Appends `emergency-contact.updated` with field NAMES only.
 */
export async function updateEmergencyContact(
  ctx: SessionContext,
  p: { id: string } & Partial<EmergencyContactInput>,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const existing = await loadContact(tx, p.id);
    if (!existing || existing.archivedAt != null) {
      throw new EmergencyContactValidationError('Emergency contact not found.');
    }
    const patch: Record<string, unknown> = {};
    if (p.fullName !== undefined) {
      const fullName = trimOrNull(p.fullName);
      if (fullName === null) throw new EmergencyContactValidationError('Contact name is required.');
      patch.fullName = fullName;
    }
    if (p.relationship !== undefined) {
      const relationship = trimOrNull(p.relationship);
      // Unchanged value always re-saves; a changed one must be an active option (or already in use here).
      if (
        relationship !== null &&
        relationship !== existing.relationship &&
        !(await storedRelationships(tx, existing.personId)).includes(relationship)
      ) {
        await assertProfileValueAllowed(tx, 'relationship', relationship, null);
      }
      patch.relationship = relationship;
    }
    if (p.mobilePhone !== undefined) patch.mobilePhone = trimOrNull(p.mobilePhone);
    if (p.homePhone !== undefined) patch.homePhone = trimOrNull(p.homePhone);
    if (p.address !== undefined) patch.address = trimOrNull(p.address);
    if (p.remarks !== undefined) patch.remarks = trimOrNull(p.remarks);

    let demotedId: string | null = null;
    if (p.priority !== undefined) {
      const priority = normPriority(p.priority);
      if (priority === 'primary' && existing.priority !== 'primary') {
        demotedId = await demoteCurrentPrimary(tx, existing.personId, p.id);
      }
      patch.priority = priority;
    }

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = new Date();
      await tx.update(personEmergencyContact).set(patch).where(eq(personEmergencyContact.id, p.id));
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'person-emergency-contact',
      aggregateId: p.id,
      eventType: 'emergency-contact.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, existing.personId),
      payload: {
        diff: Object.keys(patch).filter((k) => k !== 'updatedAt'),
        ...(patch.priority ? { priority: patch.priority } : {}),
        ...(demotedId ? { demotedId } : {}),
      },
    });
    return { id: p.id };
  });
}

/**
 * Soft-delete one emergency contact (rule 6: without affecting the others) — archived_at, so the audit stays
 * reconcilable. Removing the primary does NOT auto-elect a successor: the next-priority record simply becomes
 * the one the single-contact readers resolve to, and HR decides who is Primary. Appends
 * `emergency-contact.archived`.
 */
export async function archiveEmergencyContact(
  ctx: SessionContext,
  p: { id: string },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const existing = await loadContact(tx, p.id);
    if (!existing || existing.archivedAt != null) {
      throw new EmergencyContactValidationError('Emergency contact not found.');
    }
    await tx
      .update(personEmergencyContact)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(personEmergencyContact.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'person-emergency-contact',
      aggregateId: p.id,
      eventType: 'emergency-contact.archived',
      actor: actorOf(ctx),
      subjectEmploymentId: await subjectEmploymentForPerson(tx, ctx.tenantId, existing.personId),
      payload: { priority: existing.priority },
    });
    return { id: p.id };
  });
}

/**
 * Write the person's single emergency contact through the register — the compatibility path for the callers
 * that still speak the five flat field names (admin updatePerson, /me self-service updateMyProfile). Patches
 * the highest-priority live record, or creates one as Primary when the register is empty.
 *
 * Presence semantics are preserved EXACTLY: a key the caller omits is left unchanged, so a sibling form that
 * does not carry the emergency block can never clobber it. Called INSIDE the caller's transaction so the
 * profile save and the contact stay atomic.
 */
export async function writeSingleEmergencyContactInTx(
  tx: Tx,
  ctx: SessionContext,
  personId: string,
  p: Partial<PrimaryEmergencyContact>,
): Promise<{ id: string; created: boolean } | null> {
  const touched = (Object.keys(p) as (keyof PrimaryEmergencyContact)[]).filter((k) => p[k] !== undefined);
  if (touched.length === 0) return null;

  const [current] = await tx
    .select({
      id: personEmergencyContact.id,
      fullName: personEmergencyContact.fullName,
      relationship: personEmergencyContact.relationship,
      mobilePhone: personEmergencyContact.mobilePhone,
      homePhone: personEmergencyContact.homePhone,
      address: personEmergencyContact.address,
    })
    .from(personEmergencyContact)
    .where(and(eq(personEmergencyContact.personId, personId), isNull(personEmergencyContact.archivedAt)))
    .orderBy(PRIORITY_RANK, asc(personEmergencyContact.createdAt), asc(personEmergencyContact.id))
    .limit(1);

  const relationship = p.emergencyContactRelationship;
  if (relationship !== undefined) {
    await assertProfileValueAllowed(
      tx,
      'relationship',
      trimOrNull(relationship),
      current?.relationship ?? null,
    );
  }

  if (!current) {
    // Nothing recorded yet. A save that only CLEARS fields must not conjure an empty contact row.
    const values = {
      fullName: trimOrNull(p.emergencyContactName),
      relationship: trimOrNull(p.emergencyContactRelationship),
      mobilePhone: trimOrNull(p.emergencyContactPhone),
      homePhone: trimOrNull(p.emergencyContactPhone2),
      address: trimOrNull(p.emergencyContactAddress),
    };
    if (Object.values(values).every((v) => v === null)) return null;
    const [row] = await tx
      .insert(personEmergencyContact)
      .values({
        tenantId: ctx.tenantId,
        personId,
        // full_name is NOT NULL: a caller that supplied only a phone number still gets a usable record
        // rather than a failed save (the same placeholder the 0319 backfill uses).
        fullName: values.fullName ?? 'Emergency contact',
        relationship: values.relationship,
        mobilePhone: values.mobilePhone,
        homePhone: values.homePhone,
        address: values.address,
        priority: 'primary',
      })
      .returning({ id: personEmergencyContact.id });
    return { id: row.id, created: true };
  }

  // Effective values = the caller's patch merged over what is stored, so the all-blank check below sees the
  // record as it will actually be, not just the keys this save happened to carry.
  const effective = {
    fullName: p.emergencyContactName !== undefined ? trimOrNull(p.emergencyContactName) : current.fullName,
    relationship:
      p.emergencyContactRelationship !== undefined
        ? trimOrNull(p.emergencyContactRelationship)
        : current.relationship,
    mobilePhone: p.emergencyContactPhone !== undefined ? trimOrNull(p.emergencyContactPhone) : current.mobilePhone,
    homePhone: p.emergencyContactPhone2 !== undefined ? trimOrNull(p.emergencyContactPhone2) : current.homePhone,
    address: p.emergencyContactAddress !== undefined ? trimOrNull(p.emergencyContactAddress) : current.address,
  };
  // Emptying every field through the single-contact form MEANS "I no longer have an emergency contact" —
  // archive rather than leaving a nameless ghost record in the register.
  if (Object.values(effective).every((v) => v === null)) {
    await tx
      .update(personEmergencyContact)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(personEmergencyContact.id, current.id));
    return { id: current.id, created: false };
  }
  await tx
    .update(personEmergencyContact)
    // full_name is NOT NULL: a save that keeps a phone but drops the name falls back to the placeholder.
    .set({ ...effective, fullName: effective.fullName ?? 'Emergency contact', updatedAt: new Date() })
    .where(eq(personEmergencyContact.id, current.id));
  return { id: current.id, created: false };
}
