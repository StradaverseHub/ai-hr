/**
 * 1d58019a — "Movement Settings Enhancement", Step 2 (ADR-0166), against a real database.
 *
 * The properties this suite holds:
 *
 *  1. CUSTOM TERMINATION. One of the organisation's own types may carry the Termination behaviour (owner
 *     sign-off 30 October 2026, amending 476f23ed) and then runs the built-in Termination's writer, its
 *     scheduling and sweep, its correction and its reversal: same employment columns, one history row under
 *     the organisation's own code, and the leaver in the terminations report.
 *  2. A USED TYPE'S BEHAVIOUR IS LOCKED, so history can never be re-read under another behaviour.
 *  3. PER-TYPE REASONS are enforced by the writer, not only offered by the form.
 *  4. FIELD CONTROLS are enforced by the writer for create, correction and import; no rules is today's
 *     behaviour; a rule never re-judges a movement already recorded (the sweep applies it as keyed).
 *  5. SUPPORTING DOCUMENTS are validated, stored with the movement, carried by a correction, and read only
 *     through the authorized reader.
 *  6. The workbook's catalogue fingerprint covers reasons and rules.
 *  7. Admin-only settings, tenant isolation and audit events for every control write.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { createPosition } from '../core/admin';
import { terminations } from '../core/analytics';
import {
  createMovementEvent,
  editMovementEvent,
  movementAttachments,
  movementHistory,
  MovementDocumentError,
  MovementFieldRuleError,
  readMovementAttachment,
  reverseMovementEvent,
} from '../core/movement';
import { sweepDueMovements } from '../core/movement-apply';
import {
  listMovementEventTypes,
  MovementTypeError,
  saveMovementEventType,
} from '../core/movement-type';
import { MovementTypeControlError, movementTypeControls, movementTypeControlsForSettings } from '../core/movement-type-controls';
import { saveTerminationReason } from '../core/termination-reason-catalog';
import { movementImportTypes, previewMovementImport } from '../core/movement-import';
import { movementWorkbookCatalogue } from '../lib/movement-workbook.server';
import { toCsv } from '../lib/csv';
import { todayInKualaLumpur } from '../lib/hr-date';
import type { MovementFieldRule } from '../lib/movement-field-rules';

let b: Base;
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

const email = () => `mtc_${randomUUID().slice(0, 8)}@t.local`;
const employeeCtx = (base: Base): SessionContext => ({ tenantId: base.tenantId, userId: base.adminUserId, roles: ['employee'] });
const plusDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TODAY = todayInKualaLumpur();
const PAST = plusDays(TODAY, -30);
const FUTURE = plusDays(TODAY, 20);
const PDF = Buffer.from('%PDF-1.4\n% fictional supporting document\n');

async function hireOne(base: Base = b, code?: string) {
  return hireEmployee(adminCtx(base), {
    person: { fullName: 'Controls Subject', primaryEmail: email() },
    companyId: base.companyId,
    departmentId: base.deptA,
    positionId: base.positionId,
    costCenterId: base.costCenterId,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
    ...(code ? { employeeCode: code } : {}),
  });
}

const employmentRow = async (id: string) => {
  const [row] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, id));
  return row;
};
const openAssignment = async (id: string) => {
  const [row] = await owner.db
    .select()
    .from(schema.assignment)
    .where(and(eq(schema.assignment.employmentId, id), isNull(schema.assignment.validTo), isNull(schema.assignment.supersededAt)));
  return row;
};
const auditEvents = (tenantId: string, eventType: string) =>
  owner.db
    .select()
    .from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.tenantId, tenantId), eq(schema.domainEvent.eventType, eventType)))
    .orderBy(asc(schema.domainEvent.sequence));

function pgText(e: unknown): string {
  const parts: string[] = [];
  for (let cur = e as Record<string, unknown> | undefined, n = 0; cur && typeof cur === 'object' && n < 5; cur = cur.cause as never, n++) {
    for (const k of ['message', 'detail']) if (typeof cur[k] === 'string') parts.push(cur[k] as string);
  }
  return parts.join(' | ');
}
async function rlsRefused(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal').not.toBeNull();
  expect(pgText(err)).toMatch(/row-level security/i);
}

async function privilegeRefused(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal').not.toBeNull();
  expect(pgText(err)).toMatch(/permission denied/i);
}

const rule = (field: MovementFieldRule['field'], over: Partial<MovementFieldRule> = {}): MovementFieldRule => ({
  field,
  included: true,
  editable: true,
  mustChange: false,
  document: 'none',
  ...over,
});

describe('1d58019a Step 2 — a custom Termination type runs the built-in Termination end to end', () => {
  it('records, reports, corrects and reverses exactly like the built-in, under the organisation’s own code', async () => {
    const { code } = await saveMovementEventType(adminCtx(b), {
      label: 'Retrenchment',
      behaviourKind: 'termination',
      reasonCodes: ['redundancy'],
    });
    expect(code).toBe('retrenchment');
    const row = (await listMovementEventTypes(adminCtx(b))).find((r) => r.code === code)!;
    expect(row).toMatchObject({ behaviourKind: 'termination', builtIn: false });

    const custom = await hireOne();
    const builtIn = await hireOne();

    // The per-type list is enforced by the writer: a reason the type does not offer is refused.
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: custom.employmentId,
        kind: code,
        effectiveDate: PAST,
        endDate: PAST,
        terminationReasonCode: 'misconduct',
      }),
    ).rejects.toThrow(/not offered for this event type/i);

    await createMovementEvent(adminCtx(b), {
      employmentId: custom.employmentId,
      kind: code,
      effectiveDate: PAST,
      endDate: PAST,
      terminationReasonCode: 'redundancy',
      terminationNoticeDays: 30,
      remarks: 'Restructure',
    });
    await createMovementEvent(adminCtx(b), {
      employmentId: builtIn.employmentId,
      kind: 'termination',
      effectiveDate: PAST,
      endDate: PAST,
      terminationReasonCode: 'redundancy',
      terminationNoticeDays: 30,
      remarks: 'Restructure',
    });

    // Identical employment consequences.
    const pick = (r: Awaited<ReturnType<typeof employmentRow>>) => ({
      terminatedOn: r.terminatedOn,
      terminationType: r.terminationType,
      terminationReasonCode: r.terminationReasonCode,
      terminationNoticeDays: r.terminationNoticeDays,
      lastWorkingDate: r.lastWorkingDate,
    });
    const customRow = await employmentRow(custom.employmentId);
    expect(pick(customRow)).toEqual(pick(await employmentRow(builtIn.employmentId)));
    expect(pick(customRow)).toMatchObject({ terminatedOn: PAST, terminationType: 'involuntary', terminationReasonCode: 'redundancy' });
    expect((await openAssignment(custom.employmentId)) ?? null, 'the open assignment was closed').toBeNull();

    // ONE history row, under the organisation's code, correctable like the built-in.
    let hist = await movementHistory(adminCtx(b), custom.employmentId);
    expect(hist.map((r) => r.kind)).toEqual(['hired', code]);
    const exit = hist.find((r) => r.kind === code)!;
    expect(exit).toMatchObject({ status: 'applied', canEdit: true, canReverse: true, endDate: PAST });
    expect(exit.recordedExit?.terminationReasonCode).toEqual({ known: true, value: 'redundancy' });

    // The leaver is in the terminations report with the derived classification.
    const leavers = await terminations(adminCtx(b), undefined, { from: PAST, to: PAST });
    expect(leavers.filter((l) => l.terminationType === 'involuntary')).toHaveLength(2);

    // Correction: the same planner and writer, still the organisation's type.
    const corrected = plusDays(PAST, -5);
    await editMovementEvent(adminCtx(b), {
      employmentId: custom.employmentId,
      movementId: exit.id,
      kind: code,
      effectiveDate: corrected,
      endDate: corrected,
      terminationReasonCode: 'redundancy',
      reason: 'Wrong date keyed',
    });
    expect((await employmentRow(custom.employmentId)).terminatedOn).toBe(corrected);
    hist = await movementHistory(adminCtx(b), custom.employmentId);
    const live = hist.filter((r) => r.kind === code && !r.reversed);
    expect(live.map((r) => r.effectiveDate)).toEqual([corrected]);

    // Reversal: the termination reversal leg restores the active record.
    await reverseMovementEvent(adminCtx(b), { employmentId: custom.employmentId, movementId: live[0].id, reason: 'Wrong employee' });
    const restored = await employmentRow(custom.employmentId);
    expect(restored.terminatedOn).toBeNull();
    expect(restored.terminationReasonCode).toBeNull();
    expect(restored.lastWorkingDate).toBeNull();
    expect(await openAssignment(custom.employmentId)).toBeTruthy();
  });

  it('a future custom termination is pending, blocks a second exit, and the sweep applies it', async () => {
    const { code } = await saveMovementEventType(adminCtx(b), { label: 'Mutual Separation', behaviourKind: 'termination' });
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: code,
      effectiveDate: FUTURE,
      endDate: FUTURE,
      terminationReasonCode: 'other',
    });
    const pending = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === code)!;
    expect(pending.status).toBe('pending');
    expect((await employmentRow(hire.employmentId)).terminatedOn).toBeNull();

    // The pending-termination rule asks the catalogue: the built-in Termination is refused while it waits.
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        kind: 'termination',
        effectiveDate: plusDays(FUTURE, 1),
        endDate: plusDays(FUTURE, 1),
        terminationReasonCode: 'misconduct',
      }),
    ).rejects.toThrow(/termination is already recorded/i);

    const res = await sweepDueMovements(adminCtx(b), { today: FUTURE });
    expect(res.applied).toBe(1);
    expect((await employmentRow(hire.employmentId)).terminatedOn).toBe(FUTURE);
    const hist = await movementHistory(adminCtx(b), hire.employmentId);
    expect(hist.map((r) => r.kind)).toEqual(['hired', code]);
    expect(hist.find((r) => r.kind === code)!.status).toBe('applied');
  });
});

describe('1d58019a Step 2 — a used type’s behaviour is locked', () => {
  it('an unused custom type may be re-pointed; once used, its behaviour and classification cannot change', async () => {
    const { code } = await saveMovementEventType(adminCtx(b), { label: 'Redeployment', behaviourKind: 'transfer' });
    // Unused: re-pointing is allowed (including to Termination, which changes its classification).
    await saveMovementEventType(adminCtx(b), { code, label: 'Redeployment', behaviourKind: 'orgAssignmentChange' });
    expect((await listMovementEventTypes(adminCtx(b))).find((r) => r.code === code)!.behaviourKind).toBe('orgAssignmentChange');

    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), { employmentId: hire.employmentId, kind: code, effectiveDate: PAST, departmentId: b.deptB });

    for (const behaviourKind of ['transfer', 'termination']) {
      await expect(
        saveMovementEventType(adminCtx(b), { code, label: 'Redeployment', behaviourKind }),
      ).rejects.toThrow(/already used by recorded movements/i);
    }
    await expect(
      saveMovementEventType(adminCtx(b), { code, label: 'Redeployment', behaviourKind: 'transfer' }),
    ).rejects.toBeInstanceOf(MovementTypeError);
    // A rename (same behaviour posted) is still a rename.
    await saveMovementEventType(adminCtx(b), { code, label: 'Redeployment (Ops)', behaviourKind: 'orgAssignmentChange' });
    const row = (await listMovementEventTypes(adminCtx(b))).find((r) => r.code === code)!;
    expect(row).toMatchObject({ label: 'Redeployment (Ops)', behaviourKind: 'orgAssignmentChange', inUse: true });
    // History still reads the type it was recorded under.
    expect((await movementHistory(adminCtx(b), hire.employmentId)).map((r) => r.kind)).toEqual(['hired', code]);
  });
});

describe('1d58019a Step 2 — per-type reason lists', () => {
  it('are saved for Termination types only, validated against the tenant catalogue, and audited once per change', async () => {
    const { code: custom } = await saveTerminationReason(adminCtx(b), { label: 'Visa Not Renewed', category: 'other' });
    await saveMovementEventType(adminCtx(b), { code: 'termination', label: 'Termination', reasonCodes: ['misconduct', custom] });
    let controls = await movementTypeControlsForSettings(adminCtx(b), { code: 'termination', behaviourKind: 'termination' });
    expect(controls.reasonCodes).toEqual(['misconduct', custom].sort());

    // Unchanged re-save appends nothing.
    await saveMovementEventType(adminCtx(b), { code: 'termination', label: 'Termination', reasonCodes: [custom, 'misconduct'] });
    expect(await auditEvents(b.tenantId, 'movement-type-reasons.saved')).toHaveLength(1);

    // The built-in Termination now refuses a reason it does not tick, and accepts the custom one it does.
    const hire = await hireOne();
    await expect(
      createMovementEvent(adminCtx(b), { employmentId: hire.employmentId, kind: 'termination', effectiveDate: PAST, endDate: PAST, terminationReasonCode: 'redundancy' }),
    ).rejects.toThrow(/not offered/i);
    await createMovementEvent(adminCtx(b), { employmentId: hire.employmentId, kind: 'termination', effectiveDate: PAST, endDate: PAST, terminationReasonCode: custom });
    expect((await employmentRow(hire.employmentId)).terminationType).toBe('other');

    // None ticked = every active reason again.
    await saveMovementEventType(adminCtx(b), { code: 'termination', label: 'Termination', reasonCodes: [] });
    controls = await movementTypeControlsForSettings(adminCtx(b), { code: 'termination', behaviourKind: 'termination' });
    expect(controls.reasonCodes).toBeNull();
    expect(await auditEvents(b.tenantId, 'movement-type-reasons.saved')).toHaveLength(2);

    await expect(
      saveMovementEventType(adminCtx(b), { code: 'transfer', label: 'Transfer', reasonCodes: ['misconduct'] }),
    ).rejects.toBeInstanceOf(MovementTypeControlError);
    await expect(
      saveMovementEventType(adminCtx(b), { code: 'termination', label: 'Termination', reasonCodes: ['no_such_reason'] }),
    ).rejects.toThrow(/unknown termination reason/i);
  });
});

describe('1d58019a Step 2 — Field Controls are enforced by the writer', () => {
  async function redeployment() {
    const pos = await createPosition(adminCtx(b), { companyId: b.companyId, title: `Ops ${randomUUID().slice(0, 5)}` });
    const { code } = await saveMovementEventType(adminCtx(b), {
      label: 'Redeployment',
      behaviourKind: 'transfer',
      fieldRules: [
        rule('departmentId', { mustChange: true, document: 'required' }),
        rule('positionId', { editable: false }),
        rule('orgDivision', { included: false, editable: false }),
      ],
    });
    return { code, positionId: pos.id };
  }
  const fieldRuleError = async (p: Promise<unknown>, code: string, field: string) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MovementFieldRuleError);
    expect(err).toMatchObject({ code, field });
  };

  it('refuses an excluded field, a non-editable field, an unchanged must-change field and a missing document', async () => {
    const { code, positionId } = await redeployment();
    const hire = await hireOne();
    const base = { employmentId: hire.employmentId, kind: code, effectiveDate: PAST };
    const doc = [{ field: 'departmentId', fileName: 'memo.pdf', mimeType: 'application/pdf', content: PDF }];

    await fieldRuleError(createMovementEvent(adminCtx(b), { ...base, departmentId: b.deptB, orgDivision: 'Fictional Division', documents: doc }), 'field_not_included', 'orgDivision');
    await fieldRuleError(createMovementEvent(adminCtx(b), { ...base, departmentId: b.deptB, positionId, documents: doc }), 'field_not_editable', 'positionId');
    await fieldRuleError(createMovementEvent(adminCtx(b), { ...base, departmentId: b.deptA, documents: doc }), 'field_must_change', 'departmentId');
    await fieldRuleError(createMovementEvent(adminCtx(b), { ...base, departmentId: b.deptB }), 'document_required', 'departmentId');
    await fieldRuleError(
      createMovementEvent(adminCtx(b), { ...base, departmentId: b.deptB, documents: [...doc, { ...doc[0], field: 'positionId' }] }),
      'document_not_enabled',
      'positionId',
    );
    await expect(
      createMovementEvent(adminCtx(b), { ...base, departmentId: b.deptB, documents: [{ ...doc[0], content: Buffer.from('not a pdf') }] }),
    ).rejects.toBeInstanceOf(MovementDocumentError);
    // Nothing above wrote anything.
    expect((await movementHistory(adminCtx(b), hire.employmentId)).map((r) => r.kind)).toEqual(['hired']);
    expect(await owner.db.select().from(schema.movementAttachment)).toHaveLength(0);

    // A compliant movement saves, with its document, readable through the authorized reader.
    await createMovementEvent(adminCtx(b), { ...base, departmentId: b.deptB, documents: doc });
    const mv = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === code)!;
    const docs = await movementAttachments(adminCtx(b), hire.employmentId, mv.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ field: 'departmentId', fileName: 'memo.pdf', mimeType: 'application/pdf', sizeBytes: PDF.length });
    const file = await readMovementAttachment(adminCtx(b), hire.employmentId, docs[0].id);
    expect(Buffer.compare(file.content, PDF)).toBe(0);
  });

  it('a correction meets the rules too, and carries the movement’s documents forward', async () => {
    const { code } = await redeployment();
    const hire = await hireOne();
    const doc = [{ field: 'departmentId', fileName: 'memo.pdf', mimeType: 'application/pdf', content: PDF }];
    await createMovementEvent(adminCtx(b), { employmentId: hire.employmentId, kind: code, effectiveDate: PAST, departmentId: b.deptB, documents: doc });
    const mv = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === code)!;

    // Correcting it into "no department change" breaks Required to Change, so it is refused whole.
    await expect(
      editMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: mv.id, kind: code, effectiveDate: PAST, departmentId: b.deptA, reason: 'Fix' }),
    ).rejects.toBeInstanceOf(MovementFieldRuleError);
    expect((await openAssignment(hire.employmentId)).departmentId, 'the refused correction rolled back whole').toBe(b.deptB);

    // A date correction keeps the department change; the carried document satisfies Required.
    const corrected = plusDays(PAST, -3);
    await editMovementEvent(adminCtx(b), { employmentId: hire.employmentId, movementId: mv.id, kind: code, effectiveDate: corrected, departmentId: b.deptB, reason: 'Wrong date' });
    const live = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === code && !r.reversed)!;
    expect(live.effectiveDate).toBe(corrected);
    expect((await movementAttachments(adminCtx(b), hire.employmentId, live.id)).map((d) => d.fileName)).toEqual(['memo.pdf']);
    // The corrected-away movement keeps its own document as evidence.
    expect(await movementAttachments(adminCtx(b), hire.employmentId, mv.id)).toHaveLength(1);
  });

  it('no rules is today’s behaviour, and a grid left at its defaults stores nothing', async () => {
    const hire = await hireOne();
    // The built-in Transfer has no rules: any comparison field may change, nothing is required.
    await createMovementEvent(adminCtx(b), { employmentId: hire.employmentId, kind: 'transfer', effectiveDate: PAST, departmentId: b.deptB });
    expect((await openAssignment(hire.employmentId)).departmentId).toBe(b.deptB);

    await saveMovementEventType(adminCtx(b), { code: 'transfer', label: 'Transfer', fieldRules: [rule('departmentId'), rule('positionId')] });
    expect(await owner.db.select().from(schema.movementTypeFieldRule)).toHaveLength(0);
    const controls = (await movementTypeControls(adminCtx(b), [{ code: 'transfer', behaviourKind: 'transfer' }])).get('transfer')!;
    expect(controls.configured).toBe(false);
    // Supporting documents need a type that enables them.
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        kind: 'transfer',
        effectiveDate: TODAY,
        departmentId: b.deptA,
        documents: [{ field: 'departmentId', fileName: 'memo.pdf', mimeType: 'application/pdf', content: PDF }],
      }),
    ).rejects.toMatchObject({ code: 'document_not_enabled' });
  });

  it('never re-judges history: a movement keyed before the rule keeps its record and the sweep applies it as keyed', async () => {
    const { code } = await saveMovementEventType(adminCtx(b), { label: 'Redeployment', behaviourKind: 'transfer' });
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), { employmentId: hire.employmentId, kind: code, effectiveDate: PAST, departmentId: b.deptB });
    await createMovementEvent(adminCtx(b), { employmentId: hire.employmentId, kind: code, effectiveDate: FUTURE, departmentId: b.deptA });
    const before = await movementHistory(adminCtx(b), hire.employmentId);

    // A rule the recorded movements do not meet (a document they never had, a field they never changed).
    const pos = await createPosition(adminCtx(b), { companyId: b.companyId, title: `Rule ${randomUUID().slice(0, 5)}` });
    await saveMovementEventType(adminCtx(b), {
      code,
      label: 'Redeployment',
      fieldRules: [rule('departmentId', { document: 'required' }), rule('positionId', { mustChange: true })],
    });
    expect(pos.id).toBeTruthy();
    const after = await movementHistory(adminCtx(b), hire.employmentId);
    expect(after.map((r) => [r.id, r.kind, r.status, r.effectiveDate])).toEqual(before.map((r) => [r.id, r.kind, r.status, r.effectiveDate]));

    const res = await sweepDueMovements(adminCtx(b), { today: FUTURE });
    expect(res.applied).toBe(1);
    expect((await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.effectiveDate === FUTURE)!.status).toBe('applied');
  });

  it('the import refuses a row that needs a document, with a code naming the field', async () => {
    await saveMovementEventType(adminCtx(b), { code: 'transfer', label: 'Transfer', fieldRules: [rule('departmentId', { document: 'required' })] });
    const hire = await hireOne(b, 'EMP-0091');
    const text = toCsv([
      ['employee_code', 'event_type', 'effective_date', 'department_id', 'remarks'],
      ['EMP-0091', 'transfer', PAST, b.deptB, 'Fictional import'],
    ]);
    const preview = await previewMovementImport(adminCtx(b), { companyId: b.companyId, csv: text });
    expect(preview.valid).toBe(0);
    expect(JSON.stringify(preview.employees[0].rows)).toContain('movement_document_required:departmentId');
    expect((await openAssignment(hire.employmentId)).departmentId).toBe(b.deptA);
  });
});

describe('1d58019a Step 2 — supporting documents are read only by Employment History’s audience', () => {
  it('a non-admin, another tenant and another company’s admin see nothing; an unknown id is not found', async () => {
    await saveMovementEventType(adminCtx(b), { code: 'transfer', label: 'Transfer', fieldRules: [rule('departmentId', { document: 'optional' })] });
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: PAST,
      departmentId: b.deptB,
      documents: [{ field: 'departmentId', fileName: 'memo.pdf', mimeType: 'application/pdf', content: PDF }],
    });
    const mv = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === 'transfer')!;
    const [doc] = await movementAttachments(adminCtx(b), hire.employmentId, mv.id);

    await expect(movementAttachments(employeeCtx(b), hire.employmentId, mv.id)).rejects.toThrow(/only an admin/i);
    await expect(readMovementAttachment(employeeCtx(b), hire.employmentId, doc.id)).rejects.toThrow(/only an admin/i);

    const other = await seedBase();
    await expect(readMovementAttachment(adminCtx(other), hire.employmentId, doc.id)).rejects.toThrow();
    const seen = await withTenant(adminCtx(other), (tx) => tx.select().from(schema.movementAttachment));
    expect(seen, 'RLS hides another tenant’s documents').toHaveLength(0);

    const scoped = { ...adminCtx(b), grants: [{ role: 'hr_admin', companyId: other.companyId }] } as SessionContext;
    await expect(readMovementAttachment(scoped, hire.employmentId, doc.id)).rejects.toThrow();

    await expect(readMovementAttachment(adminCtx(b), hire.employmentId, randomUUID())).rejects.toBeInstanceOf(MovementDocumentError);
    // Append-only evidence: the application role holds no UPDATE or DELETE on documents (migration 0722
    // revokes them explicitly, because the bootstrap's default privileges would otherwise grant both).
    await privilegeRefused(
      withTenant(adminCtx(b), (tx) => tx.delete(schema.movementAttachment).where(eq(schema.movementAttachment.id, doc.id))),
    );
    await privilegeRefused(
      withTenant(adminCtx(b), (tx) =>
        tx.update(schema.movementAttachment).set({ fileName: 'tampered.pdf' }).where(eq(schema.movementAttachment.id, doc.id)),
      ),
    );
    expect(await owner.db.select({ id: schema.movementAttachment.id }).from(schema.movementAttachment)).toHaveLength(1);
  });
});

describe('1d58019a Step 2 — permissions, isolation, audit and the workbook fingerprint', () => {
  it('settings reads and writes are admin-only, and RLS refuses a non-admin or cross-tenant row', async () => {
    await expect(
      movementTypeControlsForSettings(employeeCtx(b), { code: 'termination', behaviourKind: 'termination' }),
    ).rejects.toThrow(/only an admin/i);
    await expect(
      saveMovementEventType(employeeCtx(b), { code: 'termination', label: 'Exit', reasonCodes: ['misconduct'] }),
    ).rejects.toThrow(/only an admin/i);
    await rlsRefused(
      withTenant(employeeCtx(b), (tx) =>
        tx.insert(schema.movementTypeFieldRule).values({ tenantId: b.tenantId, typeCode: 'transfer', field: 'departmentId', included: false, editable: false, mustChange: false }),
      ),
    );
    await rlsRefused(
      withTenant(employeeCtx(b), (tx) =>
        tx.insert(schema.movementTypeTerminationReason).values({ tenantId: b.tenantId, typeCode: 'termination', reasonCode: 'misconduct' }),
      ),
    );

    await saveMovementEventType(adminCtx(b), { code: 'transfer', label: 'Transfer', fieldRules: [rule('departmentId', { mustChange: true })] });
    const other = await seedBase();
    const otherControls = (await movementTypeControls(adminCtx(other), [{ code: 'transfer', behaviourKind: 'transfer' }])).get('transfer')!;
    expect(otherControls.configured, 'A’s rules do not apply to B').toBe(false);
    await rlsRefused(
      withTenant(adminCtx(other), (tx) =>
        tx.insert(schema.movementTypeFieldRule).values({ tenantId: b.tenantId, typeCode: 'transfer', field: 'positionId', included: false, editable: false, mustChange: false }),
      ),
    );
    // B can still record a Transfer that A's rule would refuse.
    const hireB = await hireOne(other);
    await createMovementEvent(adminCtx(other), { employmentId: hireB.employmentId, kind: 'transfer', effectiveDate: PAST, positionId: other.positionId, departmentId: other.deptB });

    const saved = await auditEvents(b.tenantId, 'movement-type-field-rules.saved');
    expect(saved).toHaveLength(1);
    expect(saved[0].payload).toMatchObject({ code: 'transfer' });
  });

  it('the workbook catalogue fingerprint changes when reasons or Field Controls change', async () => {
    const fingerprint = async () => movementWorkbookCatalogue({ types: await movementImportTypes(adminCtx(b)) });
    const start = await fingerprint();
    await saveMovementEventType(adminCtx(b), { code: 'termination', label: 'Termination', reasonCodes: ['misconduct'] });
    const afterReasons = await fingerprint();
    expect(afterReasons).not.toBe(start);
    await saveTerminationReason(adminCtx(b), { code: 'misconduct', label: 'Gross Misconduct' });
    const afterRename = await fingerprint();
    expect(afterRename).not.toBe(afterReasons);
    await saveMovementEventType(adminCtx(b), { code: 'transfer', label: 'Transfer', fieldRules: [rule('departmentId', { mustChange: true })] });
    expect(await fingerprint()).not.toBe(afterRename);

    const termination = (await movementImportTypes(adminCtx(b))).find((t) => t.code === 'termination')!;
    expect(termination.reasons?.map((r) => [r.code, r.label])).toEqual([['misconduct', 'Gross Misconduct']]);
  });
});
