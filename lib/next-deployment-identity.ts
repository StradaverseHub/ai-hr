/**
 * ADR-0181 — Next.js version-skew protection for zero-downtime releases.
 *
 * During a zero-downtime switch the browser of someone already signed in holds pages, client chunks
 * and Server Action ids from the PREVIOUS build while Nginx starts sending their requests to the new
 * one. Next 16 handles that when a `deploymentId` is configured: navigation requests carry it, a
 * mismatch turns a client navigation into a full reload, and static asset URLs carry `?dpl=`.
 *
 * Two constraints from this repository shape how the id is chosen:
 *
 * 1. The BUILD_ID must stay unique per build. Staging acceptance, package publication and the
 *    deploy-state receipt all pin `.next/BUILD_ID` ("a rebuild of the same SHA creates a different
 *    acceptance target"). Next makes the BUILD_ID a constant when `deploymentId` is set without
 *    `generateBuildId`, so we supply both and make them the SAME value.
 * 2. `next start` re-evaluates next.config and reads `deploymentId` from it, so a value generated at
 *    random in the config would differ between `next build` and `next start`. The server phase
 *    therefore reads the id back from the build output it is about to serve.
 *
 * `NEXT_DEPLOYMENT_ID` overrides the config in Next's loader (node_modules/next/dist/server/config.js),
 * so the chosen value is also written there: build workers that reload the config inherit it, and a
 * stray inherited value can never make the server disagree with its own bundles.
 *
 * Dependency-free on purpose: next.config.ts loads it before any bundling.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Next's own constraint on deploymentId (next/dist/build/index.js). */
export const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const PHASE_PRODUCTION_BUILD = 'phase-production-build';
const PHASE_PRODUCTION_SERVER = 'phase-production-server';
const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

const FIRST = ALPHABET.replace(/[-_]/g, '');

/**
 * The same 21-character URL-safe shape as Next's default nanoid build id, except that it never starts
 * with '-' or '_'. The id is passed as an argument to release tooling (release-web.sh, node -e,
 * rsync paths); a leading '-' is read as an option (observed: a real build id "-ydHp…" made node exit 9).
 */
export function newDeploymentId(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(21);
  let id = FIRST[bytes[0] % FIRST.length];
  for (let i = 1; i < 21; i++) id += ALPHABET[bytes[i] & 63];
  return id;
}

export type DeploymentIdentityConfig = { deploymentId?: string; generateBuildId?: () => Promise<string> };

export function nextDeploymentIdentity(
  phase: string,
  { env = process.env, distDir = path.join(process.cwd(), '.next'), random }: { env?: NodeJS.ProcessEnv; distDir?: string; random?: (n: number) => Buffer } = {},
): DeploymentIdentityConfig {
  if (phase === PHASE_PRODUCTION_BUILD) {
    const inherited = env.NEXT_DEPLOYMENT_ID;
    if (inherited !== undefined && inherited !== '' && !DEPLOYMENT_ID_PATTERN.test(inherited))
      throw new Error(`NEXT_DEPLOYMENT_ID must match ${DEPLOYMENT_ID_PATTERN}`);
    const id = inherited || newDeploymentId(random);
    env.NEXT_DEPLOYMENT_ID = id;
    return { deploymentId: id, generateBuildId: async () => id };
  }
  if (phase === PHASE_PRODUCTION_SERVER) {
    // The build records the deploymentId it compiled into the client in routes-manifest.json, and
    // only when one was configured. A build from before ADR-0181 has none there: serving it with an
    // id its bundles never had would make every client navigation look skewed, so it runs unchanged.
    let id: string;
    let built: unknown;
    try {
      id = readFileSync(path.join(distDir, 'BUILD_ID'), 'utf8').trim();
      built = (JSON.parse(readFileSync(path.join(distDir, 'routes-manifest.json'), 'utf8')) as { deploymentId?: unknown }).deploymentId;
    } catch { return {}; } // no build output: Next itself refuses to start
    if (built !== id || !DEPLOYMENT_ID_PATTERN.test(id)) return {};
    env.NEXT_DEPLOYMENT_ID = id;
    return { deploymentId: id };
  }
  return {};
}
