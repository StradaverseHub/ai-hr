/**
 * Recruitment slice 14 — custom field values, read and written inside a caller's transaction. Reached from outside the pack
 * ONLY through ./service (the candidate profile, the job form and the three lists use these helpers from ./candidates, ./data
 * and ./requisitions; Settings › Custom fields is ./custom-fields).
 *
 * Everything here runs in the caller's transaction under their own row security (5215): the open candidate values for anyone
 * who may read the candidate, the RESTRICTED candidate values for administrators and the candidate's job operators only, a
 * job's values for whoever may read the job. The service asks the restricted table only for a viewer who operates the
 * candidate, and row security answers again (a hiring manager's or interviewer's direct read returns no row). Values are typed:
 * one row per record and field (one per chosen option for multiple choice) with the matching typed column filled. Events carry
 * the record, company and field ids only — never a value. Read paths write nothing.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { pgSqlState } from '../../lib/db-error';
import { RecruitmentError, isUuid } from './model';
import {
  CHOICE_TYPES, CUSTOM_FIELD_LOCALES, FILTER_TYPES, customInputName, parseCustomFilter, sameValue, validateCustomValues,
  type CustomFieldKind, type CustomFieldType, type CustomFilter, type CustomLabels, type FieldRule, type RawCustomValues, type TypedValue,
} from './custom-field-model';

const ids = (list: readonly string[]) => {
  if (!list.every(isUuid)) throw new RecruitmentError('invalid_input');
  return `{${list.join(',')}}`;
};
/** The value tables (constant names only, never user input). */
const TABLE = {
  open: 'recruitment_candidate_custom_value', restricted: 'recruitment_candidate_custom_restricted', job: 'recruitment_job_custom_value',
} as const;
/** A database refusal of a value write, as the service's code (never SQL or a bound value). */
const valueError = (e: unknown): never => {
  let cur = e as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  let named = '';
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) if (typeof cur.constraint_name === 'string') { named = cur.constraint_name; break; }
  if (named === 'recruitment_candidate_removed') throw new RecruitmentError('candidate_removed');
  if (/^recruitment_custom_(field_disabled|value_range|option_disabled)$/.test(named) || /_typed_ck$|_field_fk$|_option_fk$/.test(named)) {
    throw new RecruitmentError('custom_value_invalid');
  }
  if (pgSqlState(e) === '42501') throw new RecruitmentError('forbidden');
  throw e;
};
const recordColumn = (kind: CustomFieldKind) => (kind === 'job' ? 'job_id' : 'candidate_id');
const labelColumns = sql.raw(CUSTOM_FIELD_LOCALES.map((l) => `label_${l}`).join(', '));
type LabelRow = Record<`label_${(typeof CUSTOM_FIELD_LOCALES)[number]}`, string | null>;
export const labelsOf = (r: LabelRow): CustomLabels => Object.fromEntries(CUSTOM_FIELD_LOCALES.map((l) => [l, r[`label_${l}`] ?? null])) as CustomLabels;

export type CustomOptionView = { id: string; labels: CustomLabels; enabled: boolean };
/** A field as a form or a record page shows it: the definition, its options and (on a record) the stored value. */
export type CustomFieldView = {
  id: string; type: CustomFieldType; labels: CustomLabels; helpText: string | null; required: boolean; restricted: boolean;
  numberMin: string | null; numberMax: string | null; numberDecimals: number | null;
  /** The enabled options, plus a disabled option the record has chosen (shown as chosen, not offered anew). */
  options: CustomOptionView[];
  value: TypedValue | null;
};

type FieldRow = LabelRow & {
  id: string; company_id: string; field_type: CustomFieldType; help_text: string | null; required: boolean; restricted: boolean; enabled: boolean;
  number_min: string | null; number_max: string | null; number_decimals: number | null;
};
type OptionRow = LabelRow & { id: string; field_id: string; enabled: boolean };

/** The company's fields of one record kind, in order, with their options (visible to the caller: administrators and job teams). */
async function fieldsTx(tx: Tx, s: SessionContext, companyId: string, kind: CustomFieldKind, opts: { enabledOnly: boolean; restricted: boolean }) {
  const fields = await tx.execute<FieldRow>(sql`
    select id, company_id, field_type, ${labelColumns}, help_text, required, restricted, enabled, number_min::text as number_min, number_max::text as number_max,
      number_decimals from recruitment_custom_field
    where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid and record_kind = ${kind}
      ${opts.enabledOnly ? sql`and enabled` : sql``} ${opts.restricted ? sql`` : sql`and not restricted`}
    order by position, lower(label_en), id`);
  const options = fields.some((f) => CHOICE_TYPES.includes(f.field_type)) ? await tx.execute<OptionRow>(sql`
    select id, field_id, ${labelColumns}, enabled from recruitment_custom_field_option
    where field_id = any(${ids(fields.map((f) => f.id))}::uuid[]) order by position, lower(label_en), id`) : [];
  return { fields: [...fields], options: [...options] };
}

const ruleOf = (f: FieldRow, options: readonly OptionRow[]): FieldRule => ({
  id: f.id, type: f.field_type, required: f.required, enabled: f.enabled, numberMin: f.number_min, numberMax: f.number_max,
  numberDecimals: f.number_decimals, options: options.filter((o) => o.field_id === f.id).map((o) => ({ id: o.id, enabled: o.enabled })),
});

type ValueRow = { field_id: string; field_type: CustomFieldType; text_value: string | null; number_value: string | null; date_value: string | null;
  bool_value: boolean | null; option_id: string | null };
/** The stored values of one record (the restricted table only when asked: for a viewer who operates the candidate). */
async function valuesTx(tx: Tx, kind: CustomFieldKind, recordId: string, restricted: boolean): Promise<Map<string, TypedValue>> {
  const cols = sql`field_id, field_type, text_value, number_value::text as number_value, to_char(date_value, 'YYYY-MM-DD') as date_value, bool_value, option_id`;
  const rows = kind === 'job'
    ? await tx.execute<ValueRow>(sql`select ${cols} from recruitment_job_custom_value where job_id = ${recordId}::uuid`)
    : await tx.execute<ValueRow>(sql`select ${cols} from recruitment_candidate_custom_value where candidate_id = ${recordId}::uuid
        ${restricted ? sql`union all select ${cols} from recruitment_candidate_custom_restricted where candidate_id = ${recordId}::uuid` : sql``}`);
  const out = new Map<string, TypedValue>();
  for (const r of rows) {
    const t = r.field_type;
    if (t === 'single_choice' || t === 'multiple_choice') {
      const before = out.get(r.field_id);
      out.set(r.field_id, { type: t, optionIds: [...(before && 'optionIds' in before ? before.optionIds : []), r.option_id!] });
    } else if (t === 'short_text' || t === 'long_text') out.set(r.field_id, { type: t, text: r.text_value! });
    else if (t === 'number') out.set(r.field_id, { type: t, number: r.number_value! });
    else if (t === 'date' || t === 'year_month') out.set(r.field_id, { type: t, date: r.date_value! });
    else out.set(r.field_id, { type: 'yes_no', bool: r.bool_value! });
  }
  return out;
}

function viewsOf(fields: readonly FieldRow[], options: readonly OptionRow[], values: ReadonlyMap<string, TypedValue>): CustomFieldView[] {
  return fields.map((f) => {
    const value = values.get(f.id) ?? null;
    const chosen = new Set(value && 'optionIds' in value ? value.optionIds : []);
    const own = options.filter((o) => o.field_id === f.id);
    const order = new Map(own.map((o, i) => [o.id, i]));
    return {
      id: f.id, type: f.field_type, labels: labelsOf(f), helpText: f.help_text, required: f.required, restricted: f.restricted,
      numberMin: f.number_min, numberMax: f.number_max, numberDecimals: f.number_decimals,
      options: own.filter((o) => o.enabled || chosen.has(o.id)).map((o) => ({ id: o.id, labels: labelsOf(o), enabled: o.enabled })),
      // Chosen options in the field's own order.
      value: value && 'optionIds' in value ? { ...value, optionIds: [...value.optionIds].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)) } : value,
    };
  });
}

/**
 * The ENABLED custom fields of a record, with the values the viewer may see (disabled fields are hidden from forms and pages; their
 * values stay stored). Restricted candidate fields and their values only with `restricted` (the viewer operates the candidate).
 * Read-only.
 */
export async function recordCustomFieldsTx(tx: Tx, s: SessionContext, kind: CustomFieldKind, record: { id: string; companyId: string }, restricted: boolean): Promise<CustomFieldView[]> {
  const { fields, options } = await fieldsTx(tx, s, record.companyId, kind, { enabledOnly: true, restricted: kind === 'candidate' && restricted });
  if (!fields.length) return [];
  return viewsOf(fields, options, await valuesTx(tx, kind, record.id, kind === 'candidate' && restricted));
}

/** The ENABLED fields of a new record's form (no values). Read-only. */
export async function newRecordCustomFieldsTx(tx: Tx, s: SessionContext, kind: CustomFieldKind, companyId: string): Promise<CustomFieldView[]> {
  const { fields, options } = await fieldsTx(tx, s, companyId, kind, { enabledOnly: true, restricted: kind === 'candidate' });
  return viewsOf(fields, options, new Map());
}

/**
 * Save a record's custom values from a form (on this save: type, range, options and required are checked for every ENABLED field
 * the editor may write; a record saved before a field became required stays valid until this edit). Unchanged values are not
 * rewritten; an emptied value is deleted. One event with the changed field ids. Throws `custom_value_invalid` or
 * `custom_field_required` with `cf.<field id>` details.
 */
export async function saveRecordCustomValuesTx(tx: Tx, s: SessionContext, kind: CustomFieldKind, record: { id: string; companyId: string }, raw: RawCustomValues): Promise<string[]> {
  if (!s.userId) throw new RecruitmentError('forbidden');
  // Every enabled field: the editor of a candidate operates it (slice 5), so restricted fields are theirs to fill too; a job's
  // editor administers the company.
  const { fields, options } = await fieldsTx(tx, s, record.companyId, kind, { enabledOnly: true, restricted: kind === 'candidate' });
  if (!fields.length) return [];
  const previous = await valuesTx(tx, kind, record.id, kind === 'candidate');
  const v = validateCustomValues(fields.map((f) => ruleOf(f, options)), raw, previous);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields.map((id) => customInputName(id)));
  const changed: string[] = [];
  const rec = sql.raw(recordColumn(kind));
  for (const f of fields) {
    const next = v.values.get(f.id) ?? null;
    const before = previous.get(f.id) ?? null;
    if (sameValue(before, next)) continue;
    const table = sql.raw(kind === 'job' ? TABLE.job : f.restricted ? TABLE.restricted : TABLE.open);
    const keep = next && 'optionIds' in next ? next.optionIds : [];
    // Remove what is no longer there: everything (emptied or a non-choice value replaced below), or the options not kept.
    if (!next || !('optionIds' in next)) {
      if (!next) await tx.execute(sql`delete from ${table} where ${rec} = ${record.id}::uuid and field_id = ${f.id}::uuid`).catch(valueError);
    } else {
      await tx.execute(sql`delete from ${table} where ${rec} = ${record.id}::uuid and field_id = ${f.id}::uuid
        ${keep.length ? sql`and option_id <> all(${ids(keep)}::uuid[])` : sql``}`).catch(valueError);
    }
    if (next) {
      const had = new Set(before && 'optionIds' in before ? before.optionIds : []);
      const rows: SQL[] = 'optionIds' in next
        ? next.optionIds.filter((o) => !had.has(o)).map((o) => sql`(${o}::uuid, null::text, null::numeric, null::date, null::boolean)`)
        : [sql`(null::uuid, ${'text' in next ? next.text : null}::text, ${'number' in next ? next.number : null}::numeric,
            ${'date' in next ? next.date : null}::date, ${'bool' in next ? next.bool : null}::boolean)`];
      if (!('optionIds' in next) && before) {
        await tx.execute(sql`update ${table} set text_value = ${'text' in next ? next.text : null}::text, number_value = ${'number' in next ? next.number : null}::numeric,
          date_value = ${'date' in next ? next.date : null}::date, bool_value = ${'bool' in next ? next.bool : null}::boolean, updated_by_user_id = ${s.userId}::uuid
          where ${rec} = ${record.id}::uuid and field_id = ${f.id}::uuid`).catch(valueError);
      } else if (rows.length) {
        await tx.execute(sql`insert into ${table} (tenant_id, company_id, ${rec}, field_id, field_type, option_id, text_value, number_value, date_value, bool_value,
          updated_by_user_id)
          select ${s.tenantId}::uuid, ${record.companyId}::uuid, ${record.id}::uuid, ${f.id}::uuid, ${f.field_type}, x.o, x.t, x.n, x.d, x.b, ${s.userId}::uuid
          from (values ${sql.join(rows, sql`, `)}) as x(o, t, n, d, b)`).catch(valueError);
      }
    }
    changed.push(f.id);
  }
  if (changed.length) {
    const aggregateType = kind === 'job' ? 'recruitment-job' : 'recruitment-candidate';
    // Field ids only: values (restricted ones above all) never enter an event.
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType, aggregateId: record.id, eventType: `${aggregateType}.custom-values-updated`, actor: actorOf(s),
      payload: { companyId: record.companyId, fieldIds: changed } });
  }
  return changed;
}

// ── The one-field filter (Candidates board, talent pool, job list) ───────────────────────────────────────────────

export type CustomFilterChoice = {
  fieldId: string; companyId: string; type: CustomFieldType; labels: CustomLabels;
  /** Yes / No for a yes-or-no field; the options otherwise (disabled ones too: they still find the records that chose them). */
  answers: { key: string; labels: CustomLabels | null; bool?: boolean }[];
};

/** The fields the viewer may filter by in these companies: enabled, not restricted, single choice, multiple choice or yes/no. */
export async function customFilterChoicesTx(tx: Tx, s: SessionContext, companyIds: readonly string[], kind: CustomFieldKind): Promise<CustomFilterChoice[]> {
  const companies = companyIds.filter(isUuid);
  if (!companies.length) return [];
  const fields = await tx.execute<FieldRow>(sql`
    select id, company_id, field_type, ${labelColumns}, help_text, required, restricted, enabled, null::text as number_min, null::text as number_max,
      null::int as number_decimals from recruitment_custom_field
    where tenant_id = ${s.tenantId}::uuid and company_id = any(${ids(companies)}::uuid[]) and record_kind = ${kind} and enabled and not restricted
      and field_type = any(${`{${FILTER_TYPES.join(',')}}`}::text[])
    order by company_id, position, lower(label_en), id`);
  const options = fields.some((f) => f.field_type !== 'yes_no') ? await tx.execute<OptionRow>(sql`
    select id, field_id, ${labelColumns}, enabled from recruitment_custom_field_option where field_id = any(${ids(fields.map((f) => f.id))}::uuid[])
    order by position, lower(label_en), id`) : [];
  return fields.map((f) => ({
    fieldId: f.id, companyId: f.company_id, type: f.field_type, labels: labelsOf(f),
    answers: f.field_type === 'yes_no'
      ? [{ key: `${f.id}:yes`, labels: null, bool: true }, { key: `${f.id}:no`, labels: null, bool: false }]
      : options.filter((o) => o.field_id === f.id).map((o) => ({ key: `${f.id}:${o.id}`, labels: labelsOf(o) })),
  })).filter((c) => c.answers.length > 0);
}

/**
 * The filter a list applies: the parsed `<field>:<answer>` when it is one of the viewer's choices (else none), and its SQL
 * condition on `recordSql` (the list's candidate or job id column) — an indexed probe of the field's values per row.
 */
export function customFilterSql(choices: readonly CustomFilterChoice[], raw: unknown, kind: CustomFieldKind, recordSql: SQL): { filter: CustomFilter | null; condition: SQL } {
  const parsed = parseCustomFilter(raw);
  const known = parsed ? choices.find((c) => c.fieldId === parsed.fieldId)?.answers.some((a) => a.key === raw) : false;
  if (!parsed || !known) return { filter: null, condition: sql`` };
  const table = sql.raw(kind === 'job' ? TABLE.job : TABLE.open);
  const rec = sql.raw(recordColumn(kind));
  const match = 'optionId' in parsed ? sql`v.option_id = ${parsed.optionId}::uuid` : sql`v.bool_value = ${parsed.bool}`;
  return { filter: parsed, condition: sql`and exists (select 1 from ${table} v where v.${rec} = ${recordSql} and v.field_id = ${parsed.fieldId}::uuid and ${match})` };
}
