import { afterEach, describe, expect, it } from 'vitest';
import { demoSwitcherEnabled } from '../lib/demo-mode';

/**
 * The demo hatch (ADR-0072 follow-up). The dev identity switcher is normally dev-only, but the gated
 * consultant demo re-enables it in production via ALLOW_DEMO_SESSION. A real deployment never sets the
 * flag → real WorkOS auth. These pin the cases so the hardening can't silently regress.
 */
function setEnv(k: string, v: string | undefined) {
  if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
  else (process.env as Record<string, string>)[k] = v;
}

describe('demoSwitcherEnabled (demo hatch)', () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedFlag = process.env.ALLOW_DEMO_SESSION;

  afterEach(() => {
    setEnv('NODE_ENV', savedNodeEnv);
    setEnv('ALLOW_DEMO_SESSION', savedFlag);
  });

  it('is ON in development regardless of the flag', () => {
    setEnv('NODE_ENV', 'development');
    setEnv('ALLOW_DEMO_SESSION', undefined);
    expect(demoSwitcherEnabled()).toBe(true);
  });

  it('is ON in the test env', () => {
    setEnv('NODE_ENV', 'test');
    expect(demoSwitcherEnabled()).toBe(true);
  });

  it('is OFF in production with no flag (real-auth hardening holds)', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('ALLOW_DEMO_SESSION', undefined);
    expect(demoSwitcherEnabled()).toBe(false);
  });

  it('is ON in production ONLY when ALLOW_DEMO_SESSION=true (the gated demo)', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('ALLOW_DEMO_SESSION', 'true');
    expect(demoSwitcherEnabled()).toBe(true);
  });

  it('treats any non-"true" flag value as OFF in production', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('ALLOW_DEMO_SESSION', '1');
    expect(demoSwitcherEnabled()).toBe(false);
  });
});
