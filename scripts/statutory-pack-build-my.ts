// Build the bundled MY baseline pack carrying DEFAULT_MY_STATUTORY, signed with the DEV operational key
// (ADR-0020). Re-run when the verified code default changes so the shipped pack stays in step. The pack's
// `data` equals DEFAULT_MY_STATUTORY, so ingesting it yields byte-identical payroll to the code floor.
//
// Run: node --import tsx scripts/statutory-pack-build-my.ts
import { createPrivateKey, sign, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';

const here = dirname(fileURLToPath(import.meta.url));
const packRoot = join(here, '..', 'localization', 'statutory-pack');
const bundled = join(packRoot, 'bundled');
mkdirSync(bundled, { recursive: true });

const keys = JSON.parse(readFileSync(join(packRoot, 'testdata', 'dev-keys.json'), 'utf8'));
const priv = createPrivateKey({ key: keys.op.privateJwk, format: 'jwk' });

const payload = JSON.stringify({
  country: 'MY',
  packVersion: '2026.01.01',
  issuedAt: '2026-01-01T00:00:00.000Z',
  validUntil: '2099-01-01T00:00:00.000Z',
  notes: 'Bundled MY baseline (DEFAULT_MY_STATUTORY). DEV-signed; replaced by a vendor-signed pack in production.',
  rulesets: [{ version: DEFAULT_MY_STATUTORY.version, effectiveFrom: '2026-01-01', data: DEFAULT_MY_STATUTORY }],
});
const sig = sign(null, Buffer.from(payload, 'utf8'), priv).toString('base64');
const checksum = createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex');
const envelope = { schemaVersion: 1, keyId: keys.op.keyId, sig, payload, checksum };

writeFileSync(join(bundled, 'my-2026.01.01.pack.json'), JSON.stringify(envelope, null, 2) + '\n');
copyFileSync(join(packRoot, 'testdata', 'trust-bundle.dev.json'), join(bundled, 'my.trust.json'));

console.log('wrote bundled MY pack + trust bundle to', bundled);
