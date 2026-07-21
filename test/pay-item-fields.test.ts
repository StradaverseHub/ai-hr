/**
 * Pay Items redesign (feedback 4994a48f) — label field, reactivation toggle, trimmed audit payload,
 * and the two data-preservation guarantees of the form redesign:
 *   - `name` (the Description) SURVIVES a form-shaped upsert unchanged — the failure mode that would
 *     have blanked payslips, transaction pickers and the CSV importer's code→name map.
 *   - `ea_form_line` SURVIVES a save from the redesigned form (hidden-passthrough path) even though
 *     the control left the screen.
 * Plus the create-mode duplicate-code lookup (active vs deactivated collision are distinguishable).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
  archivePayComponent,
  listPayComponents,
  lookupPayComponentByCode,
  upsertPayComponent,
  type PayComponentInput,
} from '../core/pay-components';
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

/** The exact field set the redesigned form submits (upsertComponentAction): every field present, label
 *  always a string, eaFormLine via the hidden passthrough. */
const formShaped = (over: Partial<PayComponentInput> = {}): PayComponentInput => ({
  code: 'TRANSPORT',
  name: 'Transportation Allowance',
  label: '',
  kind: 'allowance',
  includedInEpf: true,
  includedInSocsoEis: true,
  includedInPcb: true,
  includedInHrdfBase: false,
  isNonPayable: false,
  prorates: true,
  eaFormLine: null,
  roundingMethod: 'none',
  rule: null,
  ...over,
});

const byCode = async (code: string) =>
  (await listPayComponents(adminCtx(base), { includeArchived: true })).find((c) => c.code === code);

describe('Pay Items — label field', () => {
  it('label round-trips; blank stores NULL; undefined leaves the stored value untouched', async () => {
    const a = adminCtx(base);
    await upsertPayComponent(a, formShaped({ label: '  Transport  ' }));
    expect((await byCode('TRANSPORT'))!.label).toBe('Transport'); // trimmed round-trip

    // undefined ⇒ untouched (a caller that predates the field must not wipe it).
    const { label: _omit, ...withoutLabel } = formShaped();
    await upsertPayComponent(a, withoutLabel);
    expect((await byCode('TRANSPORT'))!.label).toBe('Transport');

    // blank ⇒ NULL (the form clears it).
    await upsertPayComponent(a, formShaped({ label: '   ' }));
    expect((await byCode('TRANSPORT'))!.label).toBeNull();
  });

  // The deliberate no-uniqueness decision (house precedent: the System Labels shape on
  // department/cost_center carries no label uniqueness either) — a later change cannot silently
  // reintroduce a constraint without failing this test.
  it('a duplicate label is ACCEPTED', async () => {
    const a = adminCtx(base);
    await upsertPayComponent(a, formShaped({ code: 'TRAVEL_A', label: 'Transport' }));
    await upsertPayComponent(a, formShaped({ code: 'TRAVEL_B', label: 'Transport' }));
    const all = await listPayComponents(a);
    expect(all.filter((c) => c.label === 'Transport').length).toBe(2);
  });
});

describe('Pay Items — deactivate / reactivate toggle', () => {
  it('archive then unarchive flips archivedAt both ways; both states are listable', async () => {
    const a = adminCtx(base);
    const { id } = await upsertPayComponent(a, formShaped());

    await archivePayComponent(a, { id, archived: true });
    expect((await byCode('TRANSPORT'))!.archivedAt).not.toBeNull();
    // Default list hides it; includeArchived shows it — the page depends on the latter.
    expect((await listPayComponents(a)).some((c) => c.id === id)).toBe(false);
    expect((await listPayComponents(a, { includeArchived: true })).some((c) => c.id === id)).toBe(true);

    await archivePayComponent(a, { id, archived: false });
    expect((await byCode('TRANSPORT'))!.archivedAt).toBeNull();
    expect((await listPayComponents(a)).some((c) => c.id === id)).toBe(true);

    // Substrate discipline: both directions event-logged.
    const events = await owner.db
      .select({ t: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, id));
    const types = events.map((e) => e.t);
    expect(types).toContain('pay-component.archived');
    expect(types).toContain('pay-component.unarchived');
  });
});

describe('Pay Items — trimmed audit payload', () => {
  it('the update event carries changed FIELD NAMES + archived state, and NO field values', async () => {
    const a = adminCtx(base);
    const { id } = await upsertPayComponent(a, formShaped({ label: 'Transport' }));
    await upsertPayComponent(a, formShaped({ name: 'Travel Allowance', label: 'Travel' }));

    const payload = (await latestEventPayload(base.tenantId, id, 'pay-component.updated'))!;
    expect(payload).not.toBeNull();
    expect(payload.changed).toEqual(expect.arrayContaining(['name', 'label']));
    expect(payload.changed).not.toContain('kind'); // unchanged field not reported
    expect(payload.archived).toBe(false);
    // No values: the free-text name/label never enter the immutable event stream.
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain('Travel Allowance');
    expect(raw).not.toContain('Travel');
    expect(raw).not.toContain('Transportation Allowance');
  });
});

describe('Pay Items — Description (name) and EA line survive the redesigned form', () => {
  it('name stays populated and unchanged across a form-shaped upsert (payslips/pickers/importer depend on it)', async () => {
    const a = adminCtx(base);
    await upsertPayComponent(a, formShaped({ eaFormLine: 'allowance_taxable' }));

    // The redesigned form re-submits every field; name is required in the form and stays the Description.
    await upsertPayComponent(a, formShaped({ label: 'Transport', eaFormLine: 'allowance_taxable', roundingMethod: 'nearest' }));

    const row = (await byCode('TRANSPORT'))!;
    expect(row.name).toBe('Transportation Allowance'); // populated, unchanged
    expect(row.label).toBe('Transport');
    expect(row.roundingMethod).toBe('nearest');
  });

  it('eaFormLine survives a save via the hidden passthrough even though the control left the screen', async () => {
    const a = adminCtx(base);
    await upsertPayComponent(a, formShaped({ eaFormLine: 'bik' }));

    // Edit-save from the redesigned form: the hidden field re-submits the row's current eaFormLine.
    const current = (await byCode('TRANSPORT'))!;
    await upsertPayComponent(a, formShaped({ name: 'Transportation Allowance (updated)', eaFormLine: current.eaFormLine }));

    expect((await byCode('TRANSPORT'))!.eaFormLine).toBe('bik');
  });
});

describe('Pay Items — create-mode duplicate Pay Code lookup', () => {
  it('finds an ACTIVE collision, distinguishes a DEACTIVATED one, and misses a novel code', async () => {
    const a = adminCtx(base);
    const { id } = await upsertPayComponent(a, formShaped());

    // Active collision — the action rejects create with "already exists".
    const active = await lookupPayComponentByCode(a, 'TRANSPORT');
    expect(active?.id).toBe(id);
    expect(active?.archivedAt).toBeNull();

    // Deactivated collision — the action rejects create with "reactivate it instead".
    await archivePayComponent(a, { id, archived: true });
    const archived = await lookupPayComponentByCode(a, 'TRANSPORT');
    expect(archived?.id).toBe(id);
    expect(archived?.archivedAt).not.toBeNull();

    // A novel code passes the guard.
    expect(await lookupPayComponentByCode(a, 'NOVEL_CODE')).toBeNull();
  });
});
