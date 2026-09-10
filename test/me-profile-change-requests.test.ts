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
import { erasePersonPii } from '../core/pdpa';
import { getStatutoryProfileMY, setStatutoryProfileMY } from '../localization/my/statutory';
import { employeeStatutoryMy, person, profileChangeRequest } from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
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

/**
 * A plain employee principal: linked to a person, holding only the `employee` role.
 *
 * ⚠️ SPREAD FROM `adminCtx` FOR THE ENTITLEMENT SNAPSHOT, and the roles/user/person are then overridden.
 * r261 made `requestProfileChange` read the tenant's own field-permission setting, and a setting is read
 * from the snapshot a real session carries. A hand-built context with no snapshot is not a lighter
 * fixture — it is a principal the application could never produce, and `getSetting` refuses it loudly
 * (EntitlementsUnresolvedError) rather than guessing. This is the same correction test/harness.ts records
 * for `adminCtx` itself when the exemption marker was removed.
 */
async function employeeCtx(personId: string): Promise<SessionContext> {
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ...adminCtx(b), userId, personId, roles: ['employee'] };
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
  // erasePersonPii crypto-shreds the subject's vault, which needs the master passphrase.
  process.env.AI_CONFIG_SECRET = 'test-pii-master-passphrase-0123456789';
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  delete process.env.AI_CONFIG_SECRET;
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

    /**
     * EACH LAYER IS ASSERTED SEPARATELY, BECAUSE AN ALTERNATION CANNOT SEE ONE OF THEM FAIL.
     *
     * This case used to assert `/not found|not visible|only an admin|cannot decide/i` over one call —
     * four different refusals from three different layers, any one of which satisfied it. Deleting the
     * RLS policy on this table would have left it green, and its own docstring ("RLS refuses them the
     * row") would have gone on claiming a layer that no longer refused anything. So: the DATABASE is
     * asked directly whether the colleague can see the row, and then the SERVICE is held to one exact
     * message per caller.
     */
    // (a) RLS: under the colleague's own session the row does not exist at all.
    const visibleToColleague = await withTenant(meCtx, (tx) =>
      tx
        .select({ id: profileChangeRequest.id })
        .from(profileChangeRequest)
        .where(eq(profileChangeRequest.id, requestId)),
    );
    expect(visibleToColleague, 'a colleague can SELECT another employee’s profile-change row').toEqual([]);

    // (b) …so the service cannot find it. Exact message, not an alternation.
    await expect(decideProfileChange(meCtx, { requestId, decision: 'approved' })).rejects.toThrow(
      'profile change request not found (or not visible)',
    );

    // (c) The subject CAN see their own row — so this refusal is the self-decision ban doing the work,
    //     which is a different layer again, and it must not be satisfiable by (a) or (b).
    const visibleToSubject = await withTenant(themCtx, (tx) =>
      tx
        .select({ id: profileChangeRequest.id })
        .from(profileChangeRequest)
        .where(eq(profileChangeRequest.id, requestId)),
    );
    expect(visibleToSubject.map((r) => r.id), 'the subject cannot see their own request').toEqual([requestId]);
    for (const decision of ['approved', 'rejected'] as const) {
      await expect(
        decideProfileChange(themCtx, {
          requestId,
          decision,
          // A reason is supplied on the rejection so it is refused for WHO is asking, not for what is
          // missing — ProfileChangeReasonRequiredError would otherwise mask the self-decision ban.
          reason: decision === 'rejected' ? 'let me out of it' : undefined,
        }),
        `a subject decided their OWN request (${decision})`,
      ).rejects.toThrow(/cannot decide your own/i);
    }

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

/**
 * ── THE CASE THE FIRST DRAFT OF THIS ROUND DID NOT HAVE, AND SHIPPED A PDPA OUTAGE THROUGH ─────────
 *
 * Migration 0458 originally carried
 *   CHECK (status <> 'rejected' OR btrim(decision_reason) <> '') NOT VALID
 * with a header arguing it was safe because "decideProfileChange refuses to re-decide a settled request,
 * so no historical row is ever updated back through this constraint". That enumerated the callers its
 * author had in mind and missed the second writer of the table: `core/pdpa.ts` erasePersonPii updates
 * EVERY one of the subject's profile-change rows — no status filter — inside the ONE transaction the
 * whole erasure runs in. NOT VALID skips the historical SCAN; it does not skip the row you UPDATE. So a
 * rejection made before 0458 (with no reason, exactly as 0458 deliberately leaves it) would have made
 * that employee's erasure abort and erase NOTHING — a statutory obligation with a deadline, defeated by
 * a wording rule.
 *
 * No test could see it: the suite migrates every database fresh, so a legacy reasonless rejection cannot
 * exist unless a test PLANTS one. This one plants it, as the owner (bypassing the service that would
 * refuse to create it), which is precisely the row a deployed database can be holding today.
 */
describe('r260 — a PDPA erasure survives a legacy rejection that has no reason', () => {
  it('erases the subject, redacts the request, and NULLs the approver’s sentence', async () => {
    const a = adminCtx(b);
    const E = await hire('Erasable');
    await setStatutoryProfileMY(a, {
      personId: E.personId,
      icNumber: '900101010113',
      bankName: 'OldBank',
      bankAccountNo: '444455556666',
    });
    const emp = await employeeCtx(E.personId);

    // (1) THE LEGACY ROW: rejected, with NO reason. Planted as the owner because the service refuses to
    // create one — which is the whole point: it is a row from BEFORE the rule existed.
    const legacy = await requestProfileChange(emp, {
      employmentId: E.employmentId,
      proposed: { bankName: 'NewBank', bankAccountNo: '777788889999' },
    });
    await owner.db
      .update(profileChangeRequest)
      .set({ status: 'rejected', decisionReason: null, decidedAt: new Date() })
      .where(eq(profileChangeRequest.id, legacy.requestId));

    // (2) A MODERN rejection alongside it, carrying the approver's free text ABOUT this employee. It has
    // to be erased too: core/profile.ts keeps the sentence out of the append-only event log on the
    // stated promise that it "is RLS-scoped and erasable with the record".
    const modern = await requestProfileChange(emp, {
      employmentId: E.employmentId,
      proposed: { preferredName: 'Nickname' },
    });
    await decideProfileChange(a, {
      requestId: modern.requestId,
      decision: 'rejected',
      reason: 'The bank letter you attached is for a different account holder.',
    });

    // (3) THE ERASURE. Before the fix this REJECTED with
    // `new row for relation "profile_change_request" violates check constraint
    //  "profile_change_request_reject_reason_ck"` and nothing at all was erased.
    const report = await erasePersonPii(a, {
      subjectEmploymentId: E.employmentId,
      scope: 'all',
      reason: 'subject request',
      requestRef: 'DPO-R260',
    });
    // It really erased — not "did not throw". `phone` is contact scope, erasable while still employed.
    expect(report.erased).toContain('phone');

    const [p] = await owner.db
      .select({ preferredName: person.preferredName, phone: person.phone })
      .from(person)
      .where(eq(person.id, E.personId));
    expect(p.phone).toBeNull();

    // (4) Both requests are redacted, and NEITHER carries an approver's sentence any more.
    const rows = await owner.db
      .select({
        id: profileChangeRequest.id,
        status: profileChangeRequest.status,
        proposed: profileChangeRequest.proposed,
        decisionReason: profileChangeRequest.decisionReason,
      })
      .from(profileChangeRequest)
      .where(eq(profileChangeRequest.personId, E.personId));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.proposed, `request ${r.id} still holds cleartext PII`).toEqual({ redacted: true });
      expect(r.decisionReason, `request ${r.id} still holds the approver’s free text`).toBeNull();
      // The status is NOT rewritten — the history of the decision stays true, only the words go.
      expect(r.status).toBe('rejected');
    }
    // The account number and the sentence are gone from the table, not merely from one column.
    expect(JSON.stringify(rows)).not.toContain('777788889999');
    expect(JSON.stringify(rows)).not.toContain('different account holder');
  });

  it('and the rule the constraint was carrying is still enforced — at the decision', async () => {
    // Removing the CHECK must not have removed the promise to the reporter. The service is the authority
    // and it refuses, before the transaction opens, for every shape of "no reason".
    const a = adminCtx(b);
    const E = await hire('Reasonless');
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101010114' });
    const emp = await employeeCtx(E.personId);

    for (const reason of [undefined, null, '', '   '] as const) {
      const { requestId } = await requestProfileChange(emp, {
        employmentId: E.employmentId,
        proposed: { preferredName: `Try-${String(reason)}` },
      });
      await expect(
        decideProfileChange(a, { requestId, decision: 'rejected', reason }),
        `a rejection with reason=${JSON.stringify(reason)} was accepted`,
      ).rejects.toBeInstanceOf(ProfileChangeReasonRequiredError);
      const [row] = await owner.db
        .select({ status: profileChangeRequest.status, decisionReason: profileChangeRequest.decisionReason })
        .from(profileChangeRequest)
        .where(eq(profileChangeRequest.id, requestId));
      expect(row.status).toBe('pending');
      expect(row.decisionReason).toBeNull();
    }
  });
});
