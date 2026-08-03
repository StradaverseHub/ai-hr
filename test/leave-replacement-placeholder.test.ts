/**
 * 645e67c4 — the Replacement Leave tab and its PLACEHOLDER page.
 *
 * The item's description asks for a full central replacement-leave module; its expected_behavior says
 * plainly that no functional components, forms or business logic are required yet. expected_behavior is
 * the narrower and more explicit statement, so the placeholder is the whole scope — and that is exactly
 * the kind of decision that erodes silently. These assertions pin the three things that would make the
 * page WRONG rather than merely unfinished:
 *
 *   1. it stays a placeholder (no form, no server action, no data access),
 *   2. it stays GUARDED and registered, so an empty page is not an unguarded one,
 *   3. its copy keeps saying that replacement leave already works.
 *
 * (3) is the one worth defending hardest. Replacement leave is live today — `toil_accrual` is the source
 * of truth for no-double-pay and expiry, and the REPLACEMENT leave type is on the employee surfaces. A
 * page that reads as "not built yet" would tell an admin a false thing about their own system.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { REGISTERED_ROUTES } from '../lib/permissions';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PAGE_REL = 'app/admin/leave/replacement/page.tsx';
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

type Dict = Record<string, unknown>;
const load = (loc: string): Dict => JSON.parse(read(`messages/${loc}.json`));
const getPath = (obj: Dict, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);

describe('645e67c4 · Replacement Leave tab', () => {
  it('the tab strip carries a replacement entry pointing at the real route', () => {
    const src = read('components/leave-tabs.tsx');
    expect(src).toContain("{ key: 'replacement', href: '/admin/leave/replacement', label: t('replacement') }");
    // The active-prop union must admit it, or the page cannot mark itself current.
    expect(src).toMatch(/active:\s*'types'[^;]*\|\s*'replacement'\s*\|/);
  });

  it('the tab sits between Payroll Related and Audit, so Audit stays last', () => {
    const src = read('components/leave-tabs.tsx');
    const at = (key: string) => src.indexOf(`{ key: '${key}'`);
    expect(at('payroll')).toBeGreaterThan(-1);
    expect(at('replacement')).toBeGreaterThan(at('payroll'));
    expect(at('audit')).toBeGreaterThan(at('replacement'));
  });

  it('the page is guarded by requireAdmin and registered in the permission map', () => {
    expect(read(PAGE_REL)).toContain('requireAdmin()');
    // Registration is what test/function-access.test.ts checks both ways; assert it directly too, because
    // an empty page is precisely the one somebody would think is safe to leave unregistered.
    expect(REGISTERED_ROUTES.has('/admin/leave/replacement')).toBe(true);
  });

  it('the page marks itself as the active tab', () => {
    expect(read(PAGE_REL)).toContain('<LeaveTabs active="replacement" />');
  });

  it('the page stays a PLACEHOLDER — no form, no action, no data access', () => {
    const src = read(PAGE_REL);
    expect(src).not.toContain('<form');
    expect(src).not.toMatch(/\baction=\{/);
    expect(src).not.toMatch(/\bfrom '@\/core\//);
    expect(src).not.toMatch(/\bwithTenant\b/);
  });

  it('every locale has the tab label and the three placeholder strings', () => {
    const keys = [
      'admin.leaveTabs.replacement',
      'admin.leave.replacementModuleTitle',
      'admin.leave.replacementModuleUnderDevelopment',
      'admin.leave.replacementModuleExistingNote',
    ];
    const missing: string[] = [];
    for (const loc of LOCALES) {
      const d = load(loc);
      for (const k of keys) {
        const v = getPath(d, k);
        if (typeof v !== 'string' || v.trim() === '') missing.push(`${loc}:${k}`);
      }
    }
    expect(missing, `blank or absent: ${missing.join(', ')}`).toEqual([]);
  });

  it('the copy does not claim replacement leave is unavailable — it already works', () => {
    // Guards the substance of the note rather than its wording: the English string must still say the
    // feature works TODAY. If someone rewrites it into a bare "coming soon", this fails.
    const note = String(getPath(load('en'), 'admin.leave.replacementModuleExistingNote'));
    expect(note).toMatch(/already works today/i);
    expect(read(PAGE_REL)).toContain("t('replacementModuleExistingNote')");
  });
});
