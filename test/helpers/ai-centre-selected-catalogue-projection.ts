/** Dormant source and model for the selected private migration catalogue.
 * No database client, executor, transaction, registration or admission.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const schemaScope = "n.nspname IN ('app', 'public', 'drizzle')";
const oldOwner = 'postgres';

const scope = {
  schema: {
    oid: 'n.oid', subId: '0',
    from: 'pg_catalog.pg_namespace n',
    where: schemaScope,
    fields: `
      quote_ident(n.nspname) AS identity, n.nspowner::regrole::text AS owner,
      n.nspowner = 'postgres'::regrole AS move,
      format('ALTER SCHEMA %I OWNER TO %I', n.nspname, $1::text) AS command,
      to_jsonb(n) - 'nspowner' - 'nspacl' AS attributes,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('grantee', a.grantee::regrole::text,
        'grantor', a.grantor::regrole::text, 'privilege', a.privilege_type, 'grantable', a.is_grantable)), '[]')
       FROM aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a) AS acl,
      NULL::text AS definition`,
  },
  relation: {
    oid: 'c.oid', subId: '0',
    from: 'pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
    where: `${schemaScope} AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')`,
    fields: `
      format('%I.%I', n.nspname, c.relname) AS identity, c.relowner::regrole::text AS owner,
      c.relowner = 'postgres'::regrole AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e') AS move,
      format('ALTER %s %I.%I OWNER TO %I', CASE c.relkind WHEN 'S' THEN 'SEQUENCE'
        WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE'
        ELSE 'TABLE' END, n.nspname, c.relname, $1::text) AS command,
      to_jsonb(c) - 'relowner' - 'relacl' AS attributes,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('grantee', a.grantee::regrole::text,
        'grantor', a.grantor::regrole::text, 'privilege', a.privilege_type, 'grantable', a.is_grantable)), '[]')
       FROM aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 'S'::"char"
        ELSE 'r'::"char" END, c.relowner))) a) AS acl,
      CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) ELSE NULL END AS definition`,
  },
  function: {
    oid: 'p.oid', subId: '0',
    from: 'pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace',
    where: schemaScope,
    fields: `
      format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS identity,
      p.proowner::regrole::text AS owner,
      p.proowner = 'postgres'::regrole AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') AS move,
      format('ALTER %s %I.%I(%s) OWNER TO %I', CASE p.prokind WHEN 'p' THEN 'PROCEDURE'
        WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END, n.nspname, p.proname,
        pg_get_function_identity_arguments(p.oid), $1::text) AS command,
      to_jsonb(p) - 'proowner' - 'proacl' AS attributes,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('grantee', a.grantee::regrole::text,
        'grantor', a.grantor::regrole::text, 'privilege', a.privilege_type, 'grantable', a.is_grantable)), '[]')
       FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) AS acl,
      CASE WHEN p.prokind <> 'a' THEN pg_get_functiondef(p.oid)
        ELSE (SELECT to_jsonb(a)::text FROM pg_catalog.pg_aggregate a WHERE a.aggfnoid = p.oid)
        END AS definition`,
  },
  type: {
    oid: 't.oid', subId: '0',
    from: `pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid`,
    where: schemaScope,
    fields: `
      format('%I.%I', n.nspname, t.typname) AS identity, t.typowner::regrole::text AS owner,
      t.typowner = 'postgres'::regrole AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e') AS move,
      CASE WHEN t.typelem = 0 AND t.typtype <> 'm' AND (t.typrelid = 0 OR c.relkind = 'c')
        THEN format('ALTER %s %I.%I OWNER TO %I', CASE WHEN t.typtype = 'd' THEN 'DOMAIN' ELSE 'TYPE' END,
          n.nspname, t.typname, $1::text) ELSE NULL END AS command,
      to_jsonb(t) - 'typowner' - 'typacl' AS attributes,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('grantee', a.grantee::regrole::text,
        'grantor', a.grantor::regrole::text, 'privilege', a.privilege_type, 'grantable', a.is_grantable)), '[]')
       FROM aclexplode(coalesce(t.typacl, acldefault('T', t.typowner))) a) AS acl,
      NULL::text AS definition`,
  },
  column: {
    oid: 'c.oid', subId: 'a.attnum::integer',
    from: `pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace`,
    where: `${schemaScope} AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND a.attnum > 0 AND NOT a.attisdropped`,
    fields: `
      format('%I.%I.%I', n.nspname, c.relname, a.attname) AS identity,
      c.relowner::regrole::text AS owner,
      c.relowner = 'postgres'::regrole AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e') AS move,
      NULL::text AS command, to_jsonb(a) - 'attacl' AS attributes,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('grantee', x.grantee::regrole::text,
        'grantor', x.grantor::regrole::text, 'privilege', x.privilege_type, 'grantable', x.is_grantable)), '[]')
       FROM aclexplode(a.attacl) x) AS acl, NULL::text AS definition`,
  },
} as const;

type Kind = keyof typeof scope;
type Bounds = { rows: number; rawBytes: number; rowBytes: number; encodedBytes: number; aclEntries: number };
type Acl = { grantee: string; grantor: string; privilege: string; grantable: boolean };
type Frame = { bytes: number; sha256: string };
type Projection = {
  kind: Kind;
  objectOid: string;
  subId: number;
  identity: string;
  owner: string;
  move: boolean;
  command: string | null;
  attributes: Frame;
  acl: Acl[];
  definition: Frame | null;
};

const bytesCap = 64 * 1024 * 1024;
const fits = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const ownedRole = (role: unknown): role is string =>
  typeof role === 'string' && /^aihr_ai_compat_[0-9a-f]{32}(?![\s\S])/.test(role);
const knownKind = (kind: unknown): kind is Kind => typeof kind === 'string' && Object.hasOwn(scope, kind);
const keysEqual = (value: object, expected: string[]) =>
  assert.deepEqual(Object.keys(value).sort(), expected.slice().sort());
const utf8 = (value: string) => `pg_catalog.convert_to(${value}, 'UTF8')`;
const length = (value: string) => `pg_catalog.octet_length(${utf8(value)})`;
const seal = (bytea: string) => `jsonb_build_object('bytes', pg_catalog.octet_length(${bytea}),
  'sha256', pg_catalog.encode(pg_catalog.sha256(${bytea}), 'hex'))`;

function checkBounds(bounds: Bounds) {
  keysEqual(bounds, ['rows', 'rawBytes', 'rowBytes', 'encodedBytes', 'aclEntries']);
  assert(fits(bounds.rows, 40000) && bounds.rows > 0);
  assert(fits(bounds.rawBytes, bytesCap) && bounds.rawBytes > 0);
  assert(fits(bounds.rowBytes, bounds.rawBytes) && bounds.rowBytes > 0);
  assert(fits(bounds.encodedBytes, bytesCap) && bounds.encodedBytes > 0);
  assert(fits(bounds.aclEntries, 40000));
}

/** This returns inert SQL and parameters. The caller must separately hold the
 * actual private realm, snapshot and cumulative work admission before execution.
 */
export function selectedCatalogueProjectionSource(kind: Kind, role: string, bounds: Bounds) {
  assert(knownKind(kind) && ownedRole(role));
  checkBounds(bounds);
  const { oid, subId, from, where, fields } = scope[kind];
  const text = `WITH selected_keys AS MATERIALIZED (
    SELECT ${oid} AS object_oid, ${subId} AS sub_id FROM ${from}
    WHERE ${where} ORDER BY object_oid, sub_id LIMIT ($2::integer + 1)
  ), census AS MATERIALIZED (
    SELECT count(*)::integer AS rows FROM selected_keys HAVING $1::text IS NOT NULL
  ), raw_rows AS NOT MATERIALIZED (
    SELECT k.object_oid, k.sub_id, ${fields} FROM ${from}
    JOIN selected_keys k ON k.object_oid = ${oid} AND k.sub_id = ${subId}
    CROSS JOIN census WHERE ${where} AND census.rows <= $2::integer
  ), input_lengths AS MATERIALIZED (
    SELECT ${length('to_jsonb(r)::text')} AS bytes, jsonb_array_length(r.acl) AS acl_entries
    FROM raw_rows r
  ), input_stats AS MATERIALIZED (
    SELECT count(*)::integer AS rendered, coalesce(sum(bytes), 0)::bigint AS raw_bytes,
      coalesce(max(bytes), 0)::integer AS max_row_bytes,
      coalesce(sum(acl_entries), 0)::bigint AS acl_entries
    FROM input_lengths
  ), input_admission AS MATERIALIZED (
    SELECT census.rows, input_stats.*,
      CASE WHEN census.rows > $2::integer THEN 'row-limit'
        WHEN input_stats.rendered <> census.rows THEN 'shape'
        WHEN input_stats.raw_bytes > $3::bigint OR input_stats.max_row_bytes > $4::integer THEN 'raw-limit'
        WHEN input_stats.acl_entries > $6::bigint THEN 'acl-limit' ELSE 'admitted' END AS status
    FROM census CROSS JOIN input_stats
  ), digest_inputs AS MATERIALIZED (
    SELECT r.object_oid, r.sub_id, r.identity, r.owner, r.move, r.command, r.acl,
      ${utf8('r.attributes::text')} AS attribute_bytes, ${utf8('r.definition')} AS definition_bytes
    FROM raw_rows r CROSS JOIN input_admission a WHERE a.status = 'admitted'
  ), encoded AS MATERIALIZED (
    SELECT r.object_oid, r.sub_id, jsonb_build_object(
      'kind', '${kind}', 'objectOid', r.object_oid::text, 'subId', r.sub_id,
      'identity', r.identity, 'owner', r.owner, 'move', r.move, 'command', r.command,
      'attributes', ${seal('r.attribute_bytes')}, 'acl', r.acl,
      'definition', CASE WHEN r.definition_bytes IS NULL THEN NULL ELSE ${seal('r.definition_bytes')} END
    )::text AS payload
    FROM digest_inputs r
  ), output_stats AS MATERIALIZED (
    SELECT count(*)::integer AS encoded_rows, coalesce(sum(${length('payload')}), 0)::bigint AS encoded_bytes
    FROM encoded
  ), verdict AS MATERIALIZED (
    SELECT a.*, o.encoded_bytes,
      CASE WHEN a.status <> 'admitted' THEN a.status WHEN o.encoded_rows <> a.rows THEN 'shape'
        WHEN o.encoded_bytes > $5::bigint THEN 'encoded-limit' ELSE 'complete' END AS final_status
    FROM input_admission a CROSS JOIN output_stats o
  )
  SELECT slot, object_oid::text AS "objectOid", sub_id AS "subId", payload FROM (
    SELECT 0 AS slot, 0::oid AS object_oid, 0::integer AS sub_id, jsonb_build_object(
      'version', 1, 'kind', '${kind}', 'status', final_status, 'rows', rows, 'rendered', rendered,
      'rawBytes', raw_bytes, 'maxRowBytes', max_row_bytes, 'aclEntries', acl_entries,
      'encodedBytes', encoded_bytes
    )::text AS payload FROM verdict
    UNION ALL
    SELECT 1, e.object_oid, e.sub_id, e.payload
    FROM encoded e CROSS JOIN verdict v WHERE v.final_status = 'complete'
  ) packet ORDER BY slot, object_oid, sub_id`;
  return {
    text,
    values: [role, bounds.rows, bounds.rawBytes, bounds.rowBytes, bounds.encodedBytes,
      bounds.aclEntries] as const,
  };
}

function isFrame(value: unknown): value is Frame {
  if (value === null || typeof value !== 'object') return false;
  keysEqual(value, ['bytes', 'sha256']);
  return 'bytes' in value && fits(value.bytes, bytesCap)
    && 'sha256' in value && typeof value.sha256 === 'string' && /^[0-9a-f]{64}(?![\s\S])/.test(value.sha256);
}

function checkProjection(value: Projection, kind: Kind) {
  keysEqual(value, ['kind', 'objectOid', 'subId', 'identity', 'owner', 'move', 'command', 'attributes', 'acl', 'definition']);
  assert(value.kind === kind && typeof value.objectOid === 'string' && /^[1-9][0-9]{0,9}(?![\s\S])/.test(value.objectOid));
  assert(Number(value.objectOid) <= 0xffffffff);
  assert(fits(value.subId, 32767) && (kind === 'column' ? value.subId > 0 : value.subId === 0));
  assert(typeof value.identity === 'string' && value.identity.length > 0);
  assert(typeof value.owner === 'string' && value.owner.length > 0 && typeof value.move === 'boolean');
  assert(value.command === null || typeof value.command === 'string');
  assert(isFrame(value.attributes) && value.attributes.bytes > 0);
  assert(value.definition === null || isFrame(value.definition));
  if (kind === 'schema' || kind === 'type' || kind === 'column') assert(value.definition === null);
  if (kind === 'column') assert(value.command === null);
  assert(Array.isArray(value.acl));
  for (const acl of value.acl) {
    keysEqual(acl, ['grantee', 'grantor', 'privilege', 'grantable']);
    assert(typeof acl.grantee === 'string' && typeof acl.grantor === 'string'
      && typeof acl.privilege === 'string' && typeof acl.grantable === 'boolean');
  }
}

type Packet = { slot: number; objectOid: string; subId: number; payload: string };
type Header = {
  version: 1; kind: Kind; status: 'complete' | 'row-limit' | 'shape' | 'raw-limit' | 'acl-limit' | 'encoded-limit';
  rows: number; rendered: number; rawBytes: number; maxRowBytes: number; aclEntries: number; encodedBytes: number;
};

/** Pure replay. A well-formed packet is not evidence of a native origin. */
export function readSelectedCatalogueProjection(kind: Kind, bounds: Bounds, packets: readonly Packet[]) {
  assert(knownKind(kind));
  checkBounds(bounds);
  assert(packets.length > 0 && packets.length <= bounds.rows + 1);
  const [head, ...objects] = packets;
  keysEqual(head, ['slot', 'objectOid', 'subId', 'payload']);
  assert(head.slot === 0 && head.objectOid === '0' && head.subId === 0);
  assert(typeof head.payload === 'string' && Buffer.byteLength(head.payload) <= 1024);
  const header: Header = JSON.parse(head.payload);
  keysEqual(header, ['version', 'kind', 'status', 'rows', 'rendered', 'rawBytes', 'maxRowBytes', 'aclEntries', 'encodedBytes']);
  assert(header.version === 1 && header.kind === kind);
  assert(fits(header.rows, bounds.rows + 1) && fits(header.rendered, bounds.rows));
  for (const count of [header.rawBytes, header.maxRowBytes, header.aclEntries, header.encodedBytes]) {
    assert(fits(count, Number.MAX_SAFE_INTEGER));
  }
  assert(header.maxRowBytes <= header.rawBytes);
  if (header.status !== 'complete') {
    assert(objects.length === 0);
    if (header.status === 'row-limit') {
      assert(header.rows === bounds.rows + 1 && header.rendered === 0 && header.rawBytes === 0
        && header.aclEntries === 0 && header.encodedBytes === 0);
    } else if (header.status === 'shape') {
      assert(header.rows <= bounds.rows);
    } else {
      assert(header.rows <= bounds.rows && header.rendered === header.rows);
      if (header.status === 'raw-limit') {
        assert(header.rawBytes > bounds.rawBytes || header.maxRowBytes > bounds.rowBytes);
        assert(header.encodedBytes === 0);
      } else {
        assert(header.rawBytes <= bounds.rawBytes && header.maxRowBytes <= bounds.rowBytes);
        if (header.status === 'acl-limit') assert(header.aclEntries > bounds.aclEntries && header.encodedBytes === 0);
        else assert(header.status === 'encoded-limit' && header.aclEntries <= bounds.aclEntries
          && header.encodedBytes > bounds.encodedBytes);
      }
    }
    return { header, objects: [] as Projection[] };
  }
  assert(header.rows <= bounds.rows && header.rendered === header.rows && objects.length === header.rows);
  assert(header.rawBytes <= bounds.rawBytes && header.maxRowBytes <= bounds.rowBytes);
  assert(header.aclEntries <= bounds.aclEntries && header.encodedBytes <= bounds.encodedBytes);
  let previousOid = 0;
  let previousSubId = 0;
  let encodedBytes = 0;
  let aclEntries = 0;
  let rawFrameBytes = 0;
  const identities = new Set<string>();
  const decoded = objects.map(packet => {
    keysEqual(packet, ['slot', 'objectOid', 'subId', 'payload']);
    assert(packet.slot === 1 && typeof packet.payload === 'string');
    encodedBytes += Buffer.byteLength(packet.payload);
    assert(encodedBytes <= header.encodedBytes);
    const row: Projection = JSON.parse(packet.payload);
    checkProjection(row, kind);
    assert(row.objectOid === packet.objectOid && row.subId === packet.subId);
    const oid = Number(row.objectOid);
    assert(oid > previousOid || (oid === previousOid && row.subId > previousSubId));
    previousOid = oid;
    previousSubId = row.subId;
    assert(!identities.has(row.identity));
    identities.add(row.identity);
    aclEntries += row.acl.length;
    rawFrameBytes += row.attributes.bytes + (row.definition?.bytes ?? 0);
    assert(aclEntries <= header.aclEntries && rawFrameBytes <= header.rawBytes);
    return row;
  });
  assert(encodedBytes === header.encodedBytes && aclEntries === header.aclEntries);
  if (header.rows === 0) assert(header.rawBytes === 0 && header.maxRowBytes === 0);
  else assert(header.rawBytes > 0 && header.maxRowBytes > 0);
  return { header, objects: decoded };
}

function modelFrame(value: string) {
  const raw = Buffer.from(value, 'utf8');
  assert(raw.toString('utf8') === value && raw.length <= bytesCap);
  return { bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex') };
}

/** Model of the framed payload from exact PostgreSQL text, never JS reserialization
 * of raw catalogue JSON. Source ownership must be proved outside this model.
 */
export function selectedCatalogueProjectionModel(
  row: Omit<Projection, 'attributes' | 'definition'> & { attributes: string; definition: string | null },
) {
  assert(knownKind(row.kind));
  const projected = {
    ...row, attributes: modelFrame(row.attributes),
    definition: row.definition === null ? null : modelFrame(row.definition),
  };
  checkProjection(projected, row.kind);
  return projected;
}

/** Preserve the existing owner and exact ACL tuple normalization and
 * multiplicity. The observed move/command fields remain separate evidence.
 */
export function selectedCatalogueComparisonRow(row: Projection, role: string) {
  assert(ownedRole(role) && knownKind(row.kind));
  checkProjection(row, row.kind);
  const acl = row.acl.map(edge => row.move ? {
    ...edge, grantee: edge.grantee === oldOwner ? role : edge.grantee,
    grantor: edge.grantor === oldOwner ? role : edge.grantor,
  } : edge).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    kind: row.kind, objectOid: row.objectOid, subId: row.subId, identity: row.identity,
    owner: row.move ? role : row.owner, attributes: row.attributes, definition: row.definition, acl,
  };
}
