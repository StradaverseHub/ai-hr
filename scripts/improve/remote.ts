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

/**
 * What the board shows as the reporter for an item the improvement loop raised (0348).
 *
 * The owner's instruction: anything CLAUDE created must say so on the board. Kept here as the single
 * definition — the migration's backfill uses the same string, and test/feedback-reporter-label.test.ts
 * pins that the two agree.
 */
export const OPERATOR_REPORTER_LABEL = 'CLAUDE AI';

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
 * Wrap a plpgsql body in a DO block, picking a tag the body does not contain (as dq does for its own).
 *
 * Block and unblock need ROW_COUNT: their UPDATE is status-guarded, so "did anything move?" is the only
 * honest basis for writing the episode and the event, and for what the CLI tells the operator. A DO block
 * is also a single statement, which is where the atomicity the old BEGIN/COMMIT provided now comes from.
 *
 * WHY THE BODIES BELOW REACH feedback_block THROUGH `to_regclass` + `EXECUTE`, AND MUST KEEP DOING SO:
 * the improvement loop runs the repo's CURRENT code against the DEPLOYED database, so a statement naming
 * a table introduced by an undeployed migration fails at PARSE time and takes the block or unblock it was
 * riding along with it. EXECUTE defers parsing to run time and to_regclass takes the name as text, so
 * neither is parsed until the guard has already said the table is there. This replaced a guardedOn()
 * helper that wrapped each such statement in its own DO block; the hazard it existed for is unchanged.
 */
const doBlock = (body: string): string => {
  let tag = 'mv';
  while (body.includes(`$${tag}$`)) tag += 'x';
  return `DO $${tag}$\n${body}\n$${tag}$;`;
};

/**
 * The outcome protocol shared by the two status mutators that report back.
 *
 * `moved` is ROW_COUNT from the guarded UPDATE; `status` is re-read after it. The final SELECT renders one
 * line for the caller: the new status when the row moved, `unchanged:<status>` when the guard held, and
 * nothing at all for an id that is not on this board. It is a temp table rather than a NOTICE because
 * psql writes notices to stderr and only stdout comes back over ssh.
 */
const OUTCOME_SETUP = [
  'DROP TABLE IF EXISTS pg_temp._improve_outcome;',
  'CREATE TEMP TABLE _improve_outcome (moved boolean NOT NULL, status text);',
].join('\n');
const outcomeRecord = (id: string) =>
  `  INSERT INTO _improve_outcome (moved, status) SELECT n = 1, status FROM feedback_request WHERE id = '${id}';`;
const OUTCOME_READ = [
  "SELECT CASE WHEN moved THEN status ELSE 'unchanged:' || coalesce(status, '?') END FROM _improve_outcome;",
  'DROP TABLE IF EXISTS pg_temp._improve_outcome;',
].join('\n');

/**
 * Read the line the script printed back, and refuse to call a no-op a success.
 *
 * Every mutator here guards its UPDATE on the status it expects, so an item someone else already moved is
 * silently left alone — that part is right. What was wrong is that the CLI then printed its cheerful
 * "blocked <id>" anyway and the operator moved on believing the reporter had been asked something. On
 * 2026-09-29 a park of 70294f7a matched no row (it was `building`), printed success, and the question was
 * never asked. Exported for a unit test: this is the half of that fix that has no database in it.
 */
export function assertMoved(id: string, want: string, out: string, why: string): void {
  const got = out.trim().split('\n').filter(Boolean).pop() ?? '';
  if (got === want) return;
  const state = got.startsWith('unchanged:') ? `still ${got.slice('unchanged:'.length)}` : got || 'not on this board';
  throw new Error(
    `${id} was NOT moved to ${want} — it is ${state}. ${why}. ` +
      'Nothing was recorded: no status change, no episode, no event.',
  );
}

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

/**
 * ONE item by id, WHATEVER its status — including `building`.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────────
 * `pullApproved()` filters `status in ('approved')`, so the moment `build-start` moves an item to
 * `building` the builder can no longer read its own approved plan. On 2026-09-30 four builders were
 * dispatched after their `build-start` and had to work from the parent's brief instead of the contract;
 * one of them reported it, and a hand-rolled `ssh … psql` was refused by the auto-mode classifier as a
 * production read, so there was no route back to the plan text from inside an agent's session.
 *
 * Ordering the parent's calls correctly (capture the plan, dispatch, THEN build-start) is the discipline;
 * this is the safety net, because a discipline that fails silently is not one. It is a read of ONE row by
 * a validated uuid through the same `SELECT_COLS` and the same block-trail fold as every other pull, so
 * it shows a build agent nothing a `pull-approved` a moment earlier would not have shown it.
 */
export const feedbackSelectByIdSql = (id: string): string => {
  assertUuid(id, 'feedback id');
  return `select coalesce(json_agg(row_to_json(t)), '[]') from (select ${SELECT_COLS} from feedback_request where id = '${id}') t`;
};

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

/**
 * One item by id, whatever its status. Returns [] for an unknown id rather than throwing, so a caller can
 * tell "no such item" from "the ssh failed" — the second throws.
 */
export function pullItem(id: string): RemoteFeedback[] {
  const out = remote(`psql "$MIGRATION_DATABASE_URL" -tAc ${shellQuote(feedbackSelectByIdSql(id))}`).trim();
  const rows = JSON.parse(out || '[]') as RemoteFeedback[];
  const trails = blockTrails(rows.map((r) => r.id));
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

export type BoardStatusRow = { status: string; count: number; ids: string[] };

/**
 * Every status with its count and its item ids, newest first. This is the one read that shows
 * `planned`, `building` and `done` — the statuses the pull commands deliberately hide — so a session can
 * see the whole board in one call instead of inferring the hidden statuses from memory.
 */
export function boardStatus(): BoardStatusRow[] {
  const sql = `select coalesce(json_agg(t), '[]'::json) from (
    select status, count(*)::int as count,
           array_agg(left(id::text, 8) order by updated_at desc) as ids
    from feedback_request group by status order by status) t`;
  const out = remote(`psql "$MIGRATION_DATABASE_URL" -tAc ${shellQuote(sql)}`).trim();
  return JSON.parse(out || '[]') as BoardStatusRow[];
}

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
    // reporter_label = OPERATOR_REPORTER_LABEL (0348): the board shows who actually WROTE this item. The
    // employment id still has to be a real one — it is NOT NULL and drives RLS can_see_employment() — so
    // without the label an operator-raised item is indistinguishable from one the human reporter typed.
    `INSERT INTO feedback_request (id, tenant_id, reporter_employment_id, reporter_user_id, reporter_label, category, title, description, expected_behavior, expected_function, status) ` +
      `VALUES ('${id}', '${p.tenantId}', '${p.reporterEmploymentId}', ${ruser}, ${dq(OPERATOR_REPORTER_LABEL)}, '${p.category}', ${dq(title)}, ${dq(description)}, ${eb}, ${ef}, 'open');`,
    `INSERT INTO domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, subject_employment_id, payload) ` +
      `VALUES ('${p.tenantId}', 'feedback', '${id}', 'feedback.submitted', '${actorType}', ${actorId}, '${p.reporterEmploymentId}', ${dq(JSON.stringify({ category: p.category, title, via: 'operator-raised' }))}::jsonb);`,
    'COMMIT;',
  ].join('\n');
  remote(`psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f -`, sql);
  return { id };
}

/** An image to show the reporter alongside the plan (0406). `content` is the raw file. */
export type PlanMockup = { fileName: string; mimeType: string; content: Buffer };

/**
 * Attach mockups to the plan that is CURRENTLY on the item (0406).
 *
 * ORDERING IS THE WHOLE CONTRACT AND IT IS NOT DEFENSIVE TO SAY SO. `plan_revision` is read from the
 * item inside the INSERT rather than passed in, exactly as core/feedback.ts does it, so a mockup can
 * never be filed against a revision the caller merely believed was current. The consequence is that this
 * MUST run AFTER pushPlan: run it before, and every image silently names the plan that was just replaced,
 * the page's revision filter hides them, and the reporter sees a plan with no design and no error.
 * pushPlanWithMockups() exists so no caller has to remember that.
 *
 * Bytes travel base64 in a dollar-quoted literal and are decoded server-side. psql's own \\copy would need
 * the file to exist ON the server, and a bytea hex literal doubles the payload for no benefit.
 */
export function attachPlanMockups(p: {
  id: string;
  tenantId: string;
  mockups: PlanMockup[];
}): void {
  assertUuid(p.id, 'feedback id');
  assertUuid(p.tenantId, 'tenant id');
  if (p.mockups.length === 0) return;
  for (const m of p.mockups) {
    if (m.content.byteLength === 0) throw new Error(`mockup ${m.fileName} is empty`);
    // Mirrors the 10 MB ceiling addFeedbackAttachment enforces. Checked here too because this path does
    // not go through it — the in-app limit would otherwise be advisory for the one caller that bypasses it.
    if (m.content.byteLength > 10 * 1024 * 1024) throw new Error(`mockup ${m.fileName} exceeds 10 MB`);
  }
  const rows = p.mockups
    .map(
      (m) =>
        `INSERT INTO feedback_attachment
           (tenant_id, feedback_request_id, employment_id, content, file_name, mime_type, size_bytes, stage, plan_revision)
         SELECT '${p.tenantId}', id, reporter_employment_id, decode(${dq(m.content.toString('base64'))}, 'base64'),
                ${dq(m.fileName)}, ${dq(m.mimeType)}, ${m.content.byteLength}, 'plan', plan_revision
         FROM feedback_request WHERE id = '${p.id}';`,
    )
    .join('\n');
  remote(`psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f -`, `BEGIN;\n${rows}\nCOMMIT;`);
}

/**
 * Push a plan and its mockups together (0406) — the call every planning session should use.
 *
 * Two statements rather than one transaction, deliberately: pushPlan already commits, and the alternative
 * is inlining its SQL here so the two can never drift apart differently. If the attach fails the plan is
 * still on the board (text-only, exactly as before this existed), which is the safe half to keep.
 */
export function pushPlanWithMockups(p: {
  id: string;
  tenantId: string;
  reporterEmploymentId: string;
  plan: string;
  model: string;
  mockups?: PlanMockup[];
}): void {
  pushPlan(p);
  if (p.mockups?.length) attachPlanMockups({ id: p.id, tenantId: p.tenantId, mockups: p.mockups });
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
 * Park an approved or in-build item on an unanswered question (status → blocked + a feedback.blocked event).
 *
 * This exists so parking an item is a COMMAND rather than hand-written SQL over SSH. The board learned
 * about blocked items before this did, and the gap was filled by ad-hoc UPDATEs — which append no event,
 * so the reason for the park lived only in whichever session ran them.
 *
 * `building` IS parkable (r355). The guard was `approved` only, which reads tidy and is wrong: the question
 * that stops a build is usually the one you find WHILE building, and the only ways out were to lie with
 * build-complete or to leave the item reading `building` with no question attached to it. Unblock returns
 * the item to `approved`, so a parked build restarts from the answer.
 */
export function markBlocked(p: {
  id: string;
  tenantId: string;
  reporterEmploymentId: string;
  reason: string;
  blockedById?: string | null;
}): void {
  assertMoved(
    p.id,
    'blocked',
    remote(`psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -qtA -f -`, markBlockedSql(p)),
    'Only an approved or building item can be parked on a question',
  );
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
    OUTCOME_SETUP,
    doBlock(
      [
        'DECLARE n int;',
        'BEGIN',
        // `approved` OR `building` — see markBlocked. ROW_COUNT, not a re-read of the status, is what the
        // episode and the event hang off: an item that was ALREADY blocked reads the same afterwards, and
        // an episode or event for a park that did not happen is a fabricated question in the history.
        `  UPDATE feedback_request SET status = 'blocked', blocked_reason = ${dq(p.reason)}, blocked_by_id = ${blocker}, updated_at = now() WHERE id = '${p.id}' AND status IN ('approved', 'building');`,
        '  GET DIAGNOSTICS n = ROW_COUNT;',
        '  IF n = 1 THEN',
        // The episode (0323) carries the QUESTION, which has to be copied here because blocked_reason is
        // cleared on the way out — an answer recorded later would otherwise have nothing to attach to.
        // EXECUTE + to_regclass because this code runs against a database that may predate the table — see doBlock.
        "    IF to_regclass('public.feedback_block') IS NOT NULL THEN",
        `      EXECUTE 'INSERT INTO feedback_block (tenant_id, feedback_request_id, question, blocked_by_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING' USING '${p.tenantId}'::uuid, '${p.id}'::uuid, ${dq(p.reason.trim())}::text, ${blocker}::uuid;`,
        '    END IF;',
        `    INSERT INTO domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, subject_employment_id, payload) VALUES ('${p.tenantId}', 'feedback', '${p.id}', 'feedback.blocked', 'agent', '${p.reporterEmploymentId}', ${dq(JSON.stringify({ reason: p.reason, blockedById: p.blockedById ?? null, via: 'improvement-loop' }))}::jsonb);`,
        '  END IF;',
        outcomeRecord(p.id),
        'END',
      ].join('\n'),
    ),
    OUTCOME_READ,
  ].join('\n');
  return sql;
}

/** The question was answered — return the item to the build queue (status → approved). */
export function markUnblocked(p: { id: string; tenantId: string; reporterEmploymentId: string; note?: string | null }): void {
  assertMoved(
    p.id,
    'approved',
    remote(`psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -qtA -f -`, markUnblockedSql(p)),
    'Only a blocked item can be released',
  );
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
    OUTCOME_SETUP,
    doBlock(
      [
        'DECLARE n int;',
        'BEGIN',
        `  UPDATE feedback_request SET status = 'approved', blocked_reason = NULL, blocked_by_id = NULL, updated_at = now() WHERE id = '${p.id}' AND status = 'blocked';`,
        // ROW_COUNT matters even more on the way out than on the way in: an item that is already
        // `approved` looks identical AFTER a release that never happened, so a status re-read here would
        // close somebody else's episode and write an unblocked event for nothing.
        '  GET DIAGNOSTICS n = ROW_COUNT;',
        '  IF n = 1 THEN',
        // End the episode (0323). The note, where there is one, IS the answer — the operator-side twin of
        // the reporter answering in the app. nullif(btrim(...)) keeps a whitespace-only note out: an
        // episode released with nothing said must record NULL, not a blank pretending to be an answer.
        "    IF to_regclass('public.feedback_block') IS NOT NULL THEN",
        `      EXECUTE 'UPDATE feedback_block SET answer = nullif(btrim($1), ''''), resolved_at = now() WHERE feedback_request_id = $2 AND resolved_at IS NULL' USING ${p.note ? dq(p.note) : 'NULL'}::text, '${p.id}'::uuid;`,
        '    END IF;',
        `    INSERT INTO domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, subject_employment_id, payload) VALUES ('${p.tenantId}', 'feedback', '${p.id}', 'feedback.unblocked', 'agent', '${p.reporterEmploymentId}', ${dq(JSON.stringify({ note: p.note ?? null, via: 'improvement-loop' }))}::jsonb);`,
        '  END IF;',
        outcomeRecord(p.id),
        'END',
      ].join('\n'),
    ),
    OUTCOME_READ,
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

/** One row of `feedback_attachment`, without its bytes. */
export type RemoteAttachment = {
  id: string;
  feedback_request_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  stage: string;
  plan_revision: number | null;
  created_at: string;
};

/**
 * THE REPORTER'S OWN ATTACHMENTS, LISTED AND FETCHED (item fda53352).
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * CLAUDE.md §8 makes reading them mandatory — "Verify the premise hardest when it is your own
 * correction of the reporter. Read attachments (`feedback_attachment`, base64 out, `unzip` a docx, look
 * in `word/media/`) before calling anything unobtainable" — and §9 records that of 151 attachments on
 * production, 143 are IMAGES: the reporter communicates in pictures. There was no command for it. Every
 * session that needed one hand-rolled an ssh+psql one-liner, which is both unreviewable and the exact
 * shape a sandbox classifier refuses.
 *
 * ⚠️ LISTING AND FETCHING ARE SEPARATE CALLS, ON PURPOSE. `content` is a bytea holding whole PNGs and
 * docx files; one production item carries several MB. Selecting it alongside the metadata would push the
 * bytes of every attachment on the board through a single 32 MB ssh buffer to answer "what is attached?".
 * So the list carries no bytes and the fetch takes one id.
 *
 * base64 is produced ON THE SERVER by `encode(content,'base64')` and decoded here. psql's default text
 * output would mangle a PNG through its bytea hex/escape formatting and the newline handling in between.
 */
export function listAttachments(feedbackId: string): RemoteAttachment[] {
  assertUuid(feedbackId, 'feedback id');
  const sql =
    `select coalesce(json_agg(row_to_json(t) order by t.created_at), '[]') from (` +
    `select id, feedback_request_id, file_name, mime_type, size_bytes, stage, plan_revision, created_at ` +
    `from feedback_attachment where feedback_request_id = '${feedbackId}' order by created_at) t`;
  const out = remote(`psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -tAc ${shellQuote(sql)}`).trim();
  return JSON.parse(out || '[]') as RemoteAttachment[];
}

/** The bytes of ONE attachment. `-tAc` with `encode(...,'base64')` so psql never reformats the payload. */
export function fetchAttachment(attachmentId: string): Buffer {
  assertUuid(attachmentId, 'attachment id');
  const sql = `select encode(content,'base64') from feedback_attachment where id = '${attachmentId}'`;
  const b64 = remote(`psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -tAc ${shellQuote(sql)}`).trim();
  if (!b64) throw new Error(`no attachment ${attachmentId}`);
  return Buffer.from(b64, 'base64');
}
