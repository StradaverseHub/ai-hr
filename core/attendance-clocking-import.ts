/**
 * r424 (feedback 50ed39e1) — Attendance File Structure Mapping, Import Clocking Data, and Import Logs.
 *
 * WHAT THIS OWNS. The mapping library (how each clocking device writes its file), the line-by-line
 * decision of what in a file may be added to attendance, and the permanent log of every import. It does
 * NOT own how a day is worked out: each accepted clocking is handed to core/attendance.ts
 * addImportedPunchesBatchTx, which adds it as an ordinary multi-punch child and re-derives the day the
 * Clock-screen way. Reading a line (dates, times, codes) is lib/clocking-file.ts, pure, shared with the
 * browser — and re-run here on the text the server receives, because the browser's preview is never
 * trusted.
 *
 * THE RULES (the approved plan, items 10-21):
 *  · VALIDATE writes nothing. IMPORT re-runs every check inside its own transaction and saves the lines
 *    that are still valid; one bad line never stops the others.
 *  · Matching: card id, then employee code, then IC digits — the precedence the old importer had — but
 *    only against employments EMPLOYED ON THE CLOCKING'S DATE (join date ≤ date ≤ termination) and only
 *    those the importer may see (RLS). A card outside the importer's companies is "not found", naming no
 *    one. Two employments answering at the same level is ambiguous, never a guess.
 *  · A duplicate is a clocking already recorded for the same employee, business day and MINUTE (and
 *    direction, when the file has In/Out codes), from any source — the Clock screen, an earlier import,
 *    a day written before multi-punch (its check-in/out stand in as clockings) — or earlier in the same
 *    file. So importing a file twice adds nothing twice.
 *  · Without In/Out codes a day's lines are read in time order as in, out, in, out (an odd count leaves
 *    the day open, as the Clock screen does), and they may not add to a day that has Clock-screen
 *    clockings — that day's lines are listed instead.
 *  · A day corrected through an approved request, or inside a CLOSED pay run, is not changed; its lines
 *    are listed. A day inside a PROCESSED run is updated and that run is marked as needing
 *    recalculation (markBatchNeedsRecalc), exactly as Recompute Attendance does.
 *  · Every import leaves a log (clocking_import_run + one clocking_import_line per data line). The file
 *    is never stored. A run that stops writes a Failed row in its own transaction.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  appUser,
  attendance,
  attendanceCorrection,
  attendancePunch,
  clockingFileMapping,
  clockingImportLine,
  clockingImportRun,
  employeeStatutoryMy,
  employment,
  person,
  type ClockingImportLineResult,
} from '../db/schema';
import { withAttendanceTenant as withTenant } from './module-gate';
import { addImportedPunchesBatchTx, assignPunchBusinessDays, punchOrderKey } from './attendance';
// ADR-0080 D9 — payroll is consumed through its pack facade, never core/payroll directly.
import {
  batchesCoveringAttendanceDates,
  closedBatchesCoveringAttendanceDates,
  markBatchNeedsRecalc,
} from '../packs/payroll/service';
import {
  BUILTIN_MAPPING_ID,
  BUILTIN_MAPPING_NAME,
  CLOCKING_ENCODINGS,
  CLOCKING_FIELDS,
  SAMPLE_LINE_LIMIT,
  SAMPLE_LINE_MAX_CHARS,
  parseWithMapping,
  validateMappingDef,
  type AnyMappingDef,
  type ClockingField,
  type ClockingMappingDef,
  type FieldSpec,
  type InOutCode,
  type MappingProblem,
  type ReadLine,
} from '../lib/clocking-file';
import { MAX_IMPORT_CSV_BYTES } from '../lib/import-file';
import { timeInKualaLumpur, todayInKualaLumpur } from '../lib/hr-date';

// ─── Mapping library ──────────────────────────────────────────────────────────────────────────────────

export type ClockingMappingInput = {
  name: string;
  description: string;
  deviceName: string;
  fileType: 'csv' | 'txt';
  layout: 'delimited' | 'fixed_width';
  delimiter: string | null;
  hasHeader: boolean;
  encoding: string;
  active: boolean;
  fields: Partial<Record<ClockingField, FieldSpec>>;
  inOutCodes: InOutCode[];
  sampleLines: string[];
  sampleFileName: string;
};

export type ClockingMappingRow = ClockingMappingInput & {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  /** When an import last used this mapping; null = never (so it may be deleted). */
  lastUsedAt: Date | null;
};

/** Why a mapping was refused. `missing` is the reporter's list of required fields not configured. */
export class ClockingMappingError extends Error {
  constructor(
    readonly code: 'invalid' | 'nameRequired' | 'nameTaken' | 'notFound' | 'inUse' | 'builtin',
    readonly missing: ClockingField[] = [],
    readonly problems: MappingProblem[] = [],
  ) {
    super(code === 'invalid' ? `Mapping cannot be saved: ${[...missing, ...problems].join(', ')}` : `Mapping: ${code}`);
    this.name = 'ClockingMappingError';
  }
}

const NAME_MAX = 100;

/** Normalise what a form sent into exactly what may be stored. The shape of `fields` follows the layout:
 *  a fixed-width spec on a delimited mapping (or the reverse) is dropped, not reinterpreted. */
export function normaliseMappingInput(raw: ClockingMappingInput): ClockingMappingInput {
  const layout = raw.layout === 'fixed_width' ? 'fixed_width' : 'delimited';
  const fields: Partial<Record<ClockingField, FieldSpec>> = {};
  for (const f of CLOCKING_FIELDS) {
    const s = raw.fields?.[f] as FieldSpec | undefined;
    if (!s) continue;
    if (layout === 'delimited' && 'column' in s) fields[f] = { column: Number(s.column) };
    if (layout === 'fixed_width' && 'start' in s) fields[f] = { start: Number(s.start), end: Number(s.end) };
  }
  const encoding = (CLOCKING_ENCODINGS as readonly string[]).includes(raw.encoding) ? raw.encoding : 'utf-8';
  return {
    name: (raw.name ?? '').trim().slice(0, NAME_MAX),
    description: (raw.description ?? '').trim().slice(0, 500),
    deviceName: (raw.deviceName ?? '').trim().slice(0, NAME_MAX),
    fileType: raw.fileType === 'txt' ? 'txt' : 'csv',
    layout,
    delimiter: layout === 'delimited' ? (raw.delimiter ?? ',') : null,
    hasHeader: !!raw.hasHeader,
    encoding,
    active: raw.active !== false,
    fields,
    inOutCodes: fields.inOutCode
      ? (raw.inOutCodes ?? []).map((c) => ({ code: String(c.code ?? '').trim(), direction: c.direction }))
      : [],
    sampleLines: (raw.sampleLines ?? []).slice(0, SAMPLE_LINE_LIMIT).map((l) => String(l).slice(0, SAMPLE_LINE_MAX_CHARS)),
    sampleFileName: (raw.sampleFileName ?? '').slice(0, 255),
  };
}

const defOf = (m: Pick<ClockingMappingInput, 'fileType' | 'layout' | 'delimiter' | 'hasHeader' | 'encoding' | 'fields' | 'inOutCodes'>): ClockingMappingDef => ({
  fileType: m.fileType,
  layout: m.layout,
  delimiter: m.delimiter,
  hasHeader: m.hasHeader,
  encoding: m.encoding as ClockingMappingDef['encoding'],
  fields: m.fields,
  inOutCodes: m.inOutCodes,
});

async function assertSavable(tx: Tx, input: ClockingMappingInput, selfId: string | null) {
  if (!input.name) throw new ClockingMappingError('nameRequired');
  const { missing, problems } = validateMappingDef(defOf(input));
  if (missing.length || problems.length) throw new ClockingMappingError('invalid', missing, problems);
  // The built-in template's name is taken by the template itself.
  if (input.name.toLowerCase() === BUILTIN_MAPPING_NAME.toLowerCase()) throw new ClockingMappingError('nameTaken');
  const clash = await tx
    .select({ id: clockingFileMapping.id })
    .from(clockingFileMapping)
    .where(sql`lower(${clockingFileMapping.name}) = lower(${input.name})`)
    .limit(2);
  if (clash.some((c) => c.id !== selfId)) throw new ClockingMappingError('nameTaken');
}

const isNameUnique = (e: unknown) =>
  (e as { code?: string; constraint_name?: string })?.code === '23505' ||
  /clocking_file_mapping_name_uq/.test(String((e as Error)?.message ?? ''));

const mappingSelect = {
  id: clockingFileMapping.id,
  name: clockingFileMapping.name,
  description: clockingFileMapping.description,
  deviceName: clockingFileMapping.deviceName,
  fileType: clockingFileMapping.fileType,
  layout: clockingFileMapping.layout,
  delimiter: clockingFileMapping.delimiter,
  hasHeader: clockingFileMapping.hasHeader,
  encoding: clockingFileMapping.encoding,
  active: clockingFileMapping.active,
  fields: clockingFileMapping.fields,
  inOutCodes: clockingFileMapping.inOutCodes,
  sampleLines: clockingFileMapping.sampleLines,
  sampleFileName: clockingFileMapping.sampleFileName,
  createdAt: clockingFileMapping.createdAt,
  updatedAt: clockingFileMapping.updatedAt,
};

/** Every saved mapping (the built-in template is not a row — see builtinMappingSummary). */
export function listClockingMappings(ctx: SessionContext): Promise<ClockingMappingRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.select(mappingSelect).from(clockingFileMapping).orderBy(clockingFileMapping.name);
    const used = await tx
      .select({ mappingId: clockingImportRun.mappingId, last: sql<Date>`max(${clockingImportRun.createdAt})` })
      .from(clockingImportRun)
      .where(isNotNull(clockingImportRun.mappingId))
      .groupBy(clockingImportRun.mappingId);
    const lastBy = new Map(used.map((u) => [u.mappingId!, u.last ? new Date(u.last) : null]));
    return rows.map((r) => ({ ...(r as ClockingMappingRow), lastUsedAt: lastBy.get(r.id) ?? null }));
  });
}

/** When the built-in template was last used (it has no row of its own). */
export function builtinMappingLastUsed(ctx: SessionContext): Promise<Date | null> {
  return withTenant(ctx, async (tx) => {
    const [r] = await tx
      .select({ last: sql<Date | null>`max(${clockingImportRun.createdAt})` })
      .from(clockingImportRun)
      .where(sql`${clockingImportRun.mappingId} is null`);
    return r?.last ? new Date(r.last) : null;
  });
}

export function getClockingMapping(ctx: SessionContext, id: string): Promise<ClockingMappingRow | null> {
  return withTenant(ctx, async (tx) => {
    const [r] = await tx.select(mappingSelect).from(clockingFileMapping).where(eq(clockingFileMapping.id, id)).limit(1);
    if (!r) return null;
    const [u] = await tx
      .select({ last: sql<Date | null>`max(${clockingImportRun.createdAt})` })
      .from(clockingImportRun)
      .where(eq(clockingImportRun.mappingId, id));
    return { ...(r as ClockingMappingRow), lastUsedAt: u?.last ? new Date(u.last) : null };
  });
}

const snapshotOf = (input: ClockingMappingInput) => ({
  name: input.name,
  deviceName: input.deviceName,
  fileType: input.fileType,
  layout: input.layout,
  delimiter: input.delimiter,
  hasHeader: input.hasHeader,
  encoding: input.encoding,
  active: input.active,
  fields: input.fields,
  inOutCodes: input.inOutCodes,
});

export async function createClockingMapping(ctx: SessionContext, raw: ClockingMappingInput): Promise<string> {
  const input = normaliseMappingInput(raw);
  try {
    return await withTenant(ctx, async (tx) => {
      await assertSavable(tx, input, null);
      const [row] = await tx
        .insert(clockingFileMapping)
        .values({ tenantId: ctx.tenantId, ...input, createdByUserId: ctx.userId ?? null })
        .returning({ id: clockingFileMapping.id });
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'clocking-file-mapping',
        aggregateId: row.id,
        eventType: 'clocking-file-mapping.created',
        actor: actorOf(ctx),
        payload: snapshotOf(input),
      });
      return row.id;
    });
  } catch (e) {
    if (!(e instanceof ClockingMappingError) && isNameUnique(e)) throw new ClockingMappingError('nameTaken');
    throw e;
  }
}

export async function updateClockingMapping(ctx: SessionContext, id: string, raw: ClockingMappingInput): Promise<void> {
  const input = normaliseMappingInput(raw);
  try {
    await withTenant(ctx, async (tx) => {
      const [before] = await tx.select(mappingSelect).from(clockingFileMapping).where(eq(clockingFileMapping.id, id)).limit(1);
      if (!before) throw new ClockingMappingError('notFound');
      await assertSavable(tx, input, id);
      await tx
        .update(clockingFileMapping)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(clockingFileMapping.id, id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'clocking-file-mapping',
        aggregateId: id,
        eventType: 'clocking-file-mapping.updated',
        actor: actorOf(ctx),
        payload: { before: snapshotOf(before as ClockingMappingInput), after: snapshotOf(input) },
      });
    });
  } catch (e) {
    if (!(e instanceof ClockingMappingError) && isNameUnique(e)) throw new ClockingMappingError('nameTaken');
    throw e;
  }
}

/** A copy named "<name> (copy)", "<name> (copy 2)", … — always saved, never a half-filled form. */
export async function duplicateClockingMapping(ctx: SessionContext, id: string, copyWord = 'copy'): Promise<string> {
  const src = await getClockingMapping(ctx, id);
  if (!src) throw new ClockingMappingError('notFound');
  const taken = new Set((await listClockingMappings(ctx)).map((m) => m.name.toLowerCase()));
  let name = `${src.name} (${copyWord})`.slice(0, NAME_MAX);
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${src.name} (${copyWord} ${n})`.slice(0, NAME_MAX);
  const { id: _id, createdAt: _c, updatedAt: _u, lastUsedAt: _l, ...rest } = src;
  return createClockingMapping(ctx, { ...rest, name });
}

export async function setClockingMappingActive(ctx: SessionContext, id: string, active: boolean): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const done = await tx
      .update(clockingFileMapping)
      .set({ active, updatedAt: new Date() })
      .where(eq(clockingFileMapping.id, id))
      .returning({ id: clockingFileMapping.id });
    if (done.length === 0) throw new ClockingMappingError('notFound');
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'clocking-file-mapping',
      aggregateId: id,
      eventType: active ? 'clocking-file-mapping.activated' : 'clocking-file-mapping.deactivated',
      actor: actorOf(ctx),
      payload: { active },
    });
  });
}

/** Delete only a mapping NO import has used. A used one is deactivated instead: its logs name it, and the
 *  run's FK is RESTRICT, so the database refuses too. */
export async function deleteClockingMapping(ctx: SessionContext, id: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [used] = await tx
      .select({ id: clockingImportRun.id })
      .from(clockingImportRun)
      .where(eq(clockingImportRun.mappingId, id))
      .limit(1);
    if (used) throw new ClockingMappingError('inUse');
    const [gone] = await tx
      .delete(clockingFileMapping)
      .where(eq(clockingFileMapping.id, id))
      .returning({ name: clockingFileMapping.name });
    if (!gone) throw new ClockingMappingError('notFound');
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'clocking-file-mapping',
      aggregateId: id,
      eventType: 'clocking-file-mapping.deleted',
      actor: actorOf(ctx),
      payload: { name: gone.name },
    });
  });
}

// ─── The import ───────────────────────────────────────────────────────────────────────────────────────

export type ImportLineView = {
  lineNo: number;
  cardRef: string;
  employmentId: string | null;
  employeeName: string | null;
  /** The business day the clocking belongs to (YYYY-MM-DD), or null when the date did not read. */
  date: string | null;
  dateText: string;
  time: string | null;
  timeText: string;
  direction: 'in' | 'out' | null;
  result: ClockingImportLineResult;
  /** A short, data-only detail for the message (e.g. what the duplicate duplicates). Never prose. */
  detail: string;
};

export type ImportCounts = {
  total: number;
  valid: number;
  duplicate: number;
  unmatchedCard: number;
  invalidDateTime: number;
  otherError: number;
  employees: number;
  firstDate: string | null;
  lastDate: string | null;
};

export type ClockingImportPreview = {
  mappingName: string;
  counts: ImportCounts;
  /** Every line not importable, capped at PREVIEW_ERROR_ROWS. */
  errorRows: ImportLineView[];
  /** The first PREVIEW_VALID_ROWS valid lines. */
  validRows: ImportLineView[];
  /** When this exact file (same content) was imported before, the most recent such import. */
  previousImport: { runId: string; at: Date; fileName: string } | null;
};

export const PREVIEW_ERROR_ROWS = 2000;
export const PREVIEW_VALID_ROWS = 500;

/** Which bucket of the reporter's arithmetic a line result falls in. Failed = the sum of the four. */
export function bucketOf(r: ClockingImportLineResult): 'imported' | 'duplicate' | 'unmatched' | 'datetime' | 'other' {
  if (r === 'imported') return 'imported';
  if (r === 'duplicate') return 'duplicate';
  if (r === 'unmatched_card' || r === 'not_employed_on_date') return 'unmatched';
  if (r === 'invalid_date' || r === 'invalid_time' || r === 'future_date') return 'datetime';
  return 'other';
}

type EmpRow = {
  id: string;
  companyId: string;
  name: string;
  code: string | null;
  cardId: string | null;
  ic: string | null;
  start: string;
  end: string | null;
};

type Decided = {
  read: ReadLine;
  result: ClockingImportLineResult;
  emp: EmpRow | null;
  day: string | null;
  direction: 'in' | 'out' | null;
  detail: string;
};

const onlyDigits = (s: string) => s.replace(/\D/g, '');
const hm = (t: string) => t.slice(0, 5);
const CHUNK = 1000;
const chunks = <T,>(xs: T[], n = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** Resolve the mapping an import names: the built-in template, or an ACTIVE saved mapping. */
async function resolveMapping(
  tx: Tx,
  mappingId: string,
): Promise<{ id: string | null; name: string; def: AnyMappingDef; snapshot: Record<string, unknown> }> {
  if (mappingId === BUILTIN_MAPPING_ID) {
    return { id: null, name: BUILTIN_MAPPING_NAME, def: { builtin: true }, snapshot: { builtin: true, name: BUILTIN_MAPPING_NAME } };
  }
  const [m] = await tx.select(mappingSelect).from(clockingFileMapping).where(eq(clockingFileMapping.id, mappingId)).limit(1);
  if (!m) throw new ClockingImportError('mappingNotFound');
  if (!m.active) throw new ClockingImportError('mappingInactive');
  const input = m as unknown as ClockingMappingInput;
  return { id: m.id, name: m.name, def: defOf(input), snapshot: snapshotOf(input) };
}

export class ClockingImportError extends Error {
  constructor(readonly code: 'mappingNotFound' | 'mappingInactive' | 'emptyFile' | 'fileTooLarge') {
    super(`Clocking import: ${code}`);
    this.name = 'ClockingImportError';
  }
}

/**
 * Decide every line. Reads only; the commit calls this inside its own transaction so the checks are run
 * again at the moment of import (plan item 12).
 */
async function decideLines(tx: Tx, def: AnyMappingDef, text: string): Promise<Decided[]> {
  const now = { date: todayInKualaLumpur(), time: timeInKualaLumpur() };
  const { lines } = parseWithMapping(text, def, now);
  const decided: Decided[] = lines.map((read) => ({
    read,
    result: (read.error ?? 'imported') as ClockingImportLineResult,
    emp: null,
    day: null,
    direction: read.direction,
    detail: read.error === 'unknown_in_out_code' ? (read.code ?? '') : '',
  }));
  const readable = decided.filter((d) => d.result === 'imported');
  if (readable.length === 0) return decided;

  // 1 · Match. Every employment the importer may see (RLS), terminated ones included, because "employed
  //     on the date" is decided per line. Card, then code, then IC digits; first level with an employment
  //     employed on that date wins; two at one level is ambiguous.
  const emps: EmpRow[] = (
    await tx
      .select({
        id: employment.id,
        companyId: employment.companyId,
        name: person.fullName,
        code: employment.employeeCode,
        cardId: employment.cardId,
        ic: employeeStatutoryMy.icNumber,
        start: sql<string>`coalesce(${employment.joinDate}, ${employment.hiredOn})::text`,
        end: sql<string | null>`${employment.terminatedOn}::text`,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
  ).map((r) => ({ ...r, start: String(r.start), end: r.end == null ? null : String(r.end) }));
  const index = (key: (e: EmpRow) => string | null) => {
    const m = new Map<string, EmpRow[]>();
    for (const e of emps) {
      const k = key(e);
      if (!k) continue;
      const arr = m.get(k) ?? [];
      if (!arr.some((x) => x.id === e.id)) arr.push(e);
      m.set(k, arr);
    }
    return m;
  };
  const byCard = index((e) => (e.cardId ? e.cardId.trim().toLowerCase() : null));
  const byCode = index((e) => (e.code ? e.code.trim().toLowerCase() : null));
  const byIc = index((e) => (e.ic ? onlyDigits(e.ic) || null : null));
  const employedOn = (e: EmpRow, date: string) => e.start <= date && (e.end == null || date <= e.end);
  for (const d of readable) {
    const ref = d.read.cardRef.trim();
    const levels = [byCard.get(ref.toLowerCase()), byCode.get(ref.toLowerCase()), onlyDigits(ref) ? byIc.get(onlyDigits(ref)) : undefined];
    let sawInactive: EmpRow | null = null;
    let decidedHere = false;
    for (const cands of levels) {
      if (!cands || cands.length === 0) continue;
      const active = cands.filter((e) => employedOn(e, d.read.date!));
      if (active.length === 1) {
        d.emp = active[0];
        decidedHere = true;
        break;
      }
      if (active.length > 1) {
        d.result = 'ambiguous_card';
        decidedHere = true;
        break;
      }
      sawInactive ??= cands[0];
    }
    if (!decidedHere) {
      if (sawInactive) {
        d.result = 'not_employed_on_date';
        d.emp = sawInactive;
      } else d.result = 'unmatched_card';
    }
  }
  const matched = readable.filter((d) => d.result === 'imported' && d.emp);
  if (matched.length === 0) return decided;

  // 2 · Business day per clocking (the roster window, one query for the file).
  const days = await assignPunchBusinessDays(
    tx,
    matched.map((d) => ({ employmentId: d.emp!.id, date: d.read.date!, time: d.read.time! })),
  );
  matched.forEach((d, i) => (d.day = days[i]));

  // 3 · What is already on those days: punches, legacy day rows with no punches, approved corrections.
  const empIds = [...new Set(matched.map((d) => d.emp!.id))];
  const sortedDays = matched.map((d) => d.day!).sort();
  const from = sortedDays[0];
  const to = sortedDays[sortedDays.length - 1];
  type Existing = { time: string; direction: 'in' | 'out'; method: 'web' | 'import' };
  const existingBy = new Map<string, Existing[]>();
  const correctedDays = new Set<string>();
  for (const ids of chunks(empIds)) {
    const punches = await tx
      .select({
        employmentId: attendancePunch.employmentId,
        date: attendancePunch.attendanceDate,
        time: attendancePunch.punchAt,
        direction: attendancePunch.direction,
        method: attendancePunch.method,
      })
      .from(attendancePunch)
      .where(and(inArray(attendancePunch.employmentId, ids), gte(attendancePunch.attendanceDate, from), lte(attendancePunch.attendanceDate, to)));
    const withKids = new Set<string>();
    for (const p of punches) {
      const k = `${p.employmentId}|${p.date}`;
      withKids.add(k);
      const arr = existingBy.get(k) ?? [];
      arr.push({ time: p.time, direction: p.direction, method: p.method });
      existingBy.set(k, arr);
    }
    // A day row written before multi-punch (or by the retired importer) has no children: its own
    // check-in / check-out stand in as clockings, exactly as addImportedPunchesBatchTx will synthesise them.
    const rows = await tx
      .select({
        employmentId: attendance.employmentId,
        date: attendance.attendanceDate,
        checkInAt: attendance.checkInAt,
        checkOutAt: attendance.checkOutAt,
        inMethod: attendance.checkInMethod,
        outMethod: attendance.checkOutMethod,
      })
      .from(attendance)
      .where(and(inArray(attendance.employmentId, ids), gte(attendance.attendanceDate, from), lte(attendance.attendanceDate, to)));
    for (const r of rows) {
      const k = `${r.employmentId}|${r.date}`;
      if (withKids.has(k)) continue;
      const arr: Existing[] = [];
      if (r.checkInAt) arr.push({ time: r.checkInAt, direction: 'in', method: r.inMethod ?? 'web' });
      if (r.checkOutAt) arr.push({ time: r.checkOutAt, direction: 'out', method: r.outMethod ?? r.inMethod ?? 'web' });
      if (arr.length) existingBy.set(k, arr);
    }
    const corr = await tx
      .select({ employmentId: attendanceCorrection.employmentId, date: attendanceCorrection.attendanceDate })
      .from(attendanceCorrection)
      .where(
        and(
          inArray(attendanceCorrection.employmentId, ids),
          gte(attendanceCorrection.attendanceDate, from),
          lte(attendanceCorrection.attendanceDate, to),
          eq(attendanceCorrection.status, 'approved'),
          or(isNotNull(attendanceCorrection.proposedCheckIn), isNotNull(attendanceCorrection.proposedCheckOut)),
        ),
      );
    for (const c of corr) correctedDays.add(`${c.employmentId}|${c.date}`);
  }

  // 4 · Closed pay runs, per company (the run owns a day by payslip + attendance cut-off window).
  const closedDays = new Set<string>();
  const byCompany = new Map<string, Map<string, { employmentId: string; date: string }>>();
  for (const d of matched) {
    const k = `${d.emp!.id}|${d.day}`;
    const m = byCompany.get(d.emp!.companyId) ?? new Map();
    m.set(k, { employmentId: d.emp!.id, date: d.day! });
    byCompany.set(d.emp!.companyId, m);
  }
  for (const [companyId, entries] of byCompany) {
    const runs = await closedBatchesCoveringAttendanceDates(tx, { companyId, entries: [...entries.values()] });
    for (const r of runs) for (const e of r.entries) closedDays.add(`${e.employmentId}|${e.date}`);
  }

  // 5 · Per (employee, business day), in real-time order: refuse whole days, then de-duplicate, then
  //     (uncoded files) read the day in time order as in, out, in, out.
  const groups = new Map<string, Decided[]>();
  for (const d of matched) {
    const k = `${d.emp!.id}|${d.day}`;
    const arr = groups.get(k) ?? [];
    arr.push(d);
    groups.set(k, arr);
  }
  const fmtDup = (day: string, time: string, dir: 'in' | 'out' | null) => `${day} ${hm(time)}${dir ? ` ${dir}` : ''}`;
  for (const [k, ds] of groups) {
    ds.sort((a, b) => punchOrderKey(a.read.date!, a.read.time!) - punchOrderKey(b.read.date!, b.read.time!) || a.read.lineNo - b.read.lineNo);
    if (correctedDays.has(k)) {
      for (const d of ds) d.result = 'day_corrected';
      continue;
    }
    if (closedDays.has(k)) {
      for (const d of ds) d.result = 'period_closed';
      continue;
    }
    const existing = existingBy.get(k) ?? [];
    const coded = ds[0].read.direction != null || ds[0].read.code != null;
    if (!coded && existing.some((e) => e.method === 'web')) {
      for (const d of ds) d.result = 'uncoded_on_clocked_day';
      continue;
    }
    const seen = new Map<string, string>(); // dedupe key → what it duplicates, for the message
    for (const e of existing) {
      seen.set(coded ? `${hm(e.time)}|${e.direction}` : hm(e.time), fmtDup(ds[0].day!, e.time, e.direction));
    }
    const accepted: Decided[] = [];
    for (const d of ds) {
      const key = coded ? `${hm(d.read.time!)}|${d.direction}` : hm(d.read.time!);
      const hit = seen.get(key);
      if (hit) {
        d.result = 'duplicate';
        d.detail = hit;
        continue;
      }
      seen.set(key, fmtDup(d.day!, d.read.time!, d.direction));
      accepted.push(d);
    }
    if (!coded && accepted.length) {
      // In, out, in, out over the WHOLE day — what is already there and what the file adds, in time order.
      // (Existing clockings carry only a time of day, so they are ordered on the business day.)
      const merged = [
        ...existing.map((e) => ({ key: punchOrderKey(ds[0].day!, e.time), d: null as Decided | null })),
        ...accepted.map((d) => ({ key: punchOrderKey(d.read.date!, d.read.time!), d })),
      ].sort((a, b) => a.key - b.key);
      merged.forEach((m, i) => {
        if (m.d) m.d.direction = i % 2 === 0 ? 'in' : 'out';
      });
    }
  }
  return decided;
}

function countsOf(decided: Decided[]): ImportCounts {
  const c: ImportCounts = {
    total: decided.length,
    valid: 0,
    duplicate: 0,
    unmatchedCard: 0,
    invalidDateTime: 0,
    otherError: 0,
    employees: 0,
    firstDate: null,
    lastDate: null,
  };
  const emps = new Set<string>();
  for (const d of decided) {
    const b = bucketOf(d.result);
    if (b === 'imported') {
      c.valid++;
      emps.add(d.emp!.id);
      if (!c.firstDate || d.day! < c.firstDate) c.firstDate = d.day!;
      if (!c.lastDate || d.day! > c.lastDate) c.lastDate = d.day!;
    } else if (b === 'duplicate') c.duplicate++;
    else if (b === 'unmatched') c.unmatchedCard++;
    else if (b === 'datetime') c.invalidDateTime++;
    else c.otherError++;
  }
  c.employees = emps.size;
  return c;
}

/** The employee is named on a line only when the line's employment was matched — an unmatched card names
 *  no one, and a card outside the importer's companies never reaches here (RLS). */
const viewOf = (d: Decided): ImportLineView => ({
  lineNo: d.read.lineNo,
  cardRef: d.read.cardRef,
  employmentId: d.emp?.id ?? null,
  employeeName: d.emp?.name ?? null,
  date: d.day ?? d.read.date,
  dateText: d.read.dateText,
  time: d.read.time,
  timeText: d.read.timeText,
  direction: d.direction,
  result: d.result,
  detail: d.detail,
});

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function assertFile(text: string) {
  if (!text || !text.trim()) throw new ClockingImportError('emptyFile');
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_CSV_BYTES) throw new ClockingImportError('fileTooLarge');
}

/** VALIDATE — read the whole file, decide every line, write nothing. */
export async function validateClockingImport(
  ctx: SessionContext,
  p: { mappingId: string; text: string },
): Promise<ClockingImportPreview> {
  assertFile(p.text);
  return withTenant(ctx, async (tx) => {
    const mapping = await resolveMapping(tx, p.mappingId);
    const decided = await decideLines(tx, mapping.def, p.text);
    const [prev] = await tx
      .select({ id: clockingImportRun.id, at: clockingImportRun.createdAt, fileName: clockingImportRun.fileName })
      .from(clockingImportRun)
      .where(and(eq(clockingImportRun.fileSha256, sha256(p.text)), sql`${clockingImportRun.failureReason} is null`))
      .orderBy(desc(clockingImportRun.createdAt))
      .limit(1);
    const errors = decided.filter((d) => d.result !== 'imported');
    const valid = decided.filter((d) => d.result === 'imported');
    return {
      mappingName: mapping.name,
      counts: countsOf(decided),
      errorRows: errors.slice(0, PREVIEW_ERROR_ROWS).map(viewOf),
      validRows: valid.slice(0, PREVIEW_VALID_ROWS).map(viewOf),
      previousImport: prev ? { runId: prev.id, at: prev.at, fileName: prev.fileName } : null,
    };
  });
}

export type ClockingImportOutcome = {
  runId: string | null;
  status: ClockingImportStatus;
  counts: ImportCounts;
  imported: number;
  daysUpdated: number;
  failureReason: string | null;
};

async function actorPersonId(tx: Tx, ctx: SessionContext): Promise<string | null> {
  if (ctx.personId) return ctx.personId;
  if (!ctx.userId) return null;
  const [u] = await tx
    .select({ personId: appUser.personId })
    .from(appUser)
    .where(and(eq(appUser.tenantId, ctx.tenantId), or(sql`${appUser.id}::text = ${ctx.userId}`, eq(appUser.workosUserId, ctx.userId))))
    .limit(1);
  return u?.personId ?? null;
}

/**
 * IMPORT — re-decide every line inside ONE transaction, add the valid ones, and write the log in that same
 * transaction. If anything throws, nothing is saved; a Failed log row is then written in its own
 * transaction (best-effort, the employee-import precedent) and the outcome says why.
 */
export async function commitClockingImport(
  ctx: SessionContext,
  p: { mappingId: string; text: string; fileName: string; fileBytes: number },
): Promise<ClockingImportOutcome> {
  assertFile(p.text);
  const fileSha = sha256(p.text);
  const fileName = (p.fileName ?? '').slice(0, 255);
  let mappingForFailure: { id: string | null; name: string; snapshot: Record<string, unknown> } | null = null;
  let totalForFailure = 0;
  try {
    return await withTenant(ctx, async (tx) => {
      const mapping = await resolveMapping(tx, p.mappingId);
      mappingForFailure = mapping;
      const decided = await decideLines(tx, mapping.def, p.text);
      totalForFailure = decided.length;
      const counts = countsOf(decided);
      const personId = await actorPersonId(tx, ctx);
      const [run] = await tx
        .insert(clockingImportRun)
        .values({
          tenantId: ctx.tenantId,
          mappingId: mapping.id,
          mappingName: mapping.name,
          mappingSnapshot: mapping.snapshot,
          fileName,
          fileBytes: Math.max(0, Math.floor(Number(p.fileBytes) || 0)),
          fileSha256: fileSha,
          createdByPersonId: personId,
          createdByUserId: ctx.userId ?? null,
          totalLines: counts.total,
          validLines: counts.valid,
          importedLines: 0,
          duplicateLines: counts.duplicate,
          unmatchedCardLines: counts.unmatchedCard,
          invalidDatetimeLines: counts.invalidDateTime,
          otherErrorLines: counts.otherError,
        })
        .returning({ id: clockingImportRun.id });

      // Write, one business day at a time, in real-time order within the day.
      const byDay = new Map<string, Decided[]>();
      for (const d of decided) {
        if (d.result !== 'imported') continue;
        const k = `${d.emp!.id}|${d.day}`;
        const arr = byDay.get(k) ?? [];
        arr.push(d);
        byDay.set(k, arr);
      }
      const punchIdOf = new Map<Decided, string>();
      const groups = [...byDay.values()];
      for (const ds of groups) {
        ds.sort((a, b) => punchOrderKey(a.read.date!, a.read.time!) - punchOrderKey(b.read.date!, b.read.time!) || a.read.lineNo - b.read.lineNo);
      }
      const written = await addImportedPunchesBatchTx(tx, ctx, {
        runId: run.id,
        days: groups.map((ds) => ({
          employmentId: ds[0].emp!.id,
          day: ds[0].day!,
          punches: ds.map((d) => ({ time: d.read.time!, direction: d.direction! })),
        })),
      });
      groups.forEach((ds, gi) => ds.forEach((d, i) => punchIdOf.set(d, written.punchIds[gi][i])));
      const changed = groups.map((ds) => ({ employmentId: ds[0].emp!.id, companyId: ds[0].emp!.companyId, date: ds[0].day! }));

      // The log lines — every data line, raw text only for a line that was not imported.
      for (const part of chunks(decided, 500)) {
        await tx.insert(clockingImportLine).values(
          part.map((d) => ({
            tenantId: ctx.tenantId,
            runId: run.id,
            lineNo: d.read.lineNo,
            cardRef: d.read.cardRef.slice(0, 100),
            employmentId: d.emp?.id ?? null,
            deviceRef: d.read.deviceRef?.slice(0, 100) ?? null,
            punchDate: d.day ?? d.read.date,
            punchTime: d.read.time,
            direction: d.direction,
            result: d.result,
            message: (d.detail || (d.result === 'invalid_date' ? d.read.dateText : d.result === 'invalid_time' ? d.read.timeText : '')).slice(0, 200),
            rawLine: d.result === 'imported' ? null : d.read.raw.slice(0, 500),
            attendancePunchId: punchIdOf.get(d) ?? null,
          })),
        );
      }

      const employeesUpdated = new Set(changed.map((c) => c.employmentId)).size;
      await tx
        .update(clockingImportRun)
        .set({ importedLines: punchIdOf.size, daysUpdated: changed.length, employeesUpdated })
        .where(eq(clockingImportRun.id, run.id));

      // Processed pay runs that own a changed day: raise their needs-recalculation notice (no payslip is
      // edited). Draft and closed runs are no-ops there; closed days never reached this point.
      const byCompany = new Map<string, { employmentId: string; date: string }[]>();
      for (const c of changed) {
        const arr = byCompany.get(c.companyId) ?? [];
        arr.push({ employmentId: c.employmentId, date: c.date });
        byCompany.set(c.companyId, arr);
      }
      const marked: { batchId: string; employmentIds: string[] }[] = [];
      for (const [companyId, entries] of byCompany) {
        for (const b of await batchesCoveringAttendanceDates(tx, { companyId, entries })) {
          await markBatchNeedsRecalc(tx, ctx, { batchId: b.batchId, employmentIds: b.employmentIds });
          marked.push({ batchId: b.batchId, employmentIds: b.employmentIds });
        }
      }

      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'attendance-clocking-import',
        aggregateId: run.id,
        eventType: 'attendance-clocking-import.run',
        actor: actorOf(ctx),
        // Counts only: the per-line detail is the log table's, and no subject (a run spans employees).
        payload: {
          runId: run.id,
          mappingId: mapping.id,
          mappingName: mapping.name,
          fileName,
          totalLines: counts.total,
          importedLines: punchIdOf.size,
          duplicateLines: counts.duplicate,
          unmatchedCardLines: counts.unmatchedCard,
          invalidDatetimeLines: counts.invalidDateTime,
          otherErrorLines: counts.otherError,
          daysUpdated: changed.length,
          employeesUpdated,
          recalcBatchIds: marked.map((m) => m.batchId),
        },
      });
      const imported = punchIdOf.size;
      return {
        runId: run.id,
        status: deriveStatus({ failureReason: null, imported, failed: counts.total - imported }),
        counts,
        imported,
        daysUpdated: changed.length,
        failureReason: null,
      };
    });
  } catch (e) {
    if (e instanceof ClockingImportError) throw e;
    const reason = String((e as Error)?.message ?? e).slice(0, 500) || 'Unknown error';
    const runId = await recordFailedRun(ctx, {
      mapping: mappingForFailure,
      mappingIdAsked: p.mappingId,
      fileName,
      fileBytes: p.fileBytes,
      fileSha,
      total: totalForFailure,
      reason,
    });
    return {
      runId,
      status: 'failed',
      counts: { total: totalForFailure, valid: 0, duplicate: 0, unmatchedCard: 0, invalidDateTime: 0, otherError: 0, employees: 0, firstDate: null, lastDate: null },
      imported: 0,
      daysUpdated: 0,
      failureReason: reason,
    };
  }
}

/** Best-effort: losing the Failed row is a lesser fault than masking the failure itself. */
async function recordFailedRun(
  ctx: SessionContext,
  p: {
    mapping: { id: string | null; name: string; snapshot: Record<string, unknown> } | null;
    mappingIdAsked: string;
    fileName: string;
    fileBytes: number;
    fileSha: string;
    total: number;
    reason: string;
  },
): Promise<string | null> {
  try {
    return await withTenant(ctx, async (tx) => {
      const personId = await actorPersonId(tx, ctx);
      const [row] = await tx
        .insert(clockingImportRun)
        .values({
          tenantId: ctx.tenantId,
          mappingId: p.mapping?.id ?? null,
          mappingName: p.mapping?.name ?? (p.mappingIdAsked === BUILTIN_MAPPING_ID ? BUILTIN_MAPPING_NAME : ''),
          mappingSnapshot: p.mapping?.snapshot ?? {},
          fileName: p.fileName,
          fileBytes: Math.max(0, Math.floor(Number(p.fileBytes) || 0)),
          fileSha256: p.fileSha,
          createdByPersonId: personId,
          createdByUserId: ctx.userId ?? null,
          totalLines: p.total,
          failureReason: p.reason,
        })
        .returning({ id: clockingImportRun.id });
      return row?.id ?? null;
    });
  } catch {
    return null;
  }
}

// ─── Import logs ──────────────────────────────────────────────────────────────────────────────────────

export type ClockingImportStatus = 'successful' | 'completed_with_errors' | 'no_records' | 'failed';

/** Status is DERIVED, never stored (0341): stopped → Failed; nothing imported → No Records Imported;
 *  nothing failed → Successful; else Completed with Errors. */
export function deriveStatus(p: { failureReason: string | null; imported: number; failed: number }): ClockingImportStatus {
  if (p.failureReason) return 'failed';
  if (p.imported === 0) return 'no_records';
  if (p.failed === 0) return 'successful';
  return 'completed_with_errors';
}

export type ClockingImportRunRow = {
  id: string;
  createdAt: Date;
  fileName: string;
  fileBytes: number;
  mappingId: string | null;
  mappingName: string;
  userName: string | null;
  totalLines: number;
  validLines: number;
  importedLines: number;
  duplicateLines: number;
  unmatchedCardLines: number;
  invalidDatetimeLines: number;
  otherErrorLines: number;
  failedLines: number;
  daysUpdated: number;
  employeesUpdated: number;
  failureReason: string | null;
  status: ClockingImportStatus;
};

const runSelect = {
  id: clockingImportRun.id,
  createdAt: clockingImportRun.createdAt,
  fileName: clockingImportRun.fileName,
  fileBytes: clockingImportRun.fileBytes,
  mappingId: clockingImportRun.mappingId,
  mappingName: clockingImportRun.mappingName,
  userName: person.fullName,
  totalLines: clockingImportRun.totalLines,
  validLines: clockingImportRun.validLines,
  importedLines: clockingImportRun.importedLines,
  duplicateLines: clockingImportRun.duplicateLines,
  unmatchedCardLines: clockingImportRun.unmatchedCardLines,
  invalidDatetimeLines: clockingImportRun.invalidDatetimeLines,
  otherErrorLines: clockingImportRun.otherErrorLines,
  daysUpdated: clockingImportRun.daysUpdated,
  employeesUpdated: clockingImportRun.employeesUpdated,
  failureReason: clockingImportRun.failureReason,
};

const toRunRow = (r: Omit<ClockingImportRunRow, 'status' | 'failedLines'>): ClockingImportRunRow => {
  // Failed = duplicates + unmatched card ids + invalid date/time + other errors (the reporter's sum).
  const failedLines = r.failureReason ? 0 : r.duplicateLines + r.unmatchedCardLines + r.invalidDatetimeLines + r.otherErrorLines;
  return { ...r, failedLines, status: deriveStatus({ failureReason: r.failureReason, imported: r.importedLines, failed: failedLines }) };
};

export const IMPORT_RUN_LIST_LIMIT = 200;

export function listClockingImportRuns(ctx: SessionContext, opts?: { limit?: number }): Promise<ClockingImportRunRow[]> {
  const limit = Math.max(1, Math.min(IMPORT_RUN_LIST_LIMIT, opts?.limit ?? IMPORT_RUN_LIST_LIMIT));
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select(runSelect)
      .from(clockingImportRun)
      .leftJoin(person, eq(person.id, clockingImportRun.createdByPersonId))
      .orderBy(desc(clockingImportRun.createdAt), desc(clockingImportRun.id))
      .limit(limit);
    return rows.map(toRunRow);
  });
}

export type ClockingImportLineRow = {
  lineNo: number;
  cardRef: string;
  employeeName: string | null;
  punchDate: string | null;
  punchTime: string | null;
  direction: 'in' | 'out' | null;
  result: ClockingImportLineResult;
  message: string;
  rawLine: string | null;
};

export function getClockingImportRun(
  ctx: SessionContext,
  runId: string,
): Promise<{ run: ClockingImportRunRow; lines: ClockingImportLineRow[] } | null> {
  return withTenant(ctx, async (tx) => {
    const [r] = await tx
      .select(runSelect)
      .from(clockingImportRun)
      .leftJoin(person, eq(person.id, clockingImportRun.createdByPersonId))
      .where(eq(clockingImportRun.id, runId))
      .limit(1);
    if (!r) return null;
    const emp = person;
    const lines = await tx
      .select({
        lineNo: clockingImportLine.lineNo,
        cardRef: clockingImportLine.cardRef,
        employeeName: emp.fullName,
        punchDate: clockingImportLine.punchDate,
        punchTime: clockingImportLine.punchTime,
        direction: clockingImportLine.direction,
        result: clockingImportLine.result,
        message: clockingImportLine.message,
        rawLine: clockingImportLine.rawLine,
      })
      .from(clockingImportLine)
      .leftJoin(employment, eq(employment.id, clockingImportLine.employmentId))
      .leftJoin(emp, eq(emp.id, employment.personId))
      .where(eq(clockingImportLine.runId, runId))
      .orderBy(clockingImportLine.lineNo, clockingImportLine.id);
    return { run: toRunRow(r), lines };
  });
}
