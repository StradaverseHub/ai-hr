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

/** AIHR_PREPARED_READS=off sends these statements unnamed again, exactly as before, without a deploy: the switch back if
 * a pooler or server misbehaves with named statements. Read on every call. */
export function preparedReadsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.AIHR_PREPARED_READS !== 'off';
}

/** Statements sent through `executePrepared` in this process, by the label the caller names and how they were sent
 * (diagnostics and tests). */
const sent = new Map<string, {prepared: number; unnamed: number}>();
export function preparedReadCounts(): ReadonlyMap<string, {prepared: number; unnamed: number}> {
  return new Map([...sent].map(([label, counts]) => [label, {...counts}]));
}

/** `tx.execute(query)` as a named prepared statement: the same text and parameters, the same rows (the driver's own
 * row list, as drizzle's `execute` returns it). `tx` is a drizzle postgres-js transaction, or the shared snapshot's
 * carrier transaction, whose driver passes the option through. `label` names the statement in preparedReadCounts. */
export async function executePrepared<T extends Record<string, unknown>>(tx: object, query: SQL, label: string): Promise<T[]> {
  const {dialect, session} = tx as unknown as DrizzleTransaction;
  const {sql: text, params} = dialect.sqlToQuery(query);
  const prepared = preparedReadsEnabled();
  const counts = sent.get(label) ?? {prepared: 0, unnamed: 0};
  if (prepared) counts.prepared++; else counts.unnamed++;
  sent.set(label, counts);
  return (await (prepared ? session.client.unsafe(text, params, PREPARED_READ_OPTIONS) : session.client.unsafe(text, params))) as T[];
}
