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

/** Run a remote shell command (psql sources the server's own .env.production). `stdin` feeds `psql -f -`. */
function remote(cmd: string, stdin?: string): string {
  const full = `cd ${DIR} && set -a; . ./.env.production; set +a; ${cmd}`;
  return execFileSync('ssh', ['-p', PORT, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', `${USER}@${HOST}`, full], {
    input: stdin,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

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
};

const SELECT_COLS =
  'id, tenant_id, reporter_employment_id, category, title, description, expected_behavior, expected_function, status, plan, plan_revision, contest_reason, build_ref';

function selectFeedback(whereStatus: string): RemoteFeedback[] {
  const sql = `select coalesce(json_agg(row_to_json(t)), '[]') from (select ${SELECT_COLS} from feedback_request where status in (${whereStatus}) order by created_at) t`;
  const out = remote(`psql "$MIGRATION_DATABASE_URL" -tAc ${shellQuote(sql)}`).trim();
  return JSON.parse(out || '[]') as RemoteFeedback[];
}

/** Items awaiting a (re)plan. */
export const pullPlannable = (): RemoteFeedback[] => selectFeedback(`'open','contested'`);
/** Items the reporter has approved (ready to build + release). */
export const pullApproved = (): RemoteFeedback[] => selectFeedback(`'approved'`);

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
    `UPDATE feedback_request SET plan = ${dq(p.plan)}, plan_revision = plan_revision + 1, plan_model = ${dq(p.model)}, contest_reason = NULL, status = 'planned', updated_at = now() WHERE id = '${p.id}';`,
    `INSERT INTO domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, subject_employment_id, payload) VALUES ('${p.tenantId}', 'feedback', '${p.id}', 'feedback.plan.drafted', 'agent', '${p.reporterEmploymentId}', ${dq(JSON.stringify({ model: p.model, via: 'improvement-loop' }))}::jsonb);`,
    'COMMIT;',
  ].join('\n');
  remote(`psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f -`, sql);
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
