/**
 * ADR-0077 D5 / slice 7 — the control plane's privilege boundary.
 *
 * The boundary is a DATABASE ROLE, not a routing rule. ADR-0077 considered a separate application and
 * rejected it, so this role is what carries the isolation: `ai_hr_app` must never gain cross-tenant
 * read, and a leak must require two independent mistakes rather than one.
 *
 * These tests pin the two ways the boundary gets defeated in practice, and neither is a code bug:
 *   1. A FALLBACK. "PLATFORM_DATABASE_URL isn't set, use DATABASE_URL" turns a missing config into a
 *      silently powerless plane; falling back to the owner URL turns it into a silently over-privileged
 *      one. Both are worse than crashing on boot.
 *   2. AN ENV FILE. Pointing PLATFORM_DATABASE_URL at the app credentials satisfies every check that
 *      only asks "is it set?", while defeating the entire point. It is an easy copy-paste to make.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertPlatformUrl,
  PlatformConnectionError,
  platformPlaneConfigured,
  __resetPlatformDbForTests,
} from '../db/platform';

const APP = 'postgres://ai_hr_app:pw@localhost:5433/ai_hr';
const OWNER = 'postgres://ai_hr_owner:pw@localhost:5433/ai_hr';
const PLATFORM = 'postgres://ai_hr_platform:pw@localhost:5433/ai_hr';

afterEach(() => __resetPlatformDbForTests());

describe('slice 7 — the platform connection has NO fallback', () => {
  it('refuses when PLATFORM_DATABASE_URL is unset', () => {
    expect(() => assertPlatformUrl(undefined, APP, OWNER)).toThrow(PlatformConnectionError);
  });

  it('refuses an empty / whitespace URL rather than treating it as absent-but-fine', () => {
    expect(() => assertPlatformUrl('', APP, OWNER)).toThrow(PlatformConnectionError);
    expect(() => assertPlatformUrl('   ', APP, OWNER)).toThrow(PlatformConnectionError);
  });

  it('says WHY, naming both fallbacks it refuses to make', () => {
    // The message is the mitigation: whoever hits this at 3am needs to know that borrowing either
    // other role is wrong, not just that a variable is missing.
    try {
      assertPlatformUrl(undefined, APP, OWNER);
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('application role');
      expect(msg).toContain('owner role');
    }
  });
});

describe('slice 7 — the boundary cannot be defeated by an env file', () => {
  it('REFUSES a platform URL identical to the app URL', () => {
    // This is the copy-paste that satisfies "is it set?" while removing the privilege boundary.
    expect(() => assertPlatformUrl(APP, APP, OWNER)).toThrow(/defeating the privilege boundary/);
  });

  it('REFUSES a platform URL identical to the owner URL', () => {
    // The owner can ALTER the schema and drop policies. The control plane reads tenancy and billing.
    expect(() => assertPlatformUrl(OWNER, APP, OWNER)).toThrow(/ALTER the/);
  });

  it('accepts a genuinely distinct platform URL', () => {
    expect(assertPlatformUrl(PLATFORM, APP, OWNER)).toBe(PLATFORM);
  });

  it('still accepts when the app/owner URLs are unknown — it cannot compare what it is not given', () => {
    expect(assertPlatformUrl(PLATFORM, undefined, undefined)).toBe(PLATFORM);
  });
});

describe('slice 7 — a misconfigured plane reports unavailable and still refuses to run', () => {
  const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
      saved[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('reports NOT configured when the URL is absent', () => {
    withEnv({ PLATFORM_DATABASE_URL: undefined }, () => {
      expect(platformPlaneConfigured()).toBe(false);
    });
  });

  it('reports NOT configured when the URL is set but WRONG — a page renders unavailable, not a leak', () => {
    withEnv({ PLATFORM_DATABASE_URL: APP, DATABASE_URL: APP }, () => {
      expect(platformPlaneConfigured()).toBe(false);
    });
  });

  it('reports configured for a distinct URL', () => {
    withEnv({ PLATFORM_DATABASE_URL: PLATFORM, DATABASE_URL: APP, MIGRATION_DATABASE_URL: OWNER }, () => {
      expect(platformPlaneConfigured()).toBe(true);
    });
  });
});

describe('slice 7 — the migration states the privilege, and the bootstrap creates the role', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

  it('bootstrap creates ai_hr_platform with BYPASSRLS and WITHOUT superuser', () => {
    const sql = read('deploy/bootstrap-db.sql');
    expect(sql).toContain('ai_hr_platform');
    expect(sql).toMatch(/CREATE ROLE ai_hr_platform[^']*BYPASSRLS/);
    // BYPASSRLS is the whole privilege. Superuser would also let it drop policies and read the
    // columns the migrations deliberately REVOKE.
    expect(sql).toMatch(/CREATE ROLE ai_hr_platform[^']*NOSUPERUSER/);
  });

  it('platform_user was already revoked from ai_hr_app in 0313 — 0351 does not repeat it', () => {
    // The TABLE side of D5 has been right since slice 1. Repeating the revoke in 0351 would suggest it
    // was missing, and the next reader would go looking for the gap it closed.
    expect(read('db/migrations/0313_module_entitlements.sql')).toMatch(/REVOKE ALL ON platform_user FROM ai_hr_app/);
  });

  it('0351 FORCEs RLS — 0313 only ENABLEd it, which the table owner still bypasses', () => {
    // ENABLE alone reads as a stronger guarantee than it gives: the owner role (which runs migrations
    // and seeds) bypasses every policy until FORCE is set. The kind of gap found during an audit.
    const sql = read('db/migrations/0351_platform_plane.sql');
    expect(sql).toContain('ALTER TABLE platform_user FORCE ROW LEVEL SECURITY');
    expect(sql).not.toMatch(/CREATE POLICY .* ON platform_user/);
  });

  it('tenant is READ-ONLY from the platform pool — suspension and closure are not console clicks', () => {
    const sql = read('db/migrations/0351_platform_plane.sql');
    // r105 made dunning the only thing that suspends; 0350 made closure dual-controlled. Neither may
    // be reachable as a write from a support session.
    expect(sql).not.toMatch(/GRANT[^;]*(INSERT|UPDATE)[^;]*\btenant\b[^;_][^;]*TO ai_hr_platform/);
  });

  it('the platform grant list is ENUMERATED, not "ALL TABLES"', () => {
    // The grant list IS the policy. A blanket grant would hand the control plane every table a future
    // migration happens to add, which is not what D5 authorises.
    const sql = read('db/migrations/0351_platform_plane.sql');
    expect(sql).not.toMatch(/GRANT[^;]*ON ALL TABLES[^;]*TO ai_hr_platform/);
    expect(sql).toMatch(/GRANT SELECT ON tenant, module, domain_event TO ai_hr_platform/);
  });
});

describe('slice 7 — the sweep units exist, and none of them are enabled by deploy.sh', () => {
  const dir = path.resolve(__dirname, '..', 'deploy', 'systemd');
  const SWEEPS = ['usage-capture', 'accrue-earned', 'expire-carry', 'expire-aged-leave', 'apply-dunning'];

  it('every built sweep has a service and a timer', () => {
    for (const s of SWEEPS) {
      expect(fs.existsSync(path.join(dir, `aihr-${s}.service`)), `${s}.service`).toBe(true);
      expect(fs.existsSync(path.join(dir, `aihr-${s}.timer`)), `${s}.timer`).toBe(true);
    }
  });

  it('deploy.sh does NOT install or enable timers — scheduling is an owner decision', () => {
    // A deploy that quietly started suspending customers would be the exact unattended action r105
    // refused. If this ever fails, someone has made scheduling a side effect of shipping code.
    const sh = fs.readFileSync(path.resolve(__dirname, '..', 'deploy', 'deploy.sh'), 'utf8');
    expect(sh).not.toMatch(/systemctl\s+enable/);
    expect(sh).not.toMatch(/aihr-.*\.timer/);
  });

  it('the dunning sweep ships WITHOUT --apply, so enabling its timer suspends nobody', () => {
    const unit = fs.readFileSync(path.join(dir, 'aihr-apply-dunning.service'), 'utf8');
    expect(unit).toContain('apply-dunning.ts');
    expect(unit).not.toContain('--apply');
  });

  it('usage-capture runs BEFORE the leave sweeps, so it meters the day they then mutate', () => {
    const usage = fs.readFileSync(path.join(dir, 'aihr-usage-capture.timer'), 'utf8');
    const accrue = fs.readFileSync(path.join(dir, 'aihr-accrue-earned.timer'), 'utf8');
    const hourOf = (s: string) => Number(/OnCalendar=\*-\*-\* (\d{2}):/.exec(s)![1]);
    expect(hourOf(usage)).toBeLessThan(hourOf(accrue));
  });

  it('every unit pins node20 — the default node predates --env-file', () => {
    for (const s of SWEEPS) {
      const unit = fs.readFileSync(path.join(dir, `aihr-${s}.service`), 'utf8');
      expect(unit, s).toContain('/opt/node20/bin/node');
    }
  });

  it('timers are Persistent — a skipped usage day is unbillable forever', () => {
    for (const s of SWEEPS) {
      expect(fs.readFileSync(path.join(dir, `aihr-${s}.timer`), 'utf8'), s).toContain('Persistent=true');
    }
  });
});
