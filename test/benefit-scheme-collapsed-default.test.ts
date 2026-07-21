/**
 * Feedback bca94601 — Benefit Scheme per-company sections start COLLAPSED.
 *
 * The R44 02a7082b accordion grouped schemes under collapsible per-company <details> sections, but every
 * section rendered with the `open` attribute, so the tab landed on a long fully-expanded list. This item
 * flips the starting position only: on load the list shows just each company's name + scheme count, and a
 * click expands/collapses exactly as before. Presentation only — no schema, service, or i18n change.
 *
 * The trap this guards: someone "helpfully" re-adding `open` (in any position, or as open={someFlag}) to
 * the per-company <details> and silently restoring the wall-of-schemes landing view. Assertion (a) is
 * anchored on the key={group.companyId} attribute so the attribute-bare Grade Groups <details> above it
 * can never be matched by mistake, and it is position-independent within the tag. Assertion (b) is the
 * anti-vacuity companion: if a refactor removed the accordion entirely, (a) would pass on an empty string,
 * so we pin the summary still rendering the company name + scheme count (kept deliberately minimal).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'components/benefit-scheme-config.tsx'), 'utf8');

describe('benefit scheme per-company sections collapsed by default', () => {
  it('the per-company details carries no open attribute (position-independent)', () => {
    const tag = src.match(/<details[^>]*key=\{group\.companyId\}[^>]*>/)?.[0] ?? '';
    expect(tag, 'per-company <details> opening tag must exist').not.toBe('');
    expect(tag).not.toMatch(/\bopen\b/);
  });

  it('the collapsed summary still shows company name + scheme count (anti-vacuity)', () => {
    expect(src).toMatch(/<summary\b/);
    expect(src).toContain('{group.name}');
    expect(src).toContain("t('schemeCount'");
  });
});
