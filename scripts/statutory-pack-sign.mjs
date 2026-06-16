// One-time generator for the statutory-pack DEV trust material + committed interop test vector (ADR-0020).
//
// Produces, under localization/statutory-pack/testdata/:
//   - dev-keys.json        : root + operational PRIVATE keys (JWK). *** DEV/TEST ONLY — never trusted in
//                            production; trust.ts only loads the dev ROOT public key outside production. ***
//   - dev-root.pub.json    : the dev root public key (paste into trust.ts DEV_ROOT)
//   - trust-bundle.dev.json: a root-signed trust bundle certifying the dev operational key
//   - sample-pack.dev.json : an operational-key-signed sample pack (interop fixture)
//   - vector.json          : a fixed {publicKey, payload, sig, checksum} interop test vector
//
// Re-run ONLY to rotate dev keys (the committed vector/keys then change). Not part of any build.
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'localization', 'statutory-pack', 'testdata');
mkdirSync(outDir, { recursive: true });

const SCHEMA = 1;
const FAR = '2099-01-01T00:00:00.000Z';
const ISSUED = '2026-01-01T00:00:00.000Z';

const gen = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ format: 'jwk' }), priv: privateKey, privJwk: privateKey.export({ format: 'jwk' }) };
};
const enc = (obj) => JSON.stringify(obj);
const sha256 = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const envelope = (keyId, payloadStr, privateKey) => ({
  schemaVersion: SCHEMA,
  keyId,
  sig: sign(null, Buffer.from(payloadStr, 'utf8'), privateKey).toString('base64'),
  payload: payloadStr,
  checksum: sha256(payloadStr),
});

const root = gen();
const op = gen();
const ROOT_ID = 'my-root-dev-1';
const OP_ID = 'my-op-dev-1';

// Trust bundle (root-signed) certifying the operational key.
const trustPayload = enc({
  sequence: 1,
  issuedAt: ISSUED,
  keys: [{ keyId: OP_ID, publicKey: op.pub.x, certifiedAt: ISSUED, expiresAt: FAR }],
  revoked: [],
});
const trustBundle = envelope(ROOT_ID, trustPayload, root.priv);

// Sample pack (operational-signed) — a tiny fixture; the real MY default pack is built in a later slice.
const packPayload = enc({
  country: 'MY',
  packVersion: '2026.01.01',
  issuedAt: ISSUED,
  validUntil: FAR,
  notes: 'dev sample pack (fixture)',
  rulesets: [{ version: 'dev-1', effectiveFrom: '2026-01-01', data: { hello: 'world' } }],
});
const samplePack = envelope(OP_ID, packPayload, op.priv);

// Interop test vector: a fixed payload + pubkey + sig the verifier must accept byte-for-byte.
const vectorPayload = enc({ msg: 'statutory-pack interop vector', n: 42 });
const vectorSig = sign(null, Buffer.from(vectorPayload, 'utf8'), op.priv).toString('base64');
const vector = { publicKey: op.pub.x, payload: vectorPayload, sig: vectorSig, checksum: sha256(vectorPayload) };

writeFileSync(
  join(outDir, 'dev-keys.json'),
  JSON.stringify(
    {
      _warning: 'DEV/TEST ONLY — these private keys are never trusted in production (see trust.ts).',
      root: { keyId: ROOT_ID, privateJwk: root.privJwk, publicKey: root.pub.x },
      op: { keyId: OP_ID, privateJwk: op.privJwk, publicKey: op.pub.x },
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(join(outDir, 'dev-root.pub.json'), JSON.stringify({ keyId: ROOT_ID, publicKey: root.pub.x }, null, 2) + '\n');
writeFileSync(join(outDir, 'trust-bundle.dev.json'), JSON.stringify(trustBundle, null, 2) + '\n');
writeFileSync(join(outDir, 'sample-pack.dev.json'), JSON.stringify(samplePack, null, 2) + '\n');
writeFileSync(join(outDir, 'vector.json'), JSON.stringify(vector, null, 2) + '\n');

console.log('dev root key for trust.ts:');
console.log(JSON.stringify({ keyId: ROOT_ID, publicKey: root.pub.x }));
console.log('wrote testdata to', outDir);
