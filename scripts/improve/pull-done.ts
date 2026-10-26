/**
 * One-off: list feedback items in 'building'/'done' (built, awaiting release) — the release step needs
 * their {id, tenant_id, reporter_employment_id} to mark them deployed. Mirrors remote.ts's selectFeedback.
 */
import { execFileSync } from 'node:child_process';
import { operatorSsh } from '../operator-ssh.mjs';

const SSH = operatorSsh();
const TARGET = SSH.target;
const DIR = SSH.remoteDir;

const sql = `select coalesce(json_agg(row_to_json(t)), '[]') from (select id, tenant_id, reporter_employment_id, title, status, build_ref from feedback_request where status in ('building','done') order by updated_at) t`;
const probe = `select to_regclass('public.employee_device') is not null as r63_live`;

const full = `cd ${DIR} && set -a; . ./.env.production; set +a; psql "$MIGRATION_DATABASE_URL" -tAc '${sql.replace(/'/g, `'\\''`)}'; psql "$MIGRATION_DATABASE_URL" -tAc '${probe.replace(/'/g, `'\\''`)}'`;
const out = execFileSync('ssh', [...SSH.options, TARGET, full], { encoding: 'utf8' });
console.log(out);
