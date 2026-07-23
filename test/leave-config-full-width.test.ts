/**
 * Leave Configuration full-width guard (user-reported 2026-07-23: narrow band with wide empty
 * margins on both sides of every Leave Configuration tab).
 *
 * Source-static guard (precedent: test/layout-scroll-containment.test.ts). All seven Leave
 * Configuration pages (the six tabs plus Import Leave Balances) used to open with a
 * "mx-auto max-w-5xl" root wrapper, capping the content to a narrow centered band. Those caps were
 * removed so the pages inherit the app shell's <main> (min-w-0 flex-1 in app/layout.tsx) as their
 * common responsive container — every tab stretches to the full work area, identically, at any
 * window size. This test fails if anyone re-adds a private width cap to any of these screens,
 * including the tab-content components that render inside them, so the tabs cannot drift apart.
 *
 * Intent and limits:
 * - This polices PAGE-LEVEL width caps only: a single className string containing BOTH `mx-auto`
 *   AND a `max-w-...xl` token (order-tolerant). Requiring the pair avoids false positives on
 *   legitimate inner elements — dialogs (max-w-lg / max-w-xl with fixed + translate centering,
 *   no mx-auto) and form fields (e.g. max-w-md in leave-type-panel.tsx) cap their own width
 *   without centering the page, and a future small centered empty-state remains permitted.
 * - application-rules' max-w-56 span is intentionally out of reach: it has no mx-auto.
 * - Classes composed via cn() or variables escape a source check like this one; the manual
 *   browser walk of all tabs is the real backstop for those.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** Every page.tsx under app/admin/leave/ (recursive), repo-relative. */
function leavePages(dir = 'app/admin/leave'): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...leavePages(rel));
    else if (entry.name === 'page.tsx') out.push(rel);
  }
  return out;
}

// Tab-content components where a width cap could reappear unseen by the page glob: the shared tab
// strip, the entitlements two-pane workspace and per-type panel, the import client component, and
// the approval editor pieces (app/admin/leave-approval/* render inside the approval and
// entitlements tabs; that route's page.tsx itself is a pure redirect and stays out of scope).
const TAB_CONTENT_COMPONENTS = [
  'components/leave-tabs.tsx',
  'components/leave-type-workspace.tsx',
  'components/leave-type-panel.tsx',
  'app/admin/leave/import/leave-ledger-import.tsx',
  'app/admin/leave-approval/editor.tsx',
  'app/admin/leave-approval/rule-builder.tsx',
  'app/admin/leave-approval/workflow-matrix.tsx',
  'app/admin/leave-approval/template-manager.tsx',
  'app/admin/leave-approval/step-list-editor.tsx',
  'app/admin/leave-approval/escalation-editor.tsx',
];

/** All string-literal className values in a source file (double-quoted or template literal). */
function classNameLiterals(source: string): string[] {
  return [...source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);
}

const capsPage = (cls: string) => /\bmx-auto\b/.test(cls) && /\bmax-w-\d*xl\b/.test(cls);

describe('leave configuration — no page-level width caps', () => {
  const files = [...leavePages(), ...TAB_CONTENT_COMPONENTS];

  it('covers the six tabs plus the import page', () => {
    // Coverage floor, not an exact list: a new leave sub-page is welcome (the glob picks it up
    // automatically), but if a route refactor moves these seven the glob must be updated with it.
    expect(leavePages()).toEqual(
      expect.arrayContaining([
        'app/admin/leave/page.tsx',
        'app/admin/leave/entitlements/page.tsx',
        'app/admin/leave/application-rules/page.tsx',
        'app/admin/leave/approval/page.tsx',
        'app/admin/leave/payroll/page.tsx',
        'app/admin/leave/audit/page.tsx',
        'app/admin/leave/import/page.tsx',
      ]),
    );
  });

  it.each(files)('%s has no centered max-width cap', (file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const offending = classNameLiterals(source).filter(capsPage);
    expect(offending, `${file} re-introduces a page-level width cap: ${offending.join(' | ')}`).toEqual([]);
  });
});
