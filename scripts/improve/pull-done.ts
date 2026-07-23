/**
 * One-off: list feedback items in 'building'/'done' (built, awaiting release) — the release step needs
 * their {id, tenant_id, reporter_employment_id} to mark them deployed. Mirrors remote.ts's selectFeedback.
 */
import { execFileSync } from 'node:child_process';

const HOST = process.env.IMPROVE_SSH_HOST ?? '10.20.30.20';
const PORT = process.env.IMPROVE_SSH_PORT ?? '8288';
const USER = process.env.IMPROVE_SSH_USER ?? 'ubuntu';
const DIR = process.env.IMPROVE_REMOTE_DIR ?? '/opt/ai-hr';

const sql = `select coalesce(json_agg(row_to_json(t)), '[]') from (select id, tenant_id, reporter_employment_id, title, status, build_ref from feedback_request where status in ('building','done') order by updated_at) t`;
const probe = `select to_regclass('public.employee_device') is not null as r63_live`;

const full = `cd ${DIR} && set -a; . ./.env.production; set +a; psql "$MIGRATION_DATABASE_URL" -tAc '${sql.replace(/'/g, `'\\''`)}'; psql "$MIGRATION_DATABASE_URL" -tAc '${probe.replace(/'/g, `'\\''`)}'`;
const out = execFileSync('ssh', ['-p', PORT, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', `${USER}@${HOST}`, full], { encoding: 'utf8' });
console.log(out);
