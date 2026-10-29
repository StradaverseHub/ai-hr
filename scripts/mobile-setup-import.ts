/**
 * Import a signed mobile workplace setup into one customer (ADR-0161) — for an installation that does
 * not hold the Stradaverse signing key, such as a customer-run on-premise server. Run on the server by
 * the installation administrator, as the database owner, like the provisioning runner:
 *
 *   node --env-file=.env.production --import tsx scripts/mobile-setup-import.ts TENANT_UUID /PATH/company.aihr.json
 *
 * The file is accepted only when it verifies against the app's trust anchors and names THIS server's
 * sign-in origin and THIS customer's organization code (see importMobileSetup). Nothing is stored on a
 * refusal. The file holds public routing data only; this command never prints its contents.
 */
import { readFileSync, statSync } from 'node:fs';

const REASONS: Record<string, string> = {
  malformed: 'The file is not a signed workplace setup.',
  untrusted_key: 'The setup is not signed by a key the installed app trusts.',
  bad_signature: 'The setup signature is invalid; the file was changed after signing.',
  invalid_profile: 'The setup contents are invalid or unsupported.',
  not_workplace: 'The setup has no organization code for embedded sign-in.',
  expired: 'The setup has expired. Ask for a newly signed setup.',
  not_yet_valid: 'The setup is not valid yet. Check this server clock.',
  origin_mismatch: "The setup is for another server address. It must name this server's AUTH_PUBLIC_ORIGIN.",
  organization_mismatch: "The setup is for another organization. It must name this customer's organization code.",
  organization_unavailable: 'This customer has no embedded sign-in organization code on this server.',
};

async function main() {
  const [tenantId, file, ...rest] = process.argv.slice(2);
  if (!tenantId || !file || rest.length || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId))
    throw new Error('Usage: mobile-setup-import.ts TENANT_UUID SETUP_FILE');
  if (statSync(file).size > 16_384) throw new Error(REASONS.malformed);
  const raw = readFileSync(file, 'utf8');
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is not set (run this from the installation directory on the server).');
  const { createDb, client } = await import('../db/client');
  const { importMobileSetup } = await import('./mobile-setup-issuance');
  const owner = createDb(url, { max: 1 });
  try {
    const result = await importMobileSetup(owner, tenantId.toLowerCase(), raw);
    console.log(`Imported the mobile workplace setup (key ${result.keyId}, valid until ${new Date(result.expiresAt * 1000).toISOString()})${result.replaced ? ', replacing the previous setup' : ''}.`);
  } finally {
    await owner.client.end({ timeout: 5 });
    await client.end({ timeout: 5 });
  }
}

main().catch(error => {
  const code = (error as { code?: unknown })?.code;
  console.error(typeof code === 'string' && REASONS[code] ? REASONS[code] : error instanceof Error ? error.message : 'Import failed.');
  process.exitCode = 1;
});
