import { expect, it } from 'vitest';
import {
  readSelectedCatalogueProjection,
  selectedCatalogueComparisonRow,
  selectedCatalogueProjectionModel,
  selectedCatalogueProjectionSource,
} from './helpers/ai-centre-selected-catalogue-projection';

const role = 'aihr_ai_compat_0123456789abcdef0123456789abcdef';
const bounds = { rows: 3, rawBytes: 12000, rowBytes: 6000, encodedBytes: 12000, aclEntries: 8 };

const selectors = [
  ['schema', 'n.oid', '0', 'pg_catalog.pg_namespace n', 'ALTER SCHEMA %I OWNER TO %I'],
  ['relation', 'c.oid', '0', 'pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n', "c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')"],
  ['function', 'p.oid', '0', 'pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n', 'pg_get_function_identity_arguments(p.oid)'],
  ['type', 't.oid', '0', 'pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n', 'LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid'],
  ['column', 'c.oid', 'a.attnum::integer', 'pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c', 'a.attnum > 0 AND NOT a.attisdropped'],
] as const;

it.each(selectors)('builds the fixed %s catalogue selector with bound limits', (kind, oid, subId, relation, predicate) => {
  const query = selectedCatalogueProjectionSource(kind, role, bounds);
  expect(query.values).toEqual([role, 3, 12000, 6000, 12000, 8]);
  expect(query.text).toContain(`SELECT ${oid} AS object_oid, ${subId} AS sub_id FROM ${relation}`);
  expect(query.text).toContain(predicate);
  expect(query.text).toContain("n.nspname IN ('app', 'public', 'drizzle')");
  expect(query.text).toContain('ORDER BY object_oid, sub_id LIMIT ($2::integer + 1)');
  expect(query.text).toContain('HAVING $1::text IS NOT NULL');
  expect(query.text).toContain('input_stats.raw_bytes > $3::bigint OR input_stats.max_row_bytes > $4::integer');
  expect(query.text).toContain('input_stats.acl_entries > $6::bigint');
  expect(query.text).toContain('o.encoded_bytes > $5::bigint');
  expect(query.text).toContain("WHERE v.final_status = 'complete'");
  expect(query.text).toContain('ORDER BY slot, object_oid, sub_id');
  expect([...new Set(query.text.match(/\$\d+/g))].sort()).toEqual(['$1', '$2', '$3', '$4', '$5', '$6']);
  expect(query.text).not.toContain(role);
});

it('refuses unknown selectors, malformed roles and invalid bounds', () => {
  type Kind = Parameters<typeof selectedCatalogueProjectionSource>[0];
  for (const kind of ['toString', '__proto__', 'relation; SELECT 1']) {
    expect(() => selectedCatalogueProjectionSource(kind as Kind, role, bounds)).toThrow();
    expect(() => readSelectedCatalogueProjection(kind as Kind, bounds, [headerPacket()])).toThrow();
  }
  expect(() => selectedCatalogueProjectionSource('relation', role + '\n', bounds)).toThrow();
  expect(() => selectedCatalogueProjectionSource('relation', 'postgres', bounds)).toThrow();
  expect(() => selectedCatalogueProjectionSource('relation', role, { ...bounds, rows: 40001 })).toThrow();
  expect(() => selectedCatalogueProjectionSource('relation', role, { ...bounds, rowBytes: 12001 })).toThrow();
});

type Header = ReturnType<typeof readSelectedCatalogueProjection>['header'];
type ModelInput = Parameters<typeof selectedCatalogueProjectionModel>[0];
const emptyHeader = {
  version: 1, kind: 'function', status: 'complete', rows: 0, rendered: 0, rawBytes: 0,
  maxRowBytes: 0, aclEntries: 0, encodedBytes: 0,
} satisfies Header;

function headerPacket(patch: Partial<Header> = {}) {
  return { slot: 0, objectOid: '0', subId: 0, payload: JSON.stringify({ ...emptyHeader, ...patch }) };
}

const ownerEdge = { grantee: 'postgres', grantor: 'postgres', privilege: 'EXECUTE', grantable: true };
const publicEdge = { grantee: '-', grantor: 'postgres', privilege: 'EXECUTE', grantable: false };
const first = {
  kind: 'function', objectOid: '41', subId: 0, identity: 'app."名"(text)', owner: 'postgres', move: true,
  command: `ALTER FUNCTION app."名"(text) OWNER TO ${role}`, attributes: '{"oid": 41, "label": "多é"}',
  acl: [ownerEdge, publicEdge, ownerEdge], definition: "SELECT '資料';\n",
} satisfies ModelInput;
const second = {
  ...first, objectOid: '42', identity: 'app.empty()', owner: 'migration_reader', move: false,
  command: null, attributes: '{}', acl: [], definition: '',
} satisfies ModelInput;
const third = { ...second, objectOid: '43', identity: 'app.null_definition()', definition: null } satisfies ModelInput;

function completePacket(inputs: readonly ModelInput[]) {
  const rows = inputs.map(selectedCatalogueProjectionModel);
  const objects = rows.map(row => ({ slot: 1, objectOid: row.objectOid, subId: row.subId, payload: JSON.stringify(row) }));
  const rawLengths = inputs.map(row => Buffer.byteLength(JSON.stringify({
    object_oid: Number(row.objectOid), sub_id: row.subId, identity: row.identity, owner: row.owner,
    move: row.move, command: row.command, attributes: JSON.parse(row.attributes), acl: row.acl, definition: row.definition,
  })));
  const header = {
    ...emptyHeader, rows: rows.length, rendered: rows.length,
    rawBytes: rawLengths.reduce((sum, length) => sum + length, 0), maxRowBytes: Math.max(0, ...rawLengths),
    aclEntries: inputs.reduce((sum, row) => sum + row.acl.length, 0),
    encodedBytes: objects.reduce((sum, packet) => sum + Buffer.byteLength(packet.payload), 0),
  };
  return { rows, header, objects, packets: [headerPacket(header), ...objects] };
}

it('preserves UTF-8 frames, empty versus null definitions and exact ACL multiplicity', () => {
  const { rows, header, packets } = completePacket([first, second, third]);
  const parsed = readSelectedCatalogueProjection('function', bounds, packets);
  expect(parsed).toStrictEqual({ header, objects: rows });
  expect(parsed.objects[0].attributes).toStrictEqual({ bytes: 29, sha256: '58cea21d639550c7e6ba98609369b574a963ef79c17041a29619941cd6815282' });
  expect(parsed.objects[0].definition).toStrictEqual({ bytes: 17, sha256: '6ec6d9ee38e2f2a31b0b6db2f69f242d90050c301c80662b8201bfc263f27b14' });
  expect(parsed.objects[1].definition).toStrictEqual({ bytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
  expect(parsed.objects[2].definition).toBeNull();
  expect(parsed.objects[0].acl).toStrictEqual([ownerEdge, publicEdge, ownerEdge]);
  const normalized = selectedCatalogueComparisonRow(parsed.objects[0], role);
  const movedOwnerEdge = { ...ownerEdge, grantee: role, grantor: role };
  expect(normalized.owner).toBe(role);
  expect(normalized.acl).toHaveLength(3);
  expect(normalized.acl.filter(edge => edge.grantee === role)).toStrictEqual([movedOwnerEdge, movedOwnerEdge]);
  expect(normalized.acl.find(edge => edge.grantee === '-')).toStrictEqual({ ...publicEdge, grantor: role });
  expect(selectedCatalogueComparisonRow(parsed.objects[1], role).owner).toBe('migration_reader');
});

it('admits exact empty and refusal headers without any object payload', () => {
  const refusals: Partial<Header>[] = [
    { status: 'row-limit', rows: 4 },
    { status: 'shape', rows: 1 },
    { status: 'raw-limit', rows: 1, rendered: 1, rawBytes: 6001, maxRowBytes: 6001 },
    { status: 'acl-limit', rows: 1, rendered: 1, rawBytes: 500, maxRowBytes: 500, aclEntries: 9 },
    { status: 'encoded-limit', rows: 1, rendered: 1, rawBytes: 500, maxRowBytes: 500, encodedBytes: 12001 },
  ];
  const { objects } = completePacket([first]);
  expect(readSelectedCatalogueProjection('function', bounds, [headerPacket()])).toStrictEqual({ header: emptyHeader, objects: [] });
  expect(() => readSelectedCatalogueProjection('function', bounds, [])).toThrow();
  expect(() => readSelectedCatalogueProjection('function', bounds, [{ ...headerPacket(), slot: 1 }])).toThrow();
  expect(() => readSelectedCatalogueProjection('function', bounds, [headerPacket({ kind: 'relation' })])).toThrow();
  const extra = { ...headerPacket(), payload: JSON.stringify({ ...emptyHeader, unexpected: true }) };
  expect(() => readSelectedCatalogueProjection('function', bounds, [extra])).toThrow();
  for (const refusal of refusals) {
    const packet = headerPacket(refusal);
    expect(readSelectedCatalogueProjection('function', bounds, [packet])).toStrictEqual({ header: { ...emptyHeader, ...refusal }, objects: [] });
    expect(() => readSelectedCatalogueProjection('function', bounds, [packet, ...objects])).toThrow();
  }
  expect(() => readSelectedCatalogueProjection('function', bounds, [headerPacket({ status: 'row-limit', rows: 3 })])).toThrow();
  expect(() => readSelectedCatalogueProjection('function', bounds, [headerPacket({ status: 'row-limit', rows: 5 })])).toThrow();
  expect(() => readSelectedCatalogueProjection('function', bounds, [headerPacket({ rawBytes: 1 })])).toThrow();
});

it('refuses individually impossible raw claims and enforces the packet row limit', () => {
  const { header, objects, packets } = completePacket([first, second]);
  expect(readSelectedCatalogueProjection('function', bounds, packets).objects).toHaveLength(2);
  // Largest known frames total 46 bytes. The smaller row adds two more.
  const impossible = [
    { rawBytes: 90, maxRowBytes: 45 }, // Both rows fit in aggregate, but the first alone cannot fit.
    { rawBytes: 47, maxRowBytes: 46 }, // Each row fits, but together they need at least 48 bytes.
    { rawBytes: 1601, maxRowBytes: 800 }, // Two rows cannot fill 1,601 bytes with an 800-byte maximum.
  ];
  for (const claim of impossible) {
    expect(() => readSelectedCatalogueProjection('function', bounds, [headerPacket({ ...header, ...claim }), ...objects])).toThrow();
  }
  expect(() => readSelectedCatalogueProjection('function', { ...bounds, rows: 1 }, packets)).toThrow();
});
