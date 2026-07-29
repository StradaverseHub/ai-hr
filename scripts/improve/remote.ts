/**
 * Improvement-loop ⇄ server bridge (ADR-0044, IL-2). Pulls feedback from the DEPLOYED app's database and
 * pushes plans / deployment status back. psql runs ON THE SERVER (sourcing its own .env.production), so
 * the DB credentials never leave the box — only SQL goes up and JSON/rows come back, over key-based SSH.
 *
 * Configure the host via env (defaults match the gated demo): IMPROVE_SSH_HOST / _PORT / _USER, and
 * IMPROVE_REMOTE_DIR (the app dir on the server, default /opt/ai-hr).
 *
 * NOTE: requires the feedback module (migrations 0093/0094) to be deployed on the server first — until
 * then there is no feedback_request table to pull from.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const HOST = process.env.IMPROVE_SSH_HOST ?? '10.20.30.20';
const PORT = process.env.IMPROVE_SSH_PORT ?? '8288';
const USER = process.env.IMPROVE_SSH_USER ?? 'ubuntu';
const DIR = process.env.IMPROVE_REMOTE_DIR ?? '/opt/ai-hr';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertUuid = (s: string, label: string) => {
  if (!UUID.test(s)) throw new Error(`${label} is not a valid UUID: ${s}`);
};
/** A dollar-quote tag that cannot appear inside the payload, so arbitrary plan text is injection-safe. */
const dq = (s: string): string => {
  let tag = 'fb';
  while (s.includes(`$${tag}$`)) tag += 'x';
  return `$${tag}$${s}$${tag}$`;
};

/**
 * Wrap SQL that touches a table which may not exist on the server yet.
 *
 * The improvement loop runs the repo's CURRENT code against the DEPLOYED database, so any statement
 * naming a table introduced by an undeployed migration fails at PARSE time and aborts the whole
 * transaction — taking the block/unblock it was riding along with it. EXECUTE defers parsing to run time,
 * and to_regclass takes the table name as text, so neither is parsed until the guard has already said the
 * table is there. `body` must therefore be a single-quoted SQL string plus its USING arguments.
 *
 * The dollar-quote tag is chosen the same way dq() chooses its own — a payload containing the tag would
 * otherwise end the block early.
 */
const guardedOn = (table: string, body: string): string => {
  let tag = 'blk';
  while (body.includes(`$${tag}$`)) tag += 'x';
  return `DO $${tag}$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN EXECUTE ${body}; END IF; END $${tag}$;`;
};

/** Run a remote shell command (psql sources the server's own .env.production). `stdin` feeds `psql -f -`. */
function remote(cmd: string, stdin?: string): string {
  const full = `cd ${DIR} && set -a; . ./.env.production; set +a; ${cmd}`;
  return execFileSync('ssh', ['-p', PORT, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', `${USER}@${HOST}`, full], {
    input: stdin,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** One time this item was parked on a question, and what was said back (migration 0323). */
export type RemoteBlockEpisode = {
  question: string;
  asked_at: string;
  answer: string | null;
  resolved_at: string | null;
};

export type RemoteFeedback = {
  id: string;
  tenant_id: string;
  reporter_employment_id: string;
  category: string;
  title: string;
  description: string;
  expected_behavior: string | null;
  expected_function: string | null;
  status: string;
  plan: string | null;
  plan_revision: number;
  contest_reason: string | null;
  build_ref: string | null;
  /**
   * THE ANSWER, where a build agent will actually see it (0323).
   *
   * `blocked_reason` is CLEARED when an item is unblocked, so by the time an answered item reaches
   * pull-approved the question that shaped it is gone from feedback_request entirely — and the answer,
   * had it been kept only in the `feedback.unblocked` domain_event, would never be selected here at all.
   * Every column in this type comes from feedback_request; nothing in the loop reads the event stream.
   * So an item that says "build this, and by the way the reporter told us they file EPF via i-Akaun with
   * a fixed-width text file" only says it if the answer travels on the row. This is that.
   *
   * Empty on a server that predates the feedback_block table — see blockTrails().
   */
  block_trail: RemoteBlockEpisode[];
};

const SELECT_COLS =
  'id, tenant_id, reporter_employment_id, category, title, description, expected_behavior, expected_function, status, plan, plan_revision, contest_reason, build_ref';

/**
 * The two queries a pull actually issues, as text.
 *
 * EXPORTED SO A TEST CAN RUN THE REAL THING. "The answer reaches the build agent" is a claim about SQL
 * that only ever executes against production over SSH; a test that retypes an equivalent query proves
 * only that the test author can write SQL. These are the exact strings sent.
 */
export const feedbackSelectSql = (whereStatus: string): string =>
  `select coalesce(json_agg(row_to_json(t)), '[]') from (select ${SELECT_COLS} from feedback_request where status in (${whereStatus}) order by created_at) t`;

export function blockTrailSql(ids: string[]): string {
  ids.forEach((id) => assertUuid(id, 'feedback id'));
  const list = ids.map((id) => `'${id}'`).join(',');
  return (
    `select coalesce(json_agg(row_to_json(t)), '[]') from (` +
    `select feedback_request_id, question, asked_at, answer, resolved_at from feedback_block ` +
    `where feedback_request_id in (${list}) order by asked_at) t`
  );
}

/**
 * Fetch the block Q&A for the given items, keyed by feedback id.
 *
 * A SEPARATE statement rather than a subquery in SELECT_COLS, and that is load-bearing: this runs against
 * the DEPLOYED database, which does not have feedback_block until the migration introducing it has been
 * released. Postgres parses a statement whole, so a `to_regclass(...) IS NOT NULL` guard inside the same
 * query would still fail at parse time and take the entire pull down with it. Merging this change would
 * otherwise break `improve:pull` against production in the window before its own migration ships.
 *
 * The degradation is announced on stderr, never silent: an empty trail because the table is missing and
 * an empty trail because the item was never blocked must not look the same to whoever is reading.
 */
function blockTrails(ids: string[]): Map<string, RemoteBlockEpisode[]> {
  const byItem = new Map<string, RemoteBlockEpisode[]>();
  if (ids.length === 0) return byItem;
  const sql = blockTrailSql(ids);
  let out: string;
  try {
    out = remote(`psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -tAc ${shellQuote(sql)}`).trim();
  } catch (e) {
    const stderr = String((e as { stderr?: Buffer | string }).stderr ?? '');
    if (/relation "feedback_block" does not exist/i.test(stderr)) {
      process.stderr.write(
        'warning: the server has no feedback_block table yet (migration 0323 is not deployed) — ' +
          'block questions and answers are NOT included in this pull.\n',
      );
      return byItem;
    }
    throw e;
  }
  const rows = JSON.parse(out || '[]') as (RemoteBlockEpisode & { feedback_request_id: string })[];
  for (const { feedback_request_id, ...ep } of rows) {
    const list = byItem.get(feedback_request_id) ?? [];
    list.push(ep);
    byItem.set(feedback_request_id, list);
  }
  return byItem;
}

function selectFeedback(whereStatus: string): RemoteFeedback[] {
  const out = remote(`psql "$MIGRATION_DATABASE_URL" -tAc ${shellQuote(feedbackSelectSql(whereStatus))}`).trim();
  const rows = JSON.parse(out || '[]') as RemoteFeedback[];
  const trails = blockTrails(rows.map((r) => r.id));
  // Always present, even as []. An absent key would make "never blocked" indistinguishable from "this
  // pull predates block trails" at the point of use, and a build agent skimming the JSON would read the
  // absence as "no question was asked" rather than "look again".
  for (const r of rows) r.block_trail = trails.get(r.id) ?? [];
  return rows;
}

/** Items awaiting a (re)plan. */
export const pullPlannable = (): RemoteFeedback[] => selectFeedback(`'open','contested'`);
/**
 * Items the reporter has approved AND that are actually startable.
 *
 * `blocked` is excluded on purpose. It is approved work whose plan is agreed but which waits on a
 * question only the reporter can answer, so returning it here would put it in front of a build agent
 * every round and invite exactly the guess the block exists to prevent. Use pullBlocked() to see them.
 */
export const pullApproved = (): RemoteFeedback[] => selectFeedback(`'approved'`);

/** Approved but waiting on something outside the item — see the `blocked` status note in db/schema.ts. */
export const pullBlocked = (): RemoteFeedback[] => selectFeedback(`'blocked'`);

/**
 * Raise a NEW feedback item on the deployed board on a reporter's behalf (operator-side), for when a
 * decision the pipeline uncovered needs the reporter to own it — e.g. two approved items that turned out
 * to contradict each other. Mirrors core/feedback.ts submitFeedback EXACTLY: one feedback_request row
 * (status defaults to 'open', awaiting a plan) + one feedback.submitted domain_event, same columns the
 * app sets, so the substrate/hash-chain trigger treats it identically to an in-app submission. The item
 * then flows the normal path: plan → the reporter approves or rejects on /feedback.
 */
export function raiseFeedback(p: {
  tenantId: string;
  reporterEmploymentId: string;
  reporterUserId?: string | null;
  category: 'issue' | 'enhancement' | 'new_function';
  title: string;
  description: string;
  expectedBehavior?: string | null;
  expectedFunction?: string | null;
}): { id: string } {
  assertUuid(p.tenantId, 'tenant id');
  assertUuid(p.reporterEmploymentId, 'reporter employment id');
  if (p.reporterUserId) assertUuid(p.reporterUserId, 'reporter user id');
  if (!['issue', 'enhancement', 'new_function'].includes(p.category)) throw new Error(`bad category: ${p.category}`);
  const title = p.title.trim();
  const description = p.description.trim();
  if (!title) throw new Error('A title is required.');
  if (!description) throw new Error('A description is required.');
  const id = randomUUID();
  const ruser = p.reporterUserId ? `'${p.reporterUserId}'` : 'NULL';
  const actorType = p.reporterUserId ? 'user' : 'system';
  const actorId = p.reporterUserId ? `'${p.reporterUserId}'` : 'NULL';
  const eb = p.expectedBehavior?.trim() ? dq(p.expectedBehavior.trim()) : 'NULL';
  const ef = p.expectedFunction?.trim() ? dq(p.expectedFunction.trim()) : 'NULL';
  const sql = [
    'BEGIN;',
    `INSERT INTO feedback_request (id, tenant_id, reporter_employment_id, reporter_user_id, category, title, description, expected_behavior, expected_function, status) ` +
      `VALUES ('${id}', '${p.tenantId}', '${p.reporterEmploymentId}', ${ruser}, '${p.category}', ${dq(title)}, ${dq(description)}, ${eb}, ${ef}, 'open');`,
    `INSERT INTO domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, subject_employment_id, payload) ` +
      `VALUES ('${p.tenantId}', 'feedback', '${id}', 'feedback.submitted', '${actorType}', ${actorId}, '${p.reporterEmploymentId}', ${dq(JSON.stringify({ category: p.category, title, via: 'operator-raised' }))}::jsonb);`,
    'COMMIT;',
  ].join('\n');
  remote(`psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f -`, sql);
  return { id };
}

/** Push a refined plan back (UPDATE + a feedback.plan.drafted domain_event — the substrate stays whole). */
export function pushPlan(p: {
  id: string;
  tenantId: string;
  reporterEmploymentId: string;
  plan: string;
  model: string;
}): void {
  assertUuid(p.id, 'feedback id');
  assertUuid(p.tenantId, 'tenant id');
  assertUuid(p.reporterEmploymentId, 'reporter employment id');
  const sql = [
    'BEGIN;',
    // Close whatever version is still open. A contest already stamped its own outcome WITH the reporter's
    // words, and `outcome IS NULL` keeps this from overwriting it — a re-plan must never erase the
    // objection that prompted it, which is precisely how the old history was lost.
    `UPDATE feedback_plan_revision SET outcome = 'superseded', outcome_at = now() WHERE feedback_request_id = '${p.id}' AND outcome IS NULL;`,
    `UPDATE feedback_request SET plan = ${dq(p.plan)}, plan_revision = plan_revision + 1, plan_model = ${dq(p.model)}, contest_reason = NULL, status = 'planned', updated_at = now() WHERE id = '${p.id}';`,
    // The history row, written in the SAME transaction as the plan itself so the two cannot diverge.
    // Without this the operator loop would push plans straight past the history the reporter reads.
    `INSERT INTO feedback_plan_revision (tenant_id, feedback_request_id, revision, plan, plan_model) SELECT '${p.tenantId}', '${p.id}', plan_revision, ${dq(p.plan)}, ${dq(p.model)} FROM feedback_request WHERE id = '${p.id}' ON CONFLICT (feedback_request_id, revision) DO NOTHING;`,
    `INSERT INTO domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, subject_employment_id, payload) VALUES ('${p.tenantId}', 'feedback', '${p.id}', 'feedback.plan.drafted', 'agent', '${p.reporterEmploymentId}', ${dq(JSON.stringify({ model: p.model, via: 'improvement-loop' }))}::jsonb);`,
    'COMMIT;',
  ].join('\n');
  remote(`psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f -`, sql);
}

/**
 * Park an approved item on an unanswered question (status → blocked + a feedback.blocked event).
 *
 * This exists so parking an item is a COMMAND rather than hand-written SQL over SSH. The board learned
 * about blocked items before this did, and the gap was filled by ad-hoc UPDATEs — which append no event,
 * so the reason for the park lived only in whichever session ran them.
 *
 * The `AND status = 'approved'` guard is the same one every mutator here carries: a no-op beats
 * clobbering an item someone already moved on.
 */
export function markBlocked(p: {
  id: string;
  tenantId: string;
  reporterEmploymentId: string;
  reason: string;
  blockedById?: string | null;
}): void {
  remote(`psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f -`, markBlockedSql(p));
}

/**
 * The SQL markBlocked sends, as a string.
 *
 * SEPARATED FROM THE SSH CALL SO IT CAN BE EXECUTED IN A TEST. Everything else in this file is only ever
 * exercised against production, which is a poor place to discover that a dollar-quoted DO block does not
 * parse — and the block-episode insert below is exactly the kind of nested quoting that reads fine and
 * does not run. The test runs this text against a real database.
 */
export function markBlockedSql(p: {
  id: string;
  tenantId: string;
  reporterEmploymentId: string;
  reason: string;
  blockedById?: string | null;
}): string {
  assertUuid(p.id, 'feedback id');
  assertUuid(p.tenantId, 'tenant id');
  assertUuid(p.reporterEmploymentId, 'reporter employment id');
  if (p.blockedById) assertUuid(p.blockedById, 'blocked-by id');
  if (!p.reason?.trim()) throw new Error('A reason is required — say what the item is waiting on.');
  const blocker = p.blockedById ? `'${p.blockedById}'` : 'NULL';
  const sql = [
    'BEGIN;',
    `UPDATE feedback_request SET status = 'blocked', blocked_reason = ${dq(p.reason)}, blocked_by_id = ${blocker}, updated_at = now() WHERE id = '${p.id}' AND status = 'approved';`,
    // Open the block episode (0323) in the same transaction, so the QUESTION survives the unblock that
    // will later clear blocked_reason — and so the reporter's in-app answer has a row to close. The
    // EXISTS re-checks the guard above: if the item was not `approved` nothing was parked, and an episode
    // for a park that did not happen would be a fabricated question.
    guardedOn(
      'feedback_block',
      `'INSERT INTO feedback_block (tenant_id, feedback_request_id, question, blocked_by_id) ` +
        `SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM feedback_request WHERE id = $2 AND status = ''blocked'') ` +
        `ON CONFLICT DO NOTHING' USING '${p.tenantId}'::uuid, '${p.id}'::uuid, ${dq(p.reason.trim())}::text, ${blocker}::uuid`,
    ),
    `INSERT INTO domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, subject_employment_id, payload) VALUES ('${p.tenantId}', 'feedback', '${p.id}', 'feedback.blocked', 'agent', '${p.reporterEmploymentId}', ${dq(JSON.stringify({ reason: p.reason, blockedById: p.blockedById ?? null, via: 'improvement-loop' }))}::jsonb);`,
    'COMMIT;',
  ].join('\n');
  return sql;
}

/** The question was answered — return the item to the build queue (status → approved). */
export function markUnblocked(p: { id: string; tenantId: string; reporterEmploymentId: string; note?: string | null }): void {
  remote(`psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f -`, markUnblockedSql(p));
}

/** The SQL markUnblocked sends — separated for the same reason as markBlockedSql. */
export function markUnblockedSql(p: {
  id: string;
  tenantId: string;
  reporterEmploymentId: string;
  note?: string | null;
}): string {
  assertUuid(p.id, 'feedback id');
  assertUuid(p.tenantId, 'tenant id');
  assertUuid(p.reporterEmploymentId, 'reporter employment id');
  const sql = [
    'BEGIN;',
    `UPDATE feedback_request SET status = 'approved', blocked_reason = NULL, blocked_by_id = NULL, updated_at = now() WHERE id = '${p.id}' AND status = 'blocked';`,
    // End the episode (0323). The note, where there is one, IS the answer — this is the operator-side twin
    // of the reporter answering in the app. nullif(btrim(...)) keeps a whitespace-only note out: an
    // episode released with nothing said must record NULL, not a blank pretending to be an answer.
    guardedOn(
      'feedback_block',
      `'UPDATE feedback_block SET answer = nullif(btrim($1), ''''), resolved_at = now() ` +
        `WHERE feedback_request_id = $2 AND resolved_at IS NULL' ` +
        `USING ${p.note ? dq(p.note) : 'NULL'}::text, '${p.id}'::uuid`,
    ),
    `INSERT INTO domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, subject_employment_id, payload) VALUES ('${p.tenantId}', 'feedback', '${p.id}', 'feedback.unblocked', 'agent', '${p.reporterEmploymentId}', ${dq(JSON.stringify({ note: p.note ?? null, via: 'improvement-loop' }))}::jsonb);`,
    'COMMIT;',
  ].join('\n');
  return sql;
}

/** Move an approved item into the build (status → building + a feedback.build.started event). */
export function markBuildStarted(p: { id: string; tenantId: string; reporterEmploymentId: string }): void {
  assertUuid(p.id, 'feedback id');
  assertUuid(p.tenantId, 'tenant id');
  assertUuid(p.reporterEmploymentId, 'reporter employment id');
  const sql = [
    'BEGIN;',
    `UPDATE feedback_request SET status = 'building', updated_at = now() WHERE id = '${p.id}' AND status = 'approved';`,
    `INSERT INTO domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, subject_employment_id, payload) VALUES ('${p.tenantId}', 'feedback', '${p.id}', 'feedback.build.started', 'agent', '${p.reporterEmploymentId}', ${dq(JSON.stringify({ via: 'improvement-loop' }))}::jsonb);`,
    'COMMIT;',
  ].join('\n');
  remote(`psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f -`, sql);
}

/** Mark a green build done (status → done + build_ref + a feedback.build.completed event). buildRef = the branch/PR. */
export function markBuildCompleted(p: { id: string; tenantId: string; reporterEmploymentId: string; buildRef: string }): void {
  assertUuid(p.id, 'feedback id');
  assertUuid(p.tenantId, 'tenant id');
  assertUuid(p.reporterEmploymentId, 'reporter employment id');
  const sql = [
    'BEGIN;',
    `UPDATE feedback_request SET status = 'done', build_ref = ${dq(p.buildRef)}, updated_at = now() WHERE id = '${p.id}' AND status = 'building';`,
    `INSERT INTO domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, subject_employment_id, payload) VALUES ('${p.tenantId}', 'feedback', '${p.id}', 'feedback.build.completed', 'agent', '${p.reporterEmploymentId}', ${dq(JSON.stringify({ buildRef: p.buildRef, via: 'improvement-loop' }))}::jsonb);`,
    'COMMIT;',
  ].join('\n');
  remote(`psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f -`, sql);
}

/** Close a released item (status → deployed + a feedback.deployed event). buildRef is the PR/commit link. */
export function markDeployed(p: { id: string; tenantId: string; reporterEmploymentId: string; buildRef: string }): void {
  assertUuid(p.id, 'feedback id');
  assertUuid(p.tenantId, 'tenant id');
  assertUuid(p.reporterEmploymentId, 'reporter employment id');
  const sql = [
    'BEGIN;',
    `UPDATE feedback_request SET status = 'deployed', build_ref = ${dq(p.buildRef)}, decided_at = now(), updated_at = now() WHERE id = '${p.id}';`,
    `INSERT INTO domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, subject_employment_id, payload) VALUES ('${p.tenantId}', 'feedback', '${p.id}', 'feedback.deployed', 'agent', '${p.reporterEmploymentId}', ${dq(JSON.stringify({ buildRef: p.buildRef }))}::jsonb);`,
    'COMMIT;',
  ].join('\n');
  remote(`psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f -`, sql);
}

/** Minimal POSIX single-quote for embedding a SQL string in the remote `psql -tAc '<sql>'`. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
