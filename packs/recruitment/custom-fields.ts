/**
 * Recruitment slice 14 — Settings › Custom fields (docs/recruitment-reconstruction/specification.md "Slice 14"). Reached from
 * outside the pack ONLY through ./service.
 *
 * Recruitment administrators define, edit, order, enable and disable their company's custom fields for candidates and for
 * jobs, with the options of choice fields (5215 row security admits administrators only to write; the service checks first for
 * a clear refusal). A field whose labels or help text name a sensitive category is refused by the fixed word list in
 * ./custom-field-model (D-052). Once any record has a value, a field keeps its type and restricted setting and cannot be
 * deleted, and an option in use cannot be deleted (the database refuses the same through its foreign keys); disabling hides a
 * field or option and keeps the values. Values are filled on the candidate profile and the job form (./custom-field-store).
 * Events carry ids, the record kind, type and flags only. Read paths write nothing.
 */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { pgSqlState } from '../../lib/db-error';
import { RecruitmentError, isUuid, type RecruitmentErrorCode } from './model';
import {
  CHOICE_TYPES, CUSTOM_FIELD_KINDS, CUSTOM_FIELD_LOCALES, CUSTOM_FIELDS_MAX, CUSTOM_FIELDS_TOTAL_MAX, CUSTOM_OPTIONS_MAX, moveInOrder, validateCustomFieldInput, validateCustomOptionInput,
  type CustomFieldInput, type CustomFieldKind, type CustomFieldType, type CustomLabels, type CustomOptionInput,
} from './custom-field-model';
import { labelsOf } from './custom-field-store';
import { actorId, assertCompanyTx, userLabelsTx } from './data';

const iso = (d: Date | string) => new Date(d).toISOString();
const fieldEvent = (tx: Tx, s: SessionContext, fieldId: string, eventType: string, payload: Record<string, unknown>) =>
  appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-custom-field', aggregateId: fieldId, eventType, actor: actorOf(s), payload });
const labelColumns = sql.raw(CUSTOM_FIELD_LOCALES.map((l) => `label_${l}`).join(', '));
const labelValues = (labels: CustomLabels) => sql.join(CUSTOM_FIELD_LOCALES.map((l) => sql`${labels[l]}`), sql`, `);
const labelSet = (labels: CustomLabels) => sql.join(CUSTOM_FIELD_LOCALES.map((l) => sql`${sql.raw(`label_${l}`)} = ${labels[l]}`), sql`, `);

const constraintOf = (e: unknown): string | undefined => {
  let cur = e as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) {
    if (typeof cur.constraint_name === 'string') return cur.constraint_name;
  }
  return undefined;
};
const asError = (e: unknown): never => {
  const named = constraintOf(e) ?? '';
  const code = pgSqlState(e);
  if (code === '23505' && /label_uq$/.test(named)) throw new RecruitmentError('name_taken');
  // A value's foreign key to its field or option: the field has values (type, restricted, delete) or the option is used.
  if (code === '23503' && /_option_fk$/.test(named)) throw new RecruitmentError('option_in_use');
  if (code === '23503' && /_field_fk$/.test(named)) throw new RecruitmentError('field_in_use');
  const known: Record<string, RecruitmentErrorCode> = { recruitment_custom_field_has_options: 'invalid_input', recruitment_custom_field_option_choice: 'invalid_input' };
  if (known[named]) throw new RecruitmentError(known[named]);
  if (code === '42501') throw new RecruitmentError('forbidden');
  throw e;
};

/**
 * Whether any record has a value for each field, and whether any record chose each option — one bounded index probe per field and
 * option (`exists`, never a count over every value), across the three value tables (administrators read them all).
 */
async function inUseTx(tx: Tx, fieldIds: readonly string[], optionIds: readonly string[] = []): Promise<{ fields: Set<string>; options: Set<string> }> {
  const fields = fieldIds.length ? await tx.execute<{ id: string }>(sql`select f.id from unnest(${`{${fieldIds.join(',')}}`}::uuid[]) as f(id)
    where exists (select 1 from recruitment_candidate_custom_value v where v.field_id = f.id limit 1)
      or exists (select 1 from recruitment_candidate_custom_restricted v where v.field_id = f.id limit 1)
      or exists (select 1 from recruitment_job_custom_value v where v.field_id = f.id limit 1)`) : [];
  const options = optionIds.length ? await tx.execute<{ id: string }>(sql`select o.id from unnest(${`{${optionIds.join(',')}}`}::uuid[]) as o(id)
    where exists (select 1 from recruitment_candidate_custom_value v where v.option_id = o.id limit 1)
      or exists (select 1 from recruitment_candidate_custom_restricted v where v.option_id = o.id limit 1)
      or exists (select 1 from recruitment_job_custom_value v where v.option_id = o.id limit 1)`) : [];
  return { fields: new Set(fields.map((r) => r.id)), options: new Set(options.map((r) => r.id)) };
}
/** The enabled options of a field. */
async function enabledOptionsTx(tx: Tx, fieldId: string): Promise<number> {
  const [row] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_custom_field_option where field_id = ${fieldId}::uuid and enabled`);
  return row?.n ?? 0;
}
/** Serialise definition changes of one company and record kind (the field limits, the order). */
const lockKindTx = (tx: Tx, s: SessionContext, companyId: string, kind: CustomFieldKind) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`recruitment-custom-fields:${s.tenantId}:${companyId}:${kind}`}, 0))`);

// ── Settings › Custom fields ─────────────────────────────────────────────────────────────────────────────────

export type CustomOptionRow = { id: string; labels: CustomLabels; enabled: boolean; inUse: boolean };
export type CustomFieldRow = {
  id: string; kind: CustomFieldKind; type: CustomFieldType; labels: CustomLabels; helpText: string | null; required: boolean; restricted: boolean;
  enabled: boolean; numberMin: string | null; numberMax: string | null; numberDecimals: number | null;
  /** Some record has a value (then the type and restricted setting are fixed and the field cannot be deleted). */
  inUse: boolean; options: CustomOptionRow[]; updatedBy: string | null; updatedAt: string;
};
export type CustomFieldSettings = { companyId: string; kind: CustomFieldKind; fields: CustomFieldRow[] };

export const parseCustomFieldKind = (value: unknown): CustomFieldKind => ((CUSTOM_FIELD_KINDS as readonly unknown[]).includes(value) ? value as CustomFieldKind : 'candidate');

/** Settings › Custom fields: the company's fields of one record kind in order, each with its options and use. Administrators only. */
export async function customFieldSettings(s: SessionContext, companyId: string, kind: unknown): Promise<CustomFieldSettings> {
  const k = parseCustomFieldKind(kind);
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const fields = await tx.execute<Record<`label_${(typeof CUSTOM_FIELD_LOCALES)[number]}`, string | null> & {
      id: string; field_type: CustomFieldType; help_text: string | null; required: boolean; restricted: boolean; enabled: boolean; number_min: string | null;
      number_max: string | null; number_decimals: number | null; updated_by_user_id: string; updated_at: string | Date;
    }>(sql`
      select id, field_type, ${labelColumns}, help_text, required, restricted, enabled, number_min::text as number_min, number_max::text as number_max, number_decimals,
        updated_by_user_id, updated_at
      from recruitment_custom_field where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid and record_kind = ${k}
      order by position, lower(label_en), id`);
    const options = fields.length ? await tx.execute<Record<`label_${(typeof CUSTOM_FIELD_LOCALES)[number]}`, string | null> & { id: string; field_id: string; enabled: boolean }>(sql`
      select id, field_id, ${labelColumns}, enabled from recruitment_custom_field_option where field_id = any(${`{${fields.map((f) => f.id).join(',')}}`}::uuid[])
      order by position, lower(label_en), id`) : [];
    const usage = await inUseTx(tx, fields.map((f) => f.id), options.map((o) => o.id));
    const labels = fields.length ? await userLabelsTx(tx, companyId) : new Map();
    return {
      companyId, kind: k,
      fields: fields.map((f) => ({
        id: f.id, kind: k, type: f.field_type, labels: labelsOf(f), helpText: f.help_text, required: f.required, restricted: f.restricted, enabled: f.enabled,
        numberMin: f.number_min, numberMax: f.number_max, numberDecimals: f.number_decimals, inUse: usage.fields.has(f.id),
        options: options.filter((o) => o.field_id === f.id).map((o) => ({ id: o.id, labels: labelsOf(o), enabled: o.enabled, inUse: usage.options.has(o.id) })),
        updatedBy: labels.get(f.updated_by_user_id)?.name ?? null, updatedAt: iso(f.updated_at),
      })),
    };
  });
}

/**
 * Create (with `companyId` and `kind`) or edit (with `id`) a field. Labels per locale (English required), help text, type,
 * required, restricted (candidate fields only), enabled and the number settings. A field with values keeps its type and
 * restricted setting (`field_in_use`); a choice field that becomes another type loses its options (only possible without values).
 * A choice field is made required only once it has an enabled option (`required_needs_option`). At most CUSTOM_FIELDS_MAX ENABLED
 * fields per company and record kind, and CUSTOM_FIELDS_TOTAL_MAX in all (`custom_field_limit`). Refuses a candidate field whose
 * name or help text names a sensitive category (`sensitive_field`, D-052). Administrators only.
 */
export async function saveCustomField(s: SessionContext, input: CustomFieldInput & { id?: unknown; companyId?: unknown }): Promise<{ id: string }> {
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    if (input.id !== undefined && input.id !== '') {
      if (!isUuid(input.id)) throw new RecruitmentError('not_found');
      const [found] = await tx.execute<{ company_id: string; record_kind: CustomFieldKind }>(sql`select company_id, record_kind from recruitment_custom_field
        where id = ${input.id}::uuid and tenant_id = ${s.tenantId}::uuid`);
      if (!found) throw new RecruitmentError('not_found');
      await assertCompanyTx(tx, found.company_id);
      await lockKindTx(tx, s, found.company_id, found.record_kind);
      const [f] = await tx.execute<{ id: string; company_id: string; record_kind: CustomFieldKind; field_type: CustomFieldType; restricted: boolean; required: boolean;
        enabled: boolean }>(sql`select id, company_id, record_kind, field_type, restricted, required, enabled from recruitment_custom_field
        where id = ${input.id}::uuid for update`);
      if (!f) throw new RecruitmentError('not_found');
      const v = validateCustomFieldInput({ ...input, kind: f.record_kind, type: input.type ?? f.field_type });
      if (!v.ok) throw new RecruitmentError(v.code, v.fields);
      const typeChanged = v.value.type !== f.field_type;
      if (typeChanged || v.value.restricted !== f.restricted) {
        if ((await inUseTx(tx, [f.id])).fields.has(f.id)) throw new RecruitmentError('field_in_use');
        if (typeChanged && CHOICE_TYPES.includes(f.field_type) && !CHOICE_TYPES.includes(v.value.type)) {
          await tx.execute(sql`delete from recruitment_custom_field_option where field_id = ${f.id}::uuid`).catch(asError);
        }
      }
      const val = v.value;
      // A required choice field with nothing to choose would block every save of every record.
      if (val.required && CHOICE_TYPES.includes(val.type) && await enabledOptionsTx(tx, f.id) === 0) {
        throw new RecruitmentError('required_needs_option');
      }
      if (val.enabled && !f.enabled) await assertFieldRoomTx(tx, s, f.company_id, f.record_kind, false);
      await tx.execute(sql`update recruitment_custom_field set field_type = ${val.type}, ${labelSet(val.labels)}, help_text = ${val.helpText},
        required = ${val.required}, restricted = ${val.restricted}, enabled = ${val.enabled}, number_min = ${val.numberMin}::numeric,
        number_max = ${val.numberMax}::numeric, number_decimals = ${val.numberDecimals}::smallint, updated_by_user_id = ${user}::uuid
        where id = ${f.id}::uuid`).catch(asError);
      await fieldEvent(tx, s, f.id, 'recruitment-custom-field.changed', {
        companyId: f.company_id, kind: f.record_kind, type: val.type, typeChanged, required: val.required, restricted: val.restricted, enabled: val.enabled,
      });
      return { id: f.id };
    }
    const companyId = typeof input.companyId === 'string' ? input.companyId : '';
    await assertCompanyTx(tx, companyId);
    const v = validateCustomFieldInput(input);
    if (!v.ok) throw new RecruitmentError(v.code, v.fields);
    const val = v.value;
    // A new choice field has no options yet: it becomes required once one is added.
    if (val.required && CHOICE_TYPES.includes(val.type)) throw new RecruitmentError('required_needs_option');
    await lockKindTx(tx, s, companyId, val.kind);
    const count = await assertFieldRoomTx(tx, s, companyId, val.kind, true, val.enabled);
    const [row] = await tx.execute<{ id: string }>(sql`insert into recruitment_custom_field (tenant_id, company_id, record_kind, field_type, ${labelColumns},
        help_text, required, restricted, enabled, position, number_min, number_max, number_decimals, created_by_user_id, updated_by_user_id)
      values (${s.tenantId}::uuid, ${companyId}::uuid, ${val.kind}, ${val.type}, ${labelValues(val.labels)}, ${val.helpText}, ${val.required}, ${val.restricted},
        ${val.enabled}, ${count.next}, ${val.numberMin}::numeric, ${val.numberMax}::numeric, ${val.numberDecimals}::smallint, ${user}::uuid, ${user}::uuid)
      returning id`).catch(asError);
    await fieldEvent(tx, s, row.id, 'recruitment-custom-field.created', {
      companyId, kind: val.kind, type: val.type, required: val.required, restricted: val.restricted, enabled: val.enabled,
    });
    return { id: row.id };
  });
}

/** Room for one more field (`adding`) or one more ENABLED field (`enabling`): at most CUSTOM_FIELDS_MAX enabled and
 *  CUSTOM_FIELDS_TOTAL_MAX in all per company and record kind. Returns the next position. Called under the kind's lock. */
async function assertFieldRoomTx(tx: Tx, s: SessionContext, companyId: string, kind: CustomFieldKind, adding: boolean, enabling = true): Promise<{ next: number }> {
  const [row] = await tx.execute<{ total: number; enabled: number; next: number }>(sql`select count(*)::int as total, count(*) filter (where enabled)::int as enabled,
    coalesce(max(position) + 1, 0)::int as next from recruitment_custom_field
    where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid and record_kind = ${kind}`);
  if (adding && (row?.total ?? 0) >= CUSTOM_FIELDS_TOTAL_MAX) throw new RecruitmentError('custom_field_limit');
  if (enabling && (row?.enabled ?? 0) >= CUSTOM_FIELDS_MAX) throw new RecruitmentError('custom_field_limit');
  return { next: row?.next ?? 0 };
}

/** Delete a field that no record has a value for (its options first); one with values is refused — disable it instead. */
export async function deleteCustomField(s: SessionContext, fieldId: unknown): Promise<void> {
  actorId(s);
  if (!isUuid(fieldId)) throw new RecruitmentError('not_found');
  await withRecruitmentTenant(s, async (tx) => {
    const [f] = await tx.execute<{ id: string; company_id: string; record_kind: CustomFieldKind }>(sql`select id, company_id, record_kind from recruitment_custom_field
      where id = ${fieldId}::uuid and tenant_id = ${s.tenantId}::uuid`);
    if (!f) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, f.company_id);
    if ((await inUseTx(tx, [f.id])).fields.has(f.id)) throw new RecruitmentError('field_in_use');
    await tx.execute(sql`delete from recruitment_custom_field_option where field_id = ${f.id}::uuid`).catch(asError);
    await tx.execute(sql`delete from recruitment_custom_field where id = ${f.id}::uuid`).catch(asError);
    await fieldEvent(tx, s, f.id, 'recruitment-custom-field.deleted', { companyId: f.company_id, kind: f.record_kind });
  });
}

/** Move a field one place up or down among its company's fields of the same record kind. */
export async function moveCustomField(s: SessionContext, fieldId: unknown, direction: unknown): Promise<void> {
  actorId(s);
  if (!isUuid(fieldId)) throw new RecruitmentError('not_found');
  await withRecruitmentTenant(s, async (tx) => {
    const [f] = await tx.execute<{ company_id: string; record_kind: CustomFieldKind }>(sql`select company_id, record_kind from recruitment_custom_field
      where id = ${fieldId}::uuid and tenant_id = ${s.tenantId}::uuid`);
    if (!f) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, f.company_id);
    const order = (await tx.execute<{ id: string }>(sql`select id from recruitment_custom_field where tenant_id = ${s.tenantId}::uuid
      and company_id = ${f.company_id}::uuid and record_kind = ${f.record_kind} order by position, lower(label_en), id for update`)).map((r) => r.id);
    const next = moveInOrder(order, fieldId, direction);
    if (!next) return;
    for (const [i, id] of next.entries()) await tx.execute(sql`update recruitment_custom_field set position = ${i} where id = ${id}::uuid and position <> ${i}`);
    await fieldEvent(tx, s, fieldId, 'recruitment-custom-field.reordered', { companyId: f.company_id, kind: f.record_kind });
  });
}

/** The choice field an option belongs to, administered by the caller; locked, so option changes of one field run one at a time
 *  (the "last enabled option of a required field" rule below). */
async function choiceFieldTx(tx: Tx, s: SessionContext, fieldId: unknown) {
  if (!isUuid(fieldId)) throw new RecruitmentError('not_found');
  const [found] = await tx.execute<{ company_id: string }>(sql`select company_id from recruitment_custom_field where id = ${fieldId}::uuid and tenant_id = ${s.tenantId}::uuid`);
  if (!found) throw new RecruitmentError('not_found');
  await assertCompanyTx(tx, found.company_id);
  const [f] = await tx.execute<{ id: string; company_id: string; field_type: CustomFieldType; record_kind: CustomFieldKind; required: boolean }>(sql`
    select id, company_id, field_type, record_kind, required from recruitment_custom_field where id = ${fieldId}::uuid for update`);
  if (!f) throw new RecruitmentError('not_found');
  if (!CHOICE_TYPES.includes(f.field_type)) throw new RecruitmentError('invalid_input', ['type']);
  return f;
}

/** The last enabled option of a REQUIRED choice field stays enabled (and is not deleted): without one, the field would block every
 *  save of every record. */
async function assertNotLastEnabledTx(tx: Tx, f: { id: string; required: boolean }, optionId: string): Promise<void> {
  if (!f.required) return;
  const [row] = await tx.execute<{ others: number; self: boolean }>(sql`select count(*) filter (where enabled and id <> ${optionId}::uuid)::int as others,
    bool_or(enabled and id = ${optionId}::uuid) as self from recruitment_custom_field_option where field_id = ${f.id}::uuid`);
  if (row?.self && (row.others ?? 0) === 0) throw new RecruitmentError('required_needs_option');
}

/** Add (with `fieldId`) or edit (with `id`) an option of a choice field: labels per locale (English required) and enabled. A
 *  candidate field's option labels are checked against the sensitive word list (D-052). */
export async function saveCustomFieldOption(s: SessionContext, input: CustomOptionInput & { id?: unknown; fieldId?: unknown }): Promise<{ id: string }> {
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    if (input.id !== undefined && input.id !== '') {
      if (!isUuid(input.id)) throw new RecruitmentError('not_found');
      const [o] = await tx.execute<{ field_id: string }>(sql`select field_id from recruitment_custom_field_option where id = ${input.id}::uuid and tenant_id = ${s.tenantId}::uuid`);
      if (!o) throw new RecruitmentError('not_found');
      const f = await choiceFieldTx(tx, s, o.field_id);
      const v = validateCustomOptionInput(input, f.record_kind);
      if (!v.ok) throw new RecruitmentError(v.code, v.fields);
      if (!v.value.enabled) await assertNotLastEnabledTx(tx, f, input.id);
      await tx.execute(sql`update recruitment_custom_field_option set ${labelSet(v.value.labels)}, enabled = ${v.value.enabled}, updated_by_user_id = ${user}::uuid
        where id = ${input.id}::uuid`).catch(asError);
      await fieldEvent(tx, s, f.id, 'recruitment-custom-field.option-changed', { companyId: f.company_id, optionId: input.id, enabled: v.value.enabled });
      return { id: input.id };
    }
    const f = await choiceFieldTx(tx, s, input.fieldId);
    const v = validateCustomOptionInput(input, f.record_kind);
    if (!v.ok) throw new RecruitmentError(v.code, v.fields);
    const [count] = await tx.execute<{ n: number; next: number }>(sql`select count(*)::int as n, coalesce(max(position) + 1, 0)::int as next
      from recruitment_custom_field_option where field_id = ${f.id}::uuid`);
    if ((count?.n ?? 0) >= CUSTOM_OPTIONS_MAX) throw new RecruitmentError('custom_field_limit');
    const [row] = await tx.execute<{ id: string }>(sql`insert into recruitment_custom_field_option (field_id, tenant_id, company_id, ${labelColumns}, enabled, position,
        created_by_user_id, updated_by_user_id)
      values (${f.id}::uuid, ${s.tenantId}::uuid, ${f.company_id}::uuid, ${labelValues(v.value.labels)}, ${v.value.enabled}, ${count?.next ?? 0}, ${user}::uuid, ${user}::uuid)
      returning id`).catch(asError);
    await fieldEvent(tx, s, f.id, 'recruitment-custom-field.option-added', { companyId: f.company_id, optionId: row.id });
    return { id: row.id };
  });
}

/** Delete an option no record has chosen; one in use is refused — disable it instead. The last enabled option of a required field stays. */
export async function deleteCustomFieldOption(s: SessionContext, optionId: unknown): Promise<void> {
  actorId(s);
  if (!isUuid(optionId)) throw new RecruitmentError('not_found');
  await withRecruitmentTenant(s, async (tx) => {
    const [o] = await tx.execute<{ field_id: string }>(sql`select field_id from recruitment_custom_field_option where id = ${optionId}::uuid and tenant_id = ${s.tenantId}::uuid`);
    if (!o) throw new RecruitmentError('not_found');
    const f = await choiceFieldTx(tx, s, o.field_id);
    if ((await inUseTx(tx, [], [optionId])).options.has(optionId)) throw new RecruitmentError('option_in_use');
    await assertNotLastEnabledTx(tx, f, optionId);
    await tx.execute(sql`delete from recruitment_custom_field_option where id = ${optionId}::uuid`).catch(asError);
    await fieldEvent(tx, s, f.id, 'recruitment-custom-field.option-deleted', { companyId: f.company_id, optionId });
  });
}

/** Move an option one place up or down within its field. */
export async function moveCustomFieldOption(s: SessionContext, optionId: unknown, direction: unknown): Promise<void> {
  actorId(s);
  if (!isUuid(optionId)) throw new RecruitmentError('not_found');
  await withRecruitmentTenant(s, async (tx) => {
    const [o] = await tx.execute<{ field_id: string }>(sql`select field_id from recruitment_custom_field_option where id = ${optionId}::uuid and tenant_id = ${s.tenantId}::uuid`);
    if (!o) throw new RecruitmentError('not_found');
    const f = await choiceFieldTx(tx, s, o.field_id);
    const order = (await tx.execute<{ id: string }>(sql`select id from recruitment_custom_field_option where field_id = ${f.id}::uuid
      order by position, lower(label_en), id for update`)).map((r) => r.id);
    const next = moveInOrder(order, optionId, direction);
    if (!next) return;
    for (const [i, id] of next.entries()) await tx.execute(sql`update recruitment_custom_field_option set position = ${i} where id = ${id}::uuid and position <> ${i}`);
    await fieldEvent(tx, s, f.id, 'recruitment-custom-field.option-reordered', { companyId: f.company_id, optionId });
  });
}
