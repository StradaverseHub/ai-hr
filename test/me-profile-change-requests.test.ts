/**
 * r260 stage two (board item 9583deac) — ASKING FOR A CHANGE, AND WHAT MUST NEVER HAPPEN WHILE IT WAITS.
 *
 * Against a live cluster, because the two things this file exists to prove are database facts and not
 * source shapes:
 *
 *   ── THE SAFETY PROPERTY OF THE WHOLE CHANGE ─────────────────────────────────────────────────────
 *   A pending request MUST NEVER reach the master record without a decision, and a REJECTED one must
 *   never be applied at all. The plan sells the employee a wider set of fields they can ask about; the
 *   only thing that makes that safe is that asking changes nothing. So the master columns are read
 *   byte-for-byte before the request, again while it is pending, and again after it is rejected.
 *
 *   ── AND THE SCOPE IS THE CALLER'S OWN EMPLOYMENT, RESOLVED FROM THE SESSION ──────────────────────
 *   Stage one made `myProfileRecord` take no id. `myProfileChangeRequests` now does the same — it reads
 *   `ctx.personId` and there is no parameter for a client to change. The adversarial cases below are the
 *   strongest form of the question: a colleague's session, asking for the request by its id.
 *
 * Every case names the shipped line it would fail on if that line were reverted; see the round's
 * non-vacuity note.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hireEmployee } from '../core/org';
import {
  ProfileChangeReasonRequiredError,
  decideProfileChange,
  myProfileChangeRequests,
  requestProfileChange,
} from '../core/profile';
import { getStatutoryProfileMY, setStatutoryProfileMY } from '../localization/my/statutory';
import { employeeStatutoryMy, person, profileChangeRequest } from '../db/schema';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

async function hire(name: string) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
}

/** A plain employee principal: linked to a person, holding only the `employee` role. */
async function employeeCtx(personId: string): Promise<SessionContext> {
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { tenantId: b.tenantId, userId, personId, roles: ['employee'] };
}

/** The master columns this round can reach, read as the OWNER (no RLS) so the assertion is about the
 *  stored row and not about what some session is allowed to see. */
async function masterSnapshot(personId: string) {
  const [p] = await owner.db
    .select({
      fullName: person.fullName,
      firstName: person.firstName,
      lastName: person.lastName,
      preferredName: person.preferredName,
      salutation: person.salutation,
      nationality: person.nationality,
      religion: person.religion,
      race: person.race,
      dateOfBirth: person.dateOfBirth,
      gender: person.gender,
      maritalStatus: person.maritalStatus,
    })
    .from(person)
    .where(eq(person.id, personId));
  const [s] = await owner.db
    .select({
      icNumber: employeeStatutoryMy.icNumber,
      oldIcNumber: employeeStatutoryMy.oldIcNumber,
      passportNumber: employeeStatutoryMy.passportNumber,
      passportIssueDate: employeeStatutoryMy.passportIssueDate,
      passportExpiryDate: employeeStatutoryMy.passportExpiryDate,
      passportIssuingCountry: employeeStatutoryMy.passportIssuingCountry,
      bankName: employeeStatutoryMy.bankName,
      bankAccountNo: employeeStatutoryMy.bankAccountNo,
      epfNumber: employeeStatutoryMy.epfNumber,
      socsoNumber: employeeStatutoryMy.socsoNumber,
      taxNumber: employeeStatutoryMy.taxNumber,
      taxCategory: employeeStatutoryMy.taxCategory,
      numChildren: employeeStatutoryMy.numChildren,
    })
    .from(employeeStatutoryMy)
    .where(eq(employeeStatutoryMy.personId, personId));
  return { person: p ?? null, statutory: s ?? null };
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('r260 — a pending request never reaches the master record, and a rejected one never applies', () => {
  it('REJECTING WITH A REASON LEAVES EVERY MASTER COLUMN BYTE-IDENTICAL', async () => {
    /**
     * THE CASE THE ROUND EXISTS FOR. Stage two lets an employee ask to change their NAME, their IC,
     * their passport and their bank account. Every one of those prints on something that pays them or
     * identifies them to a government agency. The property is not "the right value wins" — it is that a
     * value nobody approved is not written AT ALL, and that a refusal writes nothing either.
     *
     * NON-VACUITY: reverting `if (p.decision === 'approved') {` in core/profile.ts (so the write set
     * applies on every decision) fails the `toEqual(before)` below on eight columns at once.
     */
    const a = adminCtx(b);
    const E = await hire('Master');
    await setStatutoryProfileMY(a, {
      personId: E.personId,
      icNumber: '900101010101',
      bankName: 'OldBank',
      bankAccountNo: '111122223333',
      epfNumber: 'EPF-OLD',
      socsoNumber: 'SOC-OLD',
      taxNumber: 'SG-OLD',
    });
    // The passport block is not part of `StatutoryInput` (it has its own HR card), so it is planted
    // directly — the point of this case is that a REFUSED request writes nothing, and a column with a
    // real value before is a stronger witness than a null one.
    await owner.db
      .update(employeeStatutoryMy)
      .set({ passportNumber: 'A1234567', passportIssuingCountry: 'Malaysia' })
      .where(eq(employeeStatutoryMy.personId, E.personId));
    const emp = await employeeCtx(E.personId);

    const before = await masterSnapshot(E.personId);

    const { requestId } = await requestProfileChange(emp, {
      employmentId: E.employmentId,
      proposed: {
        fullName: 'Somebody Else Entirely',
        icNumber: '880202020202',
        passportNumber: 'Z9999999',
        bankName: 'NewBank',
        bankAccountNo: '5566778899',
        epfNumber: 'EPF-NEW',
        socsoNumber: 'SOC-NEW',
        taxNumber: 'SG-NEW',
        nationality: 'Elsewherian',
      },
    });

    // WHILE IT WAITS: nothing has moved.
    expect(await masterSnapshot(E.personId), 'a PENDING request changed the master record').toEqual(before);

    await decideProfileChange(a, {
      requestId,
      decision: 'rejected',
      reason: 'The bank letter you attached is for a different account holder.',
    });

    // AFTER THE REFUSAL: still nothing has moved.
    expect(await masterSnapshot(E.personId), 'a REJECTED request was applied to the master record').toEqual(before);

    // …and the request itself records the refusal and the words.
    const [row] = await owner.db
      .select({ status: profileChangeRequest.status, reason: profileChangeRequest.decisionReason })
      .from(profileChangeRequest)
      .where(eq(profileChangeRequest.id, requestId));
    expect(row.status).toBe('rejected');
    expect(row.reason).toBe('The bank letter you attached is for a different account holder.');
  });

  it('a rejection WITHOUT a reason is refused, and nothing about the request changes', async () => {
    /**
     * NON-VACUITY: removing the `if (p.decision === 'rejected' && reason === null) throw …` line from
     * decideProfileChange makes this case's `rejects.toThrow` fail immediately.
     */
    const a = adminCtx(b);
    const E = await hire('Reasonless');
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101010102', bankAccountNo: '4444' });
    const emp = await employeeCtx(E.personId);
    const { requestId } = await requestProfileChange(emp, {
      employmentId: E.employmentId,
      proposed: { bankName: 'NoBank', bankAccountNo: '0000' },
    });

    await expect(decideProfileChange(a, { requestId, decision: 'rejected' })).rejects.toThrow(
      ProfileChangeReasonRequiredError,
    );
    // Whitespace is not a reason either.
    await expect(
      decideProfileChange(a, { requestId, decision: 'rejected', reason: '   ' }),
    ).rejects.toThrow(ProfileChangeReasonRequiredError);

    // The request is untouched — still waiting, still decidable.
    const [row] = await owner.db
      .select({ status: profileChangeRequest.status, decidedAt: profileChangeRequest.decidedAt })
      .from(profileChangeRequest)
      .where(eq(profileChangeRequest.id, requestId));
    expect(row.status).toBe('pending');
    expect(row.decidedAt).toBeNull();
    // And it can still be rejected properly afterwards.
    await decideProfileChange(a, { requestId, decision: 'rejected', reason: 'Account not in your name.' });
    expect((await getStatutoryProfileMY(a, E.personId))?.bankAccountNo).toBe('4444');
  });

  it('APPROVING applies the widened fields — the ones stage two added, not only the original seven', async () => {
    /**
     * The other half of the safety property: the mechanism must actually work for the new fields, or
     * "widened" would mean "accepted into a queue and dropped on approval". That gap was real before
     * this round — the sanitiser and the applier each carried their own list of names.
     *
     * NON-VACUITY: reverting `setFor('statutory')`/`setFor('person')` in core/profile.ts to the old
     * four-plus-three `if` ladder leaves passportNumber, epfNumber, socsoNumber, taxNumber and fullName
     * unwritten and fails five assertions here.
     */
    const a = adminCtx(b);
    const E = await hire('Widened');
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101010103' });
    const emp = await employeeCtx(E.personId);

    const { requestId } = await requestProfileChange(emp, {
      employmentId: E.employmentId,
      proposed: {
        fullName: 'Widened Binti Abdullah',
        preferredName: 'Wid',
        nationality: 'Malaysian',
        passportNumber: 'K7654321',
        passportExpiryDate: '2032-06-30',
        epfNumber: 'EPF-12345',
        socsoNumber: 'SOC-67890',
        taxNumber: 'SG12345678',
      },
    });
    await decideProfileChange(a, { requestId, decision: 'approved', reason: 'Checked against the passport.' });

    const after = await masterSnapshot(E.personId);
    expect(after.person!.fullName).toBe('Widened Binti Abdullah');
    expect(after.person!.preferredName).toBe('Wid');
    expect(after.person!.nationality).toBe('Malaysian');
    expect(after.statutory!.passportNumber).toBe('K7654321');
    expect(after.statutory!.passportExpiryDate).toBe('2032-06-30');
    expect(after.statutory!.epfNumber).toBe('EPF-12345');
    expect(after.statutory!.socsoNumber).toBe('SOC-67890');
    expect(after.statutory!.taxNumber).toBe('SG12345678');
    // The IC was not part of the bundle, so approving must not have touched it.
    expect(after.statutory!.icNumber).toBe('900101010103');
    // An approval may carry a note, and the employee is shown it.
    const [row] = await owner.db
      .select({ reason: profileChangeRequest.decisionReason })
      .from(profileChangeRequest)
      .where(eq(profileChangeRequest.id, requestId));
    expect(row.reason).toBe('Checked against the passport.');
  });

  it('a proposal cannot smuggle a field the declaration does not carry', async () => {
    // `sanitizeProposed` keeps only declared keys. A form (or a hand-rolled POST) naming a column that
    // is NOT requestable — an internal HR judgement, say — must reach neither the stored proposal nor
    // the master row.
    const a = adminCtx(b);
    const E = await hire('Smuggler');
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101010104' });
    const emp = await employeeCtx(E.personId);
    const { requestId } = await requestProfileChange(emp, {
      employmentId: E.employmentId,
      // `isResident` and `employerBearsTax` are real columns on employee_statutory_my and are NOT on the
      // declaration; `blacklistReason` is not even on this table.
      proposed: {
        preferredName: 'Legit',
        isResident: false,
        employerBearsTax: true,
        blacklistReason: 'nice try',
      } as never,
    });
    const [stored] = await owner.db
      .select({ proposed: profileChangeRequest.proposed })
      .from(profileChangeRequest)
      .where(eq(profileChangeRequest.id, requestId));
    expect(Object.keys(stored.proposed as Record<string, unknown>).sort()).toEqual(['preferredName']);

    await decideProfileChange(a, { requestId, decision: 'approved' });
    const [row] = await owner.db
      .select({ isResident: employeeStatutoryMy.isResident, employerBearsTax: employeeStatutoryMy.employerBearsTax })
      .from(employeeStatutoryMy)
      .where(eq(employeeStatutoryMy.personId, E.personId));
    expect(row.isResident).toBe(true);
    expect(row.employerBearsTax).toBe(false);
  });

  it('an approval that would duplicate another employee’s IC is refused in words, not by a raw constraint', async () => {
    // employee_statutory_my_ic_uq is a partial unique index per tenant. Without the pre-check the
    // approver would meet a Postgres violation string in a redirect's query parameter.
    const a = adminCtx(b);
    const A = await hire('Holder');
    const B2 = await hire('Copier');
    await setStatutoryProfileMY(a, { personId: A.personId, icNumber: '900101010105' });
    await setStatutoryProfileMY(a, { personId: B2.personId, icNumber: '900101010106' });
    const emp = await employeeCtx(B2.personId);
    const { requestId } = await requestProfileChange(emp, {
      employmentId: B2.employmentId,
      proposed: { icNumber: '900101010105' },
    });
    await expect(decideProfileChange(a, { requestId, decision: 'approved' })).rejects.toThrow(
      /already filed against another employee/i,
    );
    // …and the refusal left both master rows alone.
    expect((await getStatutoryProfileMY(a, B2.personId))?.icNumber).toBe('900101010106');
    expect((await getStatutoryProfileMY(a, A.personId))?.icNumber).toBe('900101010105');
  });
});

describe('r260 — an employee sees and decides only their OWN requests', () => {
  it('myProfileChangeRequests takes NO id, and returns only the caller’s own', async () => {
    /**
     * NON-VACUITY: changing the `where` in myProfileChangeRequests from
     * `eq(profileChangeRequest.personId, personId)` to a bare `limit` (i.e. dropping the session scope)
     * still passes under RLS for a plain employee — so the second half of this case creates the
     * request under an ADMIN session too, where RLS would NOT refuse it, which is what makes the
     * service-level scope load-bearing rather than decorative.
     */
    const a = adminCtx(b);
    const mine = await hire('Selfrequester');
    const colleague = await hire('Colleague');
    await setStatutoryProfileMY(a, { personId: mine.personId, icNumber: '900101010107' });
    await setStatutoryProfileMY(a, { personId: colleague.personId, icNumber: '900101010108' });

    const meCtx = await employeeCtx(mine.personId);
    const themCtx = await employeeCtx(colleague.personId);

    await requestProfileChange(meCtx, { employmentId: mine.employmentId, proposed: { preferredName: 'Mine' } });
    await requestProfileChange(themCtx, { employmentId: colleague.employmentId, proposed: { preferredName: 'Theirs' } });

    const minesList = await myProfileChangeRequests(meCtx);
    expect(minesList).toHaveLength(1);
    expect((minesList[0].proposed as Record<string, unknown>).preferredName).toBe('Mine');

    // The colleague's own list is likewise only theirs.
    const theirsList = await myProfileChangeRequests(themCtx);
    expect(theirsList).toHaveLength(1);
    expect((theirsList[0].proposed as Record<string, unknown>).preferredName).toBe('Theirs');

    // An ADMIN calling it gets their OWN (none) — not the whole tenant's. The admin can see every row
    // through RLS, so this is the service's session scope answering, not the database.
    expect(await myProfileChangeRequests(a)).toEqual([]);
  });

  it('an employee cannot decide their colleague’s request — nor their own', async () => {
    const a = adminCtx(b);
    const mine = await hire('Decider');
    const colleague = await hire('Subject');
    await setStatutoryProfileMY(a, { personId: colleague.personId, icNumber: '900101010109' });
    const meCtx = await employeeCtx(mine.personId);
    const themCtx = await employeeCtx(colleague.personId);

    const { requestId } = await requestProfileChange(themCtx, {
      employmentId: colleague.employmentId,
      proposed: { bankName: 'TheirBank', bankAccountNo: '9999' },
    });

    // A colleague, by id. RLS refuses them the row, so the service cannot even find it.
    await expect(
      decideProfileChange(meCtx, { requestId, decision: 'approved' }),
    ).rejects.toThrow(/not found|not visible|only an admin|cannot decide/i);
    // The subject cannot approve their own, with or without a reason.
    await expect(
      decideProfileChange(themCtx, { requestId, decision: 'approved' }),
    ).rejects.toThrow(/cannot decide your own|only an admin/i);
    await expect(
      decideProfileChange(themCtx, { requestId, decision: 'rejected', reason: 'let me out of it' }),
    ).rejects.toThrow(/cannot decide your own|only an admin/i);

    // Still pending, and the bank account still untouched.
    const [row] = await owner.db
      .select({ status: profileChangeRequest.status })
      .from(profileChangeRequest)
      .where(eq(profileChangeRequest.id, requestId));
    expect(row.status).toBe('pending');
  });

  it('the rejection reason reaches the employee who asked, and nobody else’s does', async () => {
    const a = adminCtx(b);
    const mine = await hire('Reader');
    const colleague = await hire('Other');
    await setStatutoryProfileMY(a, { personId: mine.personId, icNumber: '900101010110' });
    await setStatutoryProfileMY(a, { personId: colleague.personId, icNumber: '900101010111' });
    const meCtx = await employeeCtx(mine.personId);
    const themCtx = await employeeCtx(colleague.personId);

    const r1 = await requestProfileChange(meCtx, {
      employmentId: mine.employmentId,
      proposed: { bankName: 'MyBank', bankAccountNo: '1111' },
    });
    const r2 = await requestProfileChange(themCtx, {
      employmentId: colleague.employmentId,
      proposed: { bankName: 'TheirBank', bankAccountNo: '2222' },
    });
    await decideProfileChange(a, { requestId: r1.requestId, decision: 'rejected', reason: 'Send the bank statement.' });
    await decideProfileChange(a, { requestId: r2.requestId, decision: 'rejected', reason: 'A private matter of theirs.' });

    const mineRows = await myProfileChangeRequests(meCtx);
    expect(mineRows).toHaveLength(1);
    expect(mineRows[0].status).toBe('rejected');
    expect(mineRows[0].decisionReason).toBe('Send the bank statement.');
    expect(mineRows[0].decidedAt).not.toBeNull();
    // The colleague's reason is not reachable from this session, in any row.
    expect(JSON.stringify(mineRows)).not.toContain('A private matter of theirs.');
  });

  it('the status of every one of their own requests is visible: waiting, approved and rejected', async () => {
    // The plan's fourth promise. Three requests, three outcomes, all three readable by the employee.
    const a = adminCtx(b);
    const E = await hire('Historian');
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101010112' });
    const emp = await employeeCtx(E.personId);

    const approved = await requestProfileChange(emp, { employmentId: E.employmentId, proposed: { preferredName: 'Yes' } });
    await decideProfileChange(a, { requestId: approved.requestId, decision: 'approved' });
    const rejected = await requestProfileChange(emp, { employmentId: E.employmentId, proposed: { preferredName: 'No' } });
    await decideProfileChange(a, { requestId: rejected.requestId, decision: 'rejected', reason: 'Use your legal name.' });
    await requestProfileChange(emp, { employmentId: E.employmentId, proposed: { preferredName: 'Maybe' } });

    const rows = await myProfileChangeRequests(emp);
    expect(rows.map((r) => r.status).sort()).toEqual(['approved', 'pending', 'rejected']);
    expect(rows.find((r) => r.status === 'rejected')!.decisionReason).toBe('Use your legal name.');
    expect(rows.find((r) => r.status === 'pending')!.decisionReason).toBeNull();
  });
});
