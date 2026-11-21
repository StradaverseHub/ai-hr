import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {expectedMigrationLedger, validateMigrationLedgerRows}
  from '../../.github/ci/staging-migration-ledger.mjs';

const identifier = '[a-z_][a-z0-9_]{0,62}';
const indexStatement = new RegExp(
  `^CREATE INDEX (${identifier}) ON public\\.(${identifier}) USING btree \\((${identifier}(?: DESC)?(?:, ${identifier}(?: DESC)?){0,7})\\);$`,
);

/** Admit one appended non-unique B-tree index on ordinary public columns. */
export function parseIndex(bytes) {
  assert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1024, 'Bounded index SQL required');
  const sql = bytes.toString('utf8').trim();
  const match = sql.match(indexStatement);
  assert(match, 'Upgrade requires one plain non-unique public B-tree index');
  const [, index, table, keys] = match;
  return {sql, index, table, definition: sql.replace(/;$/, ''),
    digest: createHash('sha256').update(bytes).digest('hex'),
    columns: keys.split(', ').map(key => key.split(' ')[0])};
}

export function deriveExpansion(baseline, candidate) {
  const original = expectedMigrationLedger(baseline);
  const expanded = expectedMigrationLedger(candidate);
  assert(expanded.length === original.length + 1, 'Exactly one migration must be appended');
  assert(isDeepStrictEqual(expanded.slice(0, -1), original), 'Ordered historical migration entries changed');
  const row = expanded.at(-1);
  assert(BigInt(row.created_at) > original.reduce((max, item) => {
    const when = BigInt(item.created_at);
    return when > max ? when : max;
  }, 0n), 'New migration timestamp must exceed the complete baseline watermark');
  const index = parseIndex(readFileSync(join(candidate, 'db/migrations', row.tag + '.sql')));
  assert.equal(index.digest, row.hash, 'The migration bytes do not match the appended ledger entry');
  return {original, expanded, row, index};
}

async function readLedger(sql) {
  return sql`SELECT id::text, hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`;
}

async function inspectIndex(sql, plan) {
  const [index] = await sql`SELECT i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS is_unique,
      pg_get_indexdef(c.oid) AS definition
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_namespace ns ON ns.oid=c.relnamespace
    WHERE ns.nspname='public' AND c.relname=${plan.index.index}
      AND i.indrelid=to_regclass(${'public.' + plan.index.table})`;
  assert(index?.valid && index.ready && !index.is_unique, 'Expected usable non-unique index missing');
  assert.equal(index.definition, plan.index.definition, 'The applied index definition differs');
  return index.definition;
}

/** Both the catalog change and its Drizzle entry commit in one transaction. */
export async function applyIndexExpansion(client, plan, {beforeCommit = async () => {}} = {}) {
  return client.begin(async tx => {
    const started = performance.now();
    await tx`SET LOCAL statement_timeout = '5s'`;
    await tx`SET LOCAL lock_timeout = '500ms'`;
    await tx`SET LOCAL idle_in_transaction_session_timeout = '10s'`;
    const [owner] = await tx`SELECT current_user::text AS name, NOT (rolsuper OR rolcreaterole OR rolcreatedb
        OR rolreplication OR rolbypassrls) AS restricted
      FROM pg_roles WHERE rolname=current_user`;
    assert(owner?.name === 'ai_hr_owner' && owner.restricted, 'Literal restricted migration owner required');
    await tx`LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE NOWAIT`;
    const ledger = await readLedger(tx);
    if (ledger.length === plan.expanded.length) {
      validateMigrationLedgerRows(plan.expanded, ledger);
      return {applied: false, rows: ledger.length, definition: await inspectIndex(tx, plan)};
    }
    validateMigrationLedgerRows(plan.original, ledger);
    await tx.unsafe(`LOCK TABLE public.${plan.index.table} IN SHARE MODE NOWAIT`);
    const [table] = await tx`SELECT relkind, pg_get_userbyid(relowner) AS owner,
        pg_total_relation_size(oid) AS bytes
      FROM pg_class WHERE oid=to_regclass(${'public.' + plan.index.table})`;
    assert(table?.relkind === 'r' && table.owner === owner.name && Number(table.bytes) <= 64*1024**2,
      'Upgrade requires a small ordinary table owned by the restricted migration role');
    const columns = await tx`SELECT attname FROM pg_attribute
      WHERE attrelid=to_regclass(${'public.' + plan.index.table})
        AND attnum>0 AND NOT attisdropped AND attgenerated=''
        AND atttypid IN ('uuid'::regtype,'text'::regtype,'timestamptz'::regtype,
                         'date'::regtype,'int4'::regtype,'int8'::regtype)`;
    assert(plan.index.columns.every(name => columns.some(column => column.attname === name)),
      'Expected index columns must be ordinary built-in typed columns');
    await tx.unsafe(plan.index.sql);
    const definition = await inspectIndex(tx, plan);
    await tx`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${plan.row.hash}, ${plan.row.created_at}::bigint)`;
    const after = await readLedger(tx);
    validateMigrationLedgerRows(plan.expanded, after);
    await beforeCommit(tx);
    return {applied: true, rows: after.length, definition, elapsedMs: performance.now() - started};
  });
}
