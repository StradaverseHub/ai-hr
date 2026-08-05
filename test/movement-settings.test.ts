/**
 * 476f23ed — "Movement Settings for configurable career events".
 *
 * THE SHAPE UNDER TEST. Movement kinds are not data, and they cannot simply become data: Employment History
 * is a read-time projection over domain_event whose branches key on specific kinds. So the catalogue
 * (what an organisation calls its event types, which it offers, and any of its own) is separated from the
 * behaviour (what the system DOES), and every catalogue entry maps to exactly one built-in behaviour kind.
 *
 * The four properties this suite exists to hold:
 *
 *  1. AN OVERLAY. A tenant that has configured nothing behaves exactly as before — the built-in list, in
 *     the built-in order, all active. Nothing is seeded per tenant, so there is nothing to keep in step.
 *  2. RENAME AND SWITCH OFF ARE FREE, SEMANTICS ARE NOT. A built-in can be renamed and deactivated; its
 *     behaviour cannot be changed, and a custom type cannot be pointed at Termination, Confirmation,
 *     Probation Extension, Blacklist or either join-date correction. Those drive real consequences.
 *  3. A CUSTOM TYPE IS A REAL MOVEMENT. Recording one runs the built-in behaviour it maps to — the same
 *     writers, the same guards, the same rollback path — while the LEDGER records the organisation's own
 *     code, so Employment History shows the type HR chose.
 *  4. IN USE MEANS NOT DELETABLE. History is a projection and a movement stores its type as a code;
 *     deleting a referenced code would leave every past record unlabelled. Deactivate instead.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { createPosition } from '../core/admin';
import {
  createMovementEvent,
  editMovementEvent,
  movementHistory,
  MovementNoChangeError,
  MOVEMENT_KINDS,
} from '../core/movement';
import { sweepDueMovements } from '../core/movement-apply';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  CONFIGURABLE_BEHAVIOUR_KINDS,
  codeFromLabel,
  deleteMovementEventType,
  listMovementEventTypes,
  MovementTypeError,
  saveMovementEventType,
  setMovementEventTypeActive,
} from '../core/movement-type';

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

const email = () => `mvs_${randomUUID().slice(0, 8)}@t.local`;

async function hireOne() {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Settings Subject', primaryEmail: email() },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    costCenterId: b.costCenterId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
}

const rowFor = (rows: Awaited<ReturnType<typeof listMovementEventTypes>>, code: string) =>
  rows.find((r) => r.code === code)!;

/**
 * Source with comments removed, for the guards below.
 *
 * These files EXPLAIN the shapes the guards assert — the dialog's header says in prose why
 * `defaultValue` would be wrong, and a raw `not.toContain('defaultValue')` failed on that sentence
 * while the code was already correct. Scan the code, not the prose (same helper, same reason, as
 * test/settings-list-idiom.test.ts). It also stops a comment from SATISFYING a positive assertion.
 * The `[^:]` guard keeps `https://` intact.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('476f23ed — the catalogue is an overlay on the built-in kinds', () => {
  it('a tenant that has configured nothing sees the built-in list, in order, all active', async () => {
    const rows = await listMovementEventTypes(adminCtx(b));
    expect(rows.map((r) => r.code)).toEqual([...MOVEMENT_KINDS]);
    expect(rows.every((r) => r.builtIn)).toBe(true);
    expect(rows.every((r) => r.active)).toBe(true);
    // Null label = "still using the shipped translation", which is what keeps the six-locale catalogue
    // in force for a tenant that never renamed anything.
    expect(rows.every((r) => r.label === null)).toBe(true);
    // And nothing was written to do it.
    const stored = await owner.db.select().from(schema.movementEventType);
    expect(stored).toHaveLength(0);
  });

  it('renaming a built-in changes its label and NOTHING else', async () => {
    await saveMovementEventType(adminCtx(b), { code: 'transfer', label: 'Redeployment' });
    const row = rowFor(await listMovementEventTypes(adminCtx(b)), 'transfer');
    expect(row.label).toBe('Redeployment');
    expect(row.behaviourKind, 'behaviour is untouched by a rename').toBe('transfer');
    expect(row.builtIn).toBe(true);
    expect(row.active).toBe(true);
  });

  it('a built-in keeps its built-in meaning — behaviour cannot be re-pointed', async () => {
    await expect(
      saveMovementEventType(adminCtx(b), { code: 'termination', label: 'Exit', behaviourKind: 'transfer' }),
    ).rejects.toBeInstanceOf(MovementTypeError);
    // The rename half of the same request is refused with it — an all-or-nothing write, not a partial one.
    expect(rowFor(await listMovementEventTypes(adminCtx(b)), 'termination').label).toBeNull();
  });

  it('a custom type can only carry a consequence-free behaviour', async () => {
    // The set is exactly the comparison kinds plus the two record-only ones.
    expect([...CONFIGURABLE_BEHAVIOUR_KINDS].sort()).toEqual(
      [
        'actingPosition', 'demotion', 'employmentTypeChange', 'increment', 'orgAssignmentChange',
        'promotion', 'reportingLineChange', 'salaryAdjustment', 'secondment', 'transfer',
      ].sort(),
    );
    for (const forbidden of [
      'termination', 'confirmation', 'probationExtension', 'resignation', 'blacklist',
      'joinDateChange', 'groupJoinDateCorrection',
    ]) {
      await expect(
        saveMovementEventType(adminCtx(b), { label: `Custom ${forbidden}`, behaviourKind: forbidden }),
        `a tenant must not be able to invent a ${forbidden}`,
      ).rejects.toBeInstanceOf(MovementTypeError);
    }
  });

  it('a custom type cannot shadow a built-in code', async () => {
    await expect(
      saveMovementEventType(adminCtx(b), { label: 'transfer', behaviourKind: 'promotion' }),
    ).rejects.toThrow(/built-in/i);
  });

  it('derives a stable ledger code from the name', () => {
    expect(codeFromLabel('Regional Assignment')).toBe('regional_assignment');
    expect(codeFromLabel("  Re-deployment (Ops)  ")).toBe('re_deployment_ops');
  });

  it('rejects a non-admin caller', async () => {
    await expect(
      saveMovementEventType(
        { tenantId: b.tenantId, userId: b.adminUserId, roles: ['employee'] },
        { label: 'Sneaky', behaviourKind: 'transfer' },
      ),
    ).rejects.toThrow(/only an admin/i);
  });
});

describe('476f23ed — a custom type is a real movement', () => {
  it('records the ORGANISATION’s code on the ledger and runs the built-in behaviour', async () => {
    const hire = await hireOne();
    const pos = await createPosition(adminCtx(b), { companyId: b.companyId, title: `Ops ${randomUUID().slice(0, 5)}` });
    const { code } = await saveMovementEventType(adminCtx(b), {
      label: 'Redeployment',
      behaviourKind: 'transfer',
    });
    expect(code).toBe('redeployment');

    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: code,
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
      positionId: pos.id,
    });

    // The history shows the type HR chose, not the behaviour it borrowed.
    const rows = await movementHistory(adminCtx(b), hire.employmentId);
    expect(rows.map((r) => r.kind)).toEqual(['hired', 'redeployment']);

    // …and the TRANSFER really happened — the same writer, the same dated assignment.
    const [asg] = await owner.db
      .select({ departmentId: schema.assignment.departmentId, positionId: schema.assignment.positionId })
      .from(schema.assignment)
      .where(and(eq(schema.assignment.employmentId, hire.employmentId), eq(schema.assignment.validFrom, '2026-06-01')));
    expect(asg.departmentId).toBe(b.deptB);
    expect(asg.positionId).toBe(pos.id);

    // The tag on the ledger carries the code, which is what the projection reads back.
    const [ev] = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.subjectEmploymentId, hire.employmentId),
          eq(schema.domainEvent.eventType, 'employment.assignment.changed'),
        ),
      );
    expect((ev.payload as { movement?: { type?: string } }).movement?.type).toBe('redeployment');
  });

  it('a switched-off type cannot be used to record a NEW movement', async () => {
    const hire = await hireOne();
    await setMovementEventTypeActive(adminCtx(b), { code: 'transfer', active: false });
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        kind: 'transfer',
        effectiveDate: '2026-06-01',
        departmentId: b.deptB,
      }),
    ).rejects.toThrow(/switched off/i);
    // Deactivating changed no record: the employee is exactly where they were.
    expect((await movementHistory(adminCtx(b), hire.employmentId)).map((r) => r.kind)).toEqual(['hired']);
  });

  it('switching a type off never alters the movements already recorded under it', async () => {
    const hire = await hireOne();
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: 'transfer',
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
    });
    const before = await movementHistory(adminCtx(b), hire.employmentId);

    await setMovementEventTypeActive(adminCtx(b), { code: 'transfer', active: false });

    const after = await movementHistory(adminCtx(b), hire.employmentId);
    expect(after.map((r) => r.kind)).toEqual(before.map((r) => r.kind));
    expect(after.map((r) => r.effectiveDate)).toEqual(before.map((r) => r.effectiveDate));
  });

  it('a FUTURE-dated custom-type movement is applied by the sweep on its effective date', async () => {
    // The riskiest path this item opens: the scheduled event stores the CATALOGUE CODE, and the sweep has
    // to resolve it back to a behaviour months later. If it did not, r83's scheduling would quietly drop
    // every movement recorded under one of the organisation's own types — pending forever, no error.
    const hire = await hireOne();
    const { code } = await saveMovementEventType(adminCtx(b), { label: 'Redeployment', behaviourKind: 'transfer' });
    const today = todayInKualaLumpur();
    const future = new Date(Date.parse(`${today}T00:00:00Z`) + 10 * 86_400_000).toISOString().slice(0, 10);

    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: code,
      effectiveDate: future,
      departmentId: b.deptB,
    });

    // Pending: nothing changed today, and the row already carries the organisation's own type.
    let hist = await movementHistory(adminCtx(b), hire.employmentId);
    expect(hist.map((r) => r.kind)).toEqual(['hired', code]);
    expect(hist.find((r) => r.kind === code)!.status).toBe('pending');

    const res = await sweepDueMovements(adminCtx(b), { today: future });
    expect(res.applied).toBe(1);

    hist = await movementHistory(adminCtx(b), hire.employmentId);
    // Still ONE row for the movement, now applied — the sweep's legs are companions, not a second entry.
    expect(hist.map((r) => r.kind)).toEqual(['hired', code]);
    expect(hist.find((r) => r.kind === code)!.status).toBe('applied');
    const [asg] = await owner.db
      .select({ departmentId: schema.assignment.departmentId })
      .from(schema.assignment)
      .where(and(eq(schema.assignment.employmentId, hire.employmentId), eq(schema.assignment.validFrom, future)));
    expect(asg.departmentId, 'the Transfer behaviour really ran').toBe(b.deptB);
  });

  it('an unknown code is refused — a forged form field cannot invent an event type', async () => {
    const hire = await hireOne();
    await expect(
      createMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        kind: 'promotion_to_ceo',
        effectiveDate: '2026-06-01',
        departmentId: b.deptB,
      }),
    ).rejects.toThrow(/unknown movement event type/i);
  });

  /**
   * CORRECTING one of the organisation's own types.
   *
   * Both tests below cover the same root fault, found while reviewing this item: `editMovementEvent`
   * resolves the submitted type to its BEHAVIOUR before doing anything, but the record-only correction
   * branch then compared and re-recorded that behaviour against `row.kind`, which is the CATALOGUE CODE
   * the projection read off the ledger. For every built-in type the two are the same string, so the fault
   * is invisible until a tenant configures a type of their own — exactly the case this item adds.
   */
  it('correcting a custom-type movement keeps the ORGANISATION’s type, it does not revert to the behaviour', async () => {
    const hire = await hireOne();
    const { code } = await saveMovementEventType(adminCtx(b), {
      label: 'Regional Assignment',
      behaviourKind: 'secondment',
    });
    expect(code).toBe('regional_assignment');

    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: code,
      effectiveDate: '2026-06-01',
      endDate: '2026-09-01',
      remarks: 'Six months in Penang',
    });
    const recorded = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === code)!;

    // Correct the dates. The movement must still be a Regional Assignment afterwards.
    await editMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      movementId: recorded.id,
      kind: code,
      effectiveDate: '2026-06-15',
      endDate: '2026-09-15',
      remarks: 'Six months in Penang',
      reason: 'Start date was keyed wrong',
    });

    const after = await movementHistory(adminCtx(b), hire.employmentId);
    const live = after.filter((r) => r.kind !== 'hired' && r.status !== 'reversed');
    expect(live.map((r) => r.kind), 'the correction is still the organisation’s type').toEqual([code]);
    expect(live[0].effectiveDate).toBe('2026-06-15');
    // The built-in behaviour name must not have leaked onto the history as a second, differently-named row.
    expect(after.map((r) => r.kind)).not.toContain('secondment');
  });

  it('re-saving a custom-type movement unchanged is still a no-op', async () => {
    const hire = await hireOne();
    const { code } = await saveMovementEventType(adminCtx(b), {
      label: 'Regional Assignment',
      behaviourKind: 'secondment',
    });
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: code,
      effectiveDate: '2026-06-01',
      endDate: '2026-09-01',
      remarks: 'Six months in Penang',
    });
    const recorded = (await movementHistory(adminCtx(b), hire.employmentId)).find((r) => r.kind === code)!;

    // Identical resubmission. Before the fix the guard compared 'secondment' against 'regional_assignment',
    // never matched, and appended a reversal plus a fresh record for a save that changed nothing.
    await expect(
      editMovementEvent(adminCtx(b), {
        employmentId: hire.employmentId,
        movementId: recorded.id,
        kind: code,
        effectiveDate: '2026-06-01',
        endDate: '2026-09-01',
        remarks: 'Six months in Penang',
      }),
    ).rejects.toBeInstanceOf(MovementNoChangeError);

    const after = await movementHistory(adminCtx(b), hire.employmentId);
    expect(after.map((r) => r.kind)).toEqual(['hired', code]);
    expect(after.find((r) => r.kind === code)!.status).not.toBe('reversed');
  });
});

describe('476f23ed — deletion is refused where it would damage history', () => {
  it('a built-in cannot be deleted', async () => {
    await expect(deleteMovementEventType(adminCtx(b), 'termination')).rejects.toThrow(/cannot be deleted/i);
  });

  it('a custom type nothing has recorded CAN be deleted', async () => {
    const { code } = await saveMovementEventType(adminCtx(b), { label: 'Unused Type', behaviourKind: 'secondment' });
    expect(rowFor(await listMovementEventTypes(adminCtx(b)), code).inUse).toBe(false);
    await deleteMovementEventType(adminCtx(b), code);
    expect((await listMovementEventTypes(adminCtx(b))).some((r) => r.code === code)).toBe(false);
  });

  it('a custom type IN USE cannot be deleted — only switched off', async () => {
    const hire = await hireOne();
    const { code } = await saveMovementEventType(adminCtx(b), { label: 'Redeployment', behaviourKind: 'transfer' });
    await createMovementEvent(adminCtx(b), {
      employmentId: hire.employmentId,
      kind: code,
      effectiveDate: '2026-06-01',
      departmentId: b.deptB,
    });
    expect(rowFor(await listMovementEventTypes(adminCtx(b)), code).inUse).toBe(true);

    await expect(deleteMovementEventType(adminCtx(b), code)).rejects.toThrow(/switch it off/i);

    // Switching it off is allowed, and the recorded movement keeps its label.
    await setMovementEventTypeActive(adminCtx(b), { code, active: false });
    expect((await movementHistory(adminCtx(b), hire.employmentId)).map((r) => r.kind)).toEqual([
      'hired',
      code,
    ]);
  });
});

describe('476f23ed — the settings screen', () => {
  it('SOURCE GUARD: the page offers rename, switch off and add, and never a behaviour picker for a built-in', () => {
    const src = codeOnly(
      fs.readFileSync(path.resolve(__dirname, '../app/admin/settings/movement/page.tsx'), 'utf8'),
    );
    const dialog = codeOnly(
      fs.readFileSync(
        path.resolve(__dirname, '../app/admin/settings/movement/movement-type-dialog.tsx'),
        'utf8',
      ),
    );
    // The save moved into the dialog island with the form; the row actions stayed on the page.
    expect(dialog).toContain('saveMovementEventTypeAction');
    expect(src).toContain('setMovementEventTypeActiveAction');
    expect(src).toContain('deleteMovementEventTypeAction');
    // The only behaviour picker is the dialog's, fed from the restricted set the PAGE computes (the
    // island must not import core/movement-type — that pulls the pg driver through db/client).
    expect(src).toContain('CONFIGURABLE_BEHAVIOUR_KINDS');
    expect(dialog, 'the island reads no domain module').not.toContain("from '@/core/");
    expect(
      dialog.match(/name="behaviourKind"/g) ?? [],
      'exactly one behaviour picker, and it lives in the dialog',
    ).toHaveLength(1);
    expect(src, 'the page renders no editor of its own any more').not.toContain('name="behaviourKind"');
    expect(dialog, 'a built-in never gets an editable behaviour field').toContain('builtIn ? (');
    // Delete is rendered only for a custom type nothing uses — the affordance mirrors the service rule.
    expect(src).toContain('!r.builtIn && !r.inUse');
  });

  /**
   * 1b87e8a0 — the card-per-type layout becomes a row listing in the shape the reporter named (the
   * Employee ID setup page). What is asserted here is what the redesign PROMISED and what it refused:
   * a table with Created (not Last Updated) and no Description column, search and sorting — and NO new
   * migration to pay for any of it. The Add/Edit surface has its own guard below.
   */
  it('SOURCE GUARD: 1b87e8a0 row listing — Created not Last Updated, no Description, no pager', () => {
    // codeOnly: this page's header explains, in prose, that it shows Created and NOT "Last Updated"
    // or a Description column — exactly the words the negatives below look for.
    const src = codeOnly(
      fs.readFileSync(path.resolve(__dirname, '../app/admin/settings/movement/page.tsx'), 'utf8'),
    );
    // A real table, and the Add affordance is a button in the toolbar — not a card in the list.
    expect(src).toContain('<table');
    expect(src).toContain("t('createNew')");
    // Search and sort, as promised.
    expect(src).toContain('<SettingsSearch');
    expect(src).toContain('<SortHeader');
    // The two columns the reporter asked for that have nothing behind them must NOT have been faked.
    expect(src).toContain("t('columns.created')");
    expect(src, 'there is no updated_at to show').not.toContain('lastUpdated');
    expect(src, 'movement_event_type has no description column').not.toContain("columns.description");
    // A built-in has no creation date; the cell says so instead of showing the date of a rename.
    expect(src).toContain("t('builtIn')");
  });

  /**
   * 1b87e8a0 RE-BUILD — the reporter contested the shipped screen: "displays the Add or Edit Event form
   * at the bottom of the existing page, which is not user-friendly and results in a poor user
   * experience." They were right. The first build copied the Employee ID Auto Running Number page's
   * idiom for consistency, and that idiom puts the form BELOW the list — so opening it scrolled you off
   * the row you were working on and closing it did not put you back.
   *
   * WHAT THIS GUARD HOLDS, and why each line is here rather than in prose:
   *
   *  1. ONE surface, and it is a MODAL. Not a modal *and* a panel, and not a modal *and* a side sheet:
   *     a second Add/Edit affordance is how a screen ends up with two ways to do one thing.
   *  2. THE PANEL IS GONE, not hidden behind a flag. `?new=`/`?edit=` with it — leaving the address
   *     mechanism in place next to client state gives "is the form open" two sources of truth, which is
   *     exactly how the bottom panel grows back.
   *  3. A REJECTED SAVE KEEPS THE DIALOG OPEN WITH THE TYPING INTACT. Two things are needed and BOTH
   *     are asserted: the action must RETURN its refusal (a redirect navigates the route out from under
   *     an open dialog), and the fields must be CONTROLLED, because React 19 resets an uncontrolled
   *     `<form action={…}>` once the action settles — success or failure. `defaultValue` here would
   *     silently wipe a half-typed name on the one path this is meant to protect, with a green suite.
   *  4. THE PAGE STAYS A SERVER COMPONENT feeding the island serialisable values only.
   */
  it('SOURCE GUARD: 1b87e8a0 re-build — Add/Edit is a dialog over the list, never a panel under it', () => {
    const dir = path.resolve(__dirname, '../app/admin/settings/movement');
    const rawPage = fs.readFileSync(path.join(dir, 'page.tsx'), 'utf8');
    const rawDialog = fs.readFileSync(path.join(dir, 'movement-type-dialog.tsx'), 'utf8');
    // Every assertion below runs on the CODE. These three files document the very shapes being
    // asserted, so prose could both fail a negative and satisfy a positive. The two directive checks
    // stay on the raw source, because where 'use client' sits in the file IS the thing being checked.
    const page = codeOnly(rawPage);
    const dialog = codeOnly(rawDialog);
    const actions = codeOnly(fs.readFileSync(path.join(dir, 'actions.ts'), 'utf8'));

    // 1. ONE surface: a Radix modal, in its own client island.
    expect(rawDialog).toMatch(/^'use client';/);
    expect(dialog).toContain("from '@radix-ui/react-dialog'");
    expect(dialog).toContain('<Dialog.Content');
    expect(page).toContain('<MovementTypeDialog');
    expect(page, 'the page opens the dialog from the toolbar AND from every row').toMatch(
      /triggerClassName=\{btnPrimary\}[\s\S]*triggerClassName=\{rowActionCls\}/,
    );

    // 2. The panel under the list is gone, and so is the address mechanism that opened it.
    expect(page, 'no maintenance panel below the table').not.toContain('showPanel');
    expect(page, 'no ?new= / ?edit= alongside the dialog').not.toMatch(/\bsp\.(new|edit)\b/);
    expect(page).not.toMatch(/new: '1'/);
    expect(page, 'the page renders no add/edit form of its own').not.toContain('name="label"');
    expect(page).not.toContain('saveMovementEventTypeAction');

    // 3a. The save RETURNS its outcome; only the row actions redirect.
    const save = actions.slice(
      actions.indexOf('export async function saveMovementEventTypeAction'),
      actions.indexOf('export async function setMovementEventTypeActiveAction'),
    );
    expect(save, 'the save function was found').not.toBe('');
    expect(save, 'a redirect would close the dialog and lose the typing').not.toContain('redirect(');
    expect(save).toContain('return { ok: false, error:');
    expect(save).toContain('return { ok: true }');
    expect(actions, 'the row actions still redirect, deliberately').toContain('redirect(`${PAGE}?error=');

    // 3b. useActionState over that action, and CONTROLLED fields so React 19's post-action form reset
    //     cannot wipe what the admin typed.
    expect(dialog).toContain('useActionState');
    expect(dialog).toMatch(/value=\{label\}[\s\S]*onChange=\{\(e\) => setLabel\(e\.target\.value\)\}/);
    expect(dialog).toMatch(/value=\{behaviourKind\}[\s\S]*onChange=\{\(e\) => setBehaviourKind\(e\.target\.value\)\}/);
    expect(dialog, 'an uncontrolled field is reset by React when the action settles').not.toContain(
      'defaultValue',
    );
    // 3c. …AND the reset itself is cancelled. Controlled state alone is NOT enough, which is only
    //     visible by rendering: React resets the <form> after the action, and while a controlled text
    //     input survives (React keeps its defaultValue in step), a controlled <select> does NOT — the
    //     DOM snapped back to the first option while React still held the chosen one, so a refused save
    //     showed "Transfer" over a form that would have saved "Promotion". Reproduced on a dev server,
    //     fixed by cancelling the reset, and pinned here because nothing else can see it.
    expect(dialog, 'the post-action form reset must be cancelled').toMatch(
      /onReset=\{\(e\) => e\.preventDefault\(\)\}/,
    );
    // The error paints IN the dialog rather than as a page-level banner behind it.
    expect(dialog).toContain('<ErrorBanner message={state.error} />');

    // 4. Server page, serialisable props only: no t() and no useTranslations inside the island, so
    //    every label crosses the boundary as a plain string.
    expect(rawPage).not.toMatch(/^\s*['"]use client['"]\s*;/m);
    expect(dialog, 'labels arrive pre-translated from the server page').not.toMatch(
      /useTranslations|getTranslations/,
    );
  });

  it('the Created column is honest: NULL for every built-in, the real date for a custom type', async () => {
    // Built-ins have no row at all until a tenant touches one, and once they do, that row's created_at
    // is the date of the RENAME. Either way it is not a creation date, so the service reports null and
    // the screen renders "Built-in". This is the guard on the claim, not on the rendering.
    const before = await listMovementEventTypes(adminCtx(b));
    expect(before.every((r) => r.builtIn)).toBe(true);
    expect(before.every((r) => r.createdAt === null), 'an untouched built-in carries no date').toBe(true);

    await saveMovementEventType(adminCtx(b), { code: 'transfer', label: 'Redeployment' });
    const renamed = rowFor(await listMovementEventTypes(adminCtx(b)), 'transfer');
    expect(renamed.label).toBe('Redeployment');
    expect(renamed.createdAt, 'a renamed built-in still reports no creation date').toBeNull();

    const { code } = await saveMovementEventType(adminCtx(b), {
      label: 'Regional Assignment',
      behaviourKind: 'secondment',
    });
    const custom = rowFor(await listMovementEventTypes(adminCtx(b)), code);
    expect(custom.createdAt, 'the organisation’s own type carries the date it was added').toBeInstanceOf(Date);
  });

  it('the nav row exists and is labelled in all six locales', () => {
    const sidebar = fs.readFileSync(path.resolve(__dirname, '../components/sidebar.tsx'), 'utf8');
    expect(sidebar).toContain("href: '/admin/settings/movement'");
    expect(sidebar).toContain("labelKey: 'movementSettings'");
    expect(
      fs.existsSync(path.resolve(__dirname, '../app/admin/settings/movement/page.tsx')),
      'the route the nav row points at exists',
    ).toBe(true);

    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const msg = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'));
      expect(typeof msg?.nav?.movementSettings, `messages/${loc}.json missing nav.movementSettings`).toBe('string');
      const ms = msg?.movementSettings ?? {};
      // THIS LIST IS THE ONLY THING PINNING THESE KEYS. The page opens TWO namespaces
      // (movementSettings + people.detail.movement.eventType), and i18n-coverage Check C skips any
      // multi-namespace file ENTIRELY — static keys included. A key added to the page and forgotten
      // in a catalog renders raw with a fully green suite unless it is listed here.
      for (const k of [
        'title', 'description', 'behaviourNotice', 'catalogTitle', 'save', 'builtInBehaviour', 'inUse',
        'add', 'addTitle', 'addHint', 'addNamePlaceholder', 'addBehaviourPlaceholder',
        'deactivate', 'activate', 'delete',
        'deactivateConfirmTitle', 'deactivateConfirmDescription',
        'activateConfirmTitle', 'activateConfirmDescription',
        'deleteConfirmTitle', 'deleteConfirmDescription',
        // 1b87e8a0 — the row-listing redesign: toolbar, empty state, Created cell.
        'searchPlaceholder', 'createNew', 'edit', 'editTitle', 'editHint', 'cancel', 'empty', 'builtIn',
        // 1b87e8a0 re-build — the two strings the modal needs that the bottom panel never did: the
        // submit button's pending label, and the ✕'s accessible name.
        'saving', 'close',
      ]) {
        expect(typeof ms[k], `messages/${loc}.json missing movementSettings.${k}`).toBe('string');
      }
      for (const k of ['name', 'behaviour', 'status', 'action', 'created']) {
        expect(typeof ms.columns?.[k], `messages/${loc}.json missing movementSettings.columns.${k}`).toBe('string');
      }
      for (const k of ['active', 'inactive', 'all']) {
        expect(typeof ms.status?.[k], `messages/${loc}.json missing movementSettings.status.${k}`).toBe('string');
      }
    }
  });

  it('SOURCE GUARD: the New Event form asks the BEHAVIOUR what fields to show, not the code', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../app/admin/personnel/[employmentId]/movement-new-event.tsx'),
      'utf8',
    );
    // Every field-visibility decision runs off `behaviour`. If one is left keyed on `kind`, a tenant's own
    // type mapped onto Transfer renders the wrong form — which is the whole failure mode this guards.
    expect(src).toContain('const behaviour = behaviourOf(kind);');
    expect(src).toContain('COMPARISON_KINDS.includes(behaviour)');
    expect(src).toContain("behaviour === 'termination'");
    expect(src).toContain("behaviour === 'blacklist'");
    expect(src).toContain('DATE_VALUE_KINDS.includes(behaviour)');
    // And the option list comes from the catalogue, not from the hard-coded array.
    expect(src).toContain('edit ? edit.allowedKinds : catalog.map((c) => c.code)');
  });
});
