/**
 * ADR-0181 — deploymentId for Next.js version-skew protection equals the per-build BUILD_ID, and
 * `next start` reads it back from the build it serves. The real-build proof (headers, html attribute,
 * manifests of two different builds behind Nginx) is the zero-downtime rehearsal workflow; this file
 * pins the phase logic.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_ID_PATTERN, newDeploymentId, nextDeploymentIdentity } from '../lib/next-deployment-identity';

const dist = (buildId: string | null, manifestId?: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-id-'));
  if (buildId !== null) fs.writeFileSync(path.join(dir, 'BUILD_ID'), buildId);
  fs.writeFileSync(path.join(dir, 'routes-manifest.json'), JSON.stringify(manifestId === undefined ? { version: 3 } : { version: 3, deploymentId: manifestId }));
  return dir;
};

describe('build phase', () => {
  it('chooses one id, uses it for both deploymentId and BUILD_ID, and exports it for build workers', async () => {
    const env: NodeJS.ProcessEnv = {};
    const c = nextDeploymentIdentity('phase-production-build', { env });
    expect(c.deploymentId).toMatch(DEPLOYMENT_ID_PATTERN);
    expect(c.deploymentId).toHaveLength(21);
    expect(await c.generateBuildId!()).toBe(c.deploymentId);
    expect(env.NEXT_DEPLOYMENT_ID).toBe(c.deploymentId);
    // A build worker re-evaluating next.config inherits the same id instead of drawing a new one.
    expect(nextDeploymentIdentity('phase-production-build', { env }).deploymentId).toBe(c.deploymentId);
  });

  it('draws a different id for every build, so a rebuild of the same commit is a different acceptance target', () => {
    const ids = new Set(Array.from({ length: 200 }, () => nextDeploymentIdentity('phase-production-build', { env: {} }).deploymentId));
    expect(ids.size).toBe(200);
    // 64 distinct URL-safe symbols: every 6-bit value maps to its own character.
    const symbols = new Set(Array.from({ length: 64 }, (_, v) => newDeploymentId(() => Buffer.alloc(21, v))[0]));
    expect(symbols.size).toBe(64);
    expect([...symbols].join('')).toMatch(/^[A-Za-z0-9_-]{64}$/);
  });

  it('refuses an inherited id Next would reject', () => {
    expect(() => nextDeploymentIdentity('phase-production-build', { env: { NEXT_DEPLOYMENT_ID: 'has space' } })).toThrow(/NEXT_DEPLOYMENT_ID/);
  });
});

describe('server phase', () => {
  it('serves the id the build compiled in, overriding a stray inherited value', () => {
    const env: NodeJS.ProcessEnv = { NEXT_DEPLOYMENT_ID: 'someOtherBuildId0000' };
    expect(nextDeploymentIdentity('phase-production-server', { env, distDir: dist('Abc_def-0123456789xyz\n', 'Abc_def-0123456789xyz') })).toEqual({ deploymentId: 'Abc_def-0123456789xyz' });
    expect(env.NEXT_DEPLOYMENT_ID).toBe('Abc_def-0123456789xyz');
  });

  it('leaves a build from before skew protection unprotected rather than skewed', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(nextDeploymentIdentity('phase-production-server', { env, distDir: dist('pi86G0t5I0ar_ymBCm8xn') })).toEqual({});
    expect(nextDeploymentIdentity('phase-production-server', { env, distDir: dist('pi86G0t5I0ar_ymBCm8xn', 'differentIdFromBuild0') })).toEqual({});
    expect(nextDeploymentIdentity('phase-production-server', { env, distDir: dist(null) })).toEqual({});
    expect(env.NEXT_DEPLOYMENT_ID).toBeUndefined();
  });

  it('does nothing in development or other phases', () => {
    expect(nextDeploymentIdentity('phase-development-server', { env: {} })).toEqual({});
    expect(nextDeploymentIdentity('phase-export', { env: {} })).toEqual({});
  });
});

describe('next.config wiring', () => {
  it('spreads the identity into the exported config for every phase', () => {
    const config = fs.readFileSync(path.join(__dirname, '..', 'next.config.ts'), 'utf8');
    const start = config.indexOf('export default (phase: string) => withNextIntl({');
    expect(start).toBeGreaterThan(0);
    expect(config.slice(start, start + 400)).toContain('...nextDeploymentIdentity(phase),');
  });
});
