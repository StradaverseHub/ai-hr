/** Named prepared statements for the few large read statements whose planning dominated their cost (ADR 0181,
 * planning cost, 26 November 2026).
 *
 * drizzle-orm 0.45.2 sends every statement through postgres.js `unsafe(query, params)`, and `unsafe` defaults to
 * `prepare: false`: an unnamed statement, parsed and planned again on every call. The driver also describes an unnamed
 * statement before binding it, so it is parsed twice per call. On staging (24 to 26 November 2026) the combined
 * statements built for Home, Today and the bell were planned on every call: the account task statement for 106 to
 * 269 ms, the Before payroll statement for 175 ms, the request preamble for 32 ms and the recruitment to-dos for
 * 43 ms (against 0.2 ms to run).
 *
 * `executePrepared` sends one statement as a NAMED prepared statement instead (`prepare: true`). The driver keeps it
 * per connection, keyed by its exact text and parameter types, so later calls only bind and execute. PostgreSQL then
 * plans the first five executions on a server connection with their values, as before, and from the sixth uses one
 * generic plan when it is estimated no dearer than those, skipping planning. Through PgBouncer (transaction mode,
 * 1.21 or later, max_prepared_statements, deploy/pgbouncer) the pooler prepares it once on each server connection it
 * reaches, so the plan cache is shared by every client of that server connection.
 *
 * What does not change: the text, the parameters, their types and the rows. Row security reads the transaction's
 * settings when the plan runs, not when it is made, and PostgreSQL replans a cached plan for another role or after any
 * change to a table, policy or function it uses. A statement whose text is built from data (an id list spelled out as
 * parameters) would make one cached statement per length: every caller passes lists as one array parameter
 * (db/sql-arrays.ts), so each statement has a handful of shapes. Use it only for a statement a scale test shows is
 * faster prepared (test/planning-cost-prepared-reads.test.ts): a generic plan can be slower for some statements. */
import type {SQL} from 'drizzle-orm';

/** The options a prepared read hands the driver. One frozen object, so the shared read snapshot's driver
 * (db/shared-read.ts) can tell a prepared read, which it still memoizes, from any other option. */
export const PREPARED_READ_OPTIONS = Object.freeze({prepare: true as const});
export const isPreparedReadOptions = (options: unknown): boolean => options === PREPARED_READ_OPTIONS;

type Driver = {unsafe(query: string, params?: unknown[], options?: unknown): PromiseLike<unknown>};
type DrizzleTransaction = {dialect: {sqlToQuery(query: SQL): {sql: string; params: unknown[]}}; session: {client: Driver}};

/** AIHR_PREPARED_READS=off (exactly `off`; anything else, or unset, is on) sends these statements unnamed again, exactly
 * as before: the switch back if a pooler or server misbehaves with named statements. Read on every call from the
 * process environment, which the services load from their env file at start, so changing it takes a restart of the
 * web service (and of any other process that runs these reads, such as the payroll loop tick). */
export function preparedReadsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.AIHR_PREPARED_READS !== 'off';
}

/** The settings statement of a read whose prepared statement must use its generic plan from the first call: in auto
 * mode PostgreSQL estimated the account task statement's generic plan dearer than its custom plans and planned every
 * call again (90 ms of 177 ms for a manager on the scale fixture), although the generic plan runs as fast. One
 * simple-protocol statement in place of the owner's `set local jit=off`, so it costs no extra round trip; a shared
 * read carrier holds both settings (db/shared-read.ts passedSettings) and a Today carrier's identity statement already
 * set them (home-request-preamble.ts `genericPlans`). Transaction-local: cleared at COMMIT or ROLLBACK, so a pooled
 * server connection never carries it to another client. With AIHR_PREPARED_READS=off, only `set local jit=off`. */
export function genericPlanSettingsStatement(env: Record<string, string | undefined> = process.env): string {
  return preparedReadsEnabled(env) ? 'set local jit=off; set local plan_cache_mode=force_generic_plan' : 'set local jit=off';
}

/** How many distinct statement texts of each prepared read one process sends as named statements. A named statement
 * keeps its plans on every backend that ran it until the connection ends (six hours): measured on the scale fixture
 * (test/planning-cost-prepared-reads.test.ts, which checks these figures), about 7.0 MB for an account task text and
 * for the largest Before payroll text, at most 1.22 MB for a request preamble, 0.92 MB for the recruitment to-dos,
 * 1.34 MB and 0.40 MB for the two payroll freshness reads. Each of these statements has several texts (module
 * switches, roles, sections), and an unbounded set would grow on every backend. So the first texts of each label a
 * process sees are prepared and every later one is sent unnamed, exactly as before. Every connection of the process
 * then holds at most these texts, so one backend retains at most PREPARED_READ_BACKEND_BOUND_BYTES. Through PgBouncer
 * a server connection serves every web process: multiply by the number of web processes. */
export const PREPARED_READ_TEXT_LIMITS = Object.freeze({
  'account-tasks': 2,
  'before-payroll': 2,
  'request-preamble': 3,
  'recruitment-personal-todos': 4,
  'payroll-freshness-runs': 1,
  'payroll-freshness-files': 1,
} as const);
export type PreparedReadLabel = keyof typeof PREPARED_READ_TEXT_LIMITS;
/** The largest retained plan memory measured for one text of each label, in bytes, rounded up. */
export const PREPARED_READ_MEASURED_TEXT_BYTES: Readonly<Record<PreparedReadLabel, number>> = Object.freeze({
  'account-tasks': 7_100_000,
  'before-payroll': 7_100_000,
  'request-preamble': 1_300_000,
  'recruitment-personal-todos': 1_000_000,
  'payroll-freshness-runs': 1_400_000,
  'payroll-freshness-files': 450_000,
});
/** Retained plan memory one backend can hold for these statements: the limits times the measured sizes (about
 * 39 MB), with a 25% margin for plans that grow with later migrations. The scale test fails if a measured text
 * exceeds its recorded size. */
export const PREPARED_READ_BACKEND_BOUND_BYTES = Math.ceil(1.25 * (Object.keys(PREPARED_READ_TEXT_LIMITS) as PreparedReadLabel[])
  .reduce((sum, label) => sum + PREPARED_READ_TEXT_LIMITS[label] * PREPARED_READ_MEASURED_TEXT_BYTES[label], 0));

/** The texts admitted as named statements in this process, per label. */
const admitted = new Map<PreparedReadLabel, Set<string>>();
function admit(label: PreparedReadLabel, text: string): boolean {
  let texts = admitted.get(label);
  if (!texts) admitted.set(label, texts = new Set());
  if (texts.has(text)) return true;
  if (texts.size >= PREPARED_READ_TEXT_LIMITS[label]) return false;
  texts.add(text);
  return true;
}
/** Tests only: forget which texts were admitted (a new process). */
export function __resetPreparedReadAdmissionForTests(): void { admitted.clear(); }

/** Statements sent through `executePrepared` in this process, by label and how they were sent: prepared, unnamed
 * because the switch is off, or unnamed because the label's text limit was reached (diagnostics and tests). */
const sent = new Map<string, {prepared: number; unnamed: number; overflow: number}>();
export function preparedReadCounts(): ReadonlyMap<string, {prepared: number; unnamed: number; overflow: number}> {
  return new Map([...sent].map(([label, counts]) => [label, {...counts}]));
}

/** `tx.execute(query)` as a named prepared statement: the same text and parameters, the same rows (the driver's own
 * row list, as drizzle's `execute` returns it). `tx` is a drizzle postgres-js transaction, or the shared snapshot's
 * carrier transaction, whose driver passes the option through. Sent unnamed, as before, when AIHR_PREPARED_READS=off
 * or when the label's text limit is reached. */
export async function executePrepared<T extends Record<string, unknown>>(tx: object, query: SQL, label: PreparedReadLabel): Promise<T[]> {
  const {dialect, session} = tx as unknown as DrizzleTransaction;
  const {sql: text, params} = dialect.sqlToQuery(query);
  const enabled = preparedReadsEnabled();
  const prepared = enabled && admit(label, text);
  const counts = sent.get(label) ?? {prepared: 0, unnamed: 0, overflow: 0};
  if (prepared) counts.prepared++; else if (enabled) counts.overflow++; else counts.unnamed++;
  sent.set(label, counts);
  return (await (prepared ? session.client.unsafe(text, params, PREPARED_READ_OPTIONS) : session.client.unsafe(text, params))) as T[];
}
