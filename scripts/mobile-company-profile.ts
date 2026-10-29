/** Offline operator tooling: private signing keys never enter the mobile project or a connection file. */
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import QRCode from 'qrcode';
import { validCompanyProfile, type CompanyProfile } from '../lib/mobile-connection';
import { workplaceSetupLinks } from '../lib/mobile-workplace-setup';
import {
  WorkplaceSetupSignerError, approvedAnchor, loadSigningKey, setupHosting, signCompanyProfile, workplaceProfile,
  type SignedEnvelope, type SignerFailure, type TrustAnchor,
} from '../lib/mobile-workplace-setup-signer';

const USAGE = 'Usage: mobile-company-profile.ts keygen PRIVATE_PEM KEY_ID TRUST_JSON | sign PRIVATE_PEM PROFILE_JSON SIGNED_JSON | ' +
  'setup PRIVATE_PEM PROFILE_JSON NEW_OUTPUT_DIRECTORY | ' +
  'customer PRIVATE_PEM NEW_OUTPUT_DIRECTORY --origin HTTPS_ORIGIN --organization CODE --name DISPLAY_NAME [--hosting cloud|on-premise]';

/** Operator-facing wording for the shared signer's codes. Never echoes a path, key or payload. */
const MESSAGES: Record<SignerFailure, string> = {
  key_not_configured: 'A private signing key path is required.',
  key_path_invalid: 'Keep the private key outside the source and build tree.',
  key_unreadable: 'The private signing key could not be read.',
  key_permissions: 'Private signing keys must be accessible only to their owner.',
  key_type: 'An Ed25519 signing key is required.',
  key_untrusted: 'This key is not in the installed app trust anchors.',
  anchor_validity: 'The setup would outlive the validity of its app trust anchor.',
  hosting_invalid: 'Hosting must be cloud or on-premise.',
  profile_invalid: 'Invalid, expired or unsupported company setup file.',
};

/** `--flag value` pairs only; a repeated, unknown or valueless flag is refused rather than guessed. */
function customerFlags(args: string[]) {
  const allowed = new Set(['--origin', '--organization', '--name', '--hosting']), values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!allowed.has(flag) || values.has(flag) || value === undefined || value.startsWith('--')) throw new Error(USAGE);
    values.set(flag, value);
  }
  for (const flag of ['--origin', '--organization', '--name']) if (!values.get(flag)?.trim()) throw new Error(USAGE);
  return { origin: values.get('--origin')!, organization: values.get('--organization')!, name: values.get('--name')!, hosting: values.get('--hosting') };
}

function readTrust(): TrustAnchor[] {
  return JSON.parse(readFileSync('mobile/connections/trust.json', 'utf8')) as TrustAnchor[];
}

async function writeSetupBundle(outputPath: string, raw: string) {
  const links = workplaceSetupLinks(raw);
  // Generate everything before creating outputs. An oversized QR or invalid profile leaves no bundle.
  const png = await QRCode.toBuffer(links.web, { errorCorrectionLevel: 'M', margin: 4, width: 768 });
  mkdirSync(outputPath);
  writeFileSync(resolve(outputPath, 'company.aihr.json'), raw, { flag: 'wx' });
  writeFileSync(resolve(outputPath, 'setup-link.txt'), links.web + '\n', { flag: 'wx' });
  writeFileSync(resolve(outputPath, 'setup-qr.png'), png, { flag: 'wx' });
  console.log('Created the signed workplace setup file, HTTPS setup link and QR image. They contain no credentials.');
}

const pretty = (envelope: SignedEnvelope) => JSON.stringify(envelope, null, 2) + '\n';

async function main() {
  const args = process.argv.slice(2), command = args[0];
  if (command === 'customer') {
    const [, keyPath, outputPath, ...rest] = args;
    if (!keyPath || !outputPath || keyPath.startsWith('--') || outputPath.startsWith('--')) throw new Error(USAGE);
    const flags = customerFlags(rest);
    if (resolve(keyPath).startsWith(resolve('.') + '/')) throw new Error(MESSAGES.key_path_invalid);
    if (existsSync(outputPath)) throw new Error('Refusing to overwrite an existing output or private key.');
    mkdirSync(dirname(outputPath), { recursive: true });
    const key = loadSigningKey(resolve(keyPath), resolve('.')), trust = readTrust(), anchor = approvedAnchor(key, trust);
    const profile = workplaceProfile({ origin: flags.origin, organization: flags.organization, name: flags.name, hosting: setupHosting(flags.hosting) }, { anchor });
    await writeSetupBundle(outputPath, pretty(signCompanyProfile(profile, key, trust)));
    return;
  }
  const [, keyPath, inputPath, outputPath] = args;
  if (!['keygen', 'sign', 'setup'].includes(command) || !keyPath || !inputPath || !outputPath) throw new Error(USAGE);
  if (resolve(keyPath).startsWith(resolve('.') + '/')) throw new Error(MESSAGES.key_path_invalid);
  if (existsSync(outputPath) || (command === 'keygen' && existsSync(keyPath))) throw new Error('Refusing to overwrite an existing output or private key.');
  mkdirSync(dirname(outputPath), { recursive: true });
  if (command === 'keygen') {
    const pair = generateKeyPairSync('ed25519');
    writeFileSync(keyPath, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    const jwk = pair.publicKey.export({ format: 'jwk' });
    writeFileSync(outputPath, JSON.stringify([{ keyId: inputPath, publicKey: jwk.x }], null, 2) + '\n', { flag: 'wx' });
    console.log('Created private operator key and public app trust anchor. Back up the private key securely; never distribute it.');
    return;
  }
  const key = loadSigningKey(resolve(keyPath), resolve('.'));
  const profile: CompanyProfile = validCompanyProfile(JSON.parse(readFileSync(inputPath, 'utf8')));
  const raw = pretty(signCompanyProfile(profile, key, readTrust()));
  if (command === 'setup') { await writeSetupBundle(outputPath, raw); return; }
  writeFileSync(outputPath, raw, { flag: 'wx' });
  console.log('Signed public company setup file. It contains no credentials.');
}
main().catch(error => {
  console.error(error instanceof WorkplaceSetupSignerError ? MESSAGES[error.code] : error instanceof Error ? error.message : 'Company setup failed.');
  process.exitCode = 1;
});
