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
 * - The Leave Year row's max-w-56 span (on entitlements since 1e4eb8af relocated the section) is
 *   intentionally out of reach: it has no mx-auto.
 * - Classes composed via cn() or variables escape a source check like this one; the manual
 *   browser walk of all tabs is the real backstop for those.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/** Every page.tsx under one directory (recursive), repo-relative. */
function pagesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...pagesUnder(rel));
    else if (entry.name === 'page.tsx') out.push(rel);
  }
  return out;
}

/**
 * a6fe37fc ROUND 5 (cutover) — THE GLOB FOLLOWS THE MODULE.
 *
 * The convention this file owns is "no page-level width cap on a Leave Configuration screen". Leave
 * Configuration is being replaced by a new module under `app/admin/leave-config/`, one screen per commit,
 * so scanning only the old directory would let the cap reappear on every screen an administrator actually
 * opens while the guard stayed green over a row of redirect stubs. Both trees are walked: the old one
 * keeps its stubs covered (a stub can never grow a cap — cheap to keep) and the new one is where the
 * screens are.
 */
function leavePages(): string[] {
  return [...pagesUnder('app/admin/leave'), ...pagesUnder('app/admin/leave-config')];
}

// Tab-content components where a width cap could reappear unseen by the page glob: the entitlements
// two-pane workspace and per-type panel, the import client component, and
// the approval editor pieces (app/admin/leave-approval/* render inside the approval and
// entitlements tabs; that route's page.tsx itself is a pure redirect and stays out of scope).
const TAB_CONTENT_COMPONENTS = [
  // 645e67c4 — components/leave-tabs.tsx is deleted (Leave config is a sidebar fly-out now). The width
  // cap it was scanned for cannot reappear in a file that no longer exists; the destinations it linked
  // to are all covered by the page glob above.
  'components/leave-type-workspace.tsx',
  // a6fe37fc ROUND 5 (cutover) — `components/leave-type-panel.tsx` STOOD HERE and is DELETED with the
  // page that mounted it. Its width cap cannot reappear in a file that no longer exists; the two files
  // that replaced it are scanned instead, so the convention follows the screen rather than lapsing.
  'app/admin/leave-config/types/leave-type-tabs.tsx',
  'app/admin/leave-config/types/leave-type-sub-forms.tsx',
  'app/admin/leave/import/leave-ledger-import.tsx',
  'app/admin/leave-approval/editor.tsx',
  'app/admin/leave-approval/rule-builder.tsx',
  // 706d34e8 — workflow-matrix.tsx is DELETED with the per-rule Approval Workflows list it rendered, so
  // there is no longer a file here for a width cap to reappear in. Removing the entry is the shrink that
  // follows the deletion, not a relaxation: every surviving approval component is still scanned below.
  'app/admin/leave-approval/template-manager.tsx',
  'app/admin/leave-approval/step-list-editor.tsx',
  'app/admin/leave-approval/escalation-editor.tsx',
  // f1b994e3 — the Leave Config Audit tab is retired into the CENTRAL Audit Trail, so the destination
  // this convention has to hold on moved with it. app/admin/leave/audit/page.tsx is now a redirect stub
  // (still covered by the glob above, and a stub can never grow a width cap); app/admin/audit/page.tsx
  // is the page a reader now opens from Leave Config, and it carried `mx-auto max-w-5xl` until this
  // change, with a filter grid that grew from five controls to eight. Scanned here rather than in a new
  // file because this test owns the convention.
  'app/admin/audit/page.tsx',
];

/** All string-literal className values in a source file (double-quoted or template literal). */
function classNameLiterals(source: string): string[] {
  return [...source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);
}

const capsPage = (cls: string) => /\bmx-auto\b/.test(cls) && /\bmax-w-\d*xl\b/.test(cls);

describe('leave configuration — no page-level width caps', () => {
  const files = [...leavePages(), ...TAB_CONTENT_COMPONENTS];

  it('covers the five tabs plus the import page and the retired-tab stub', () => {
    // Coverage floor, not an exact list: a new leave sub-page is welcome (the glob picks it up
    // automatically), but if a route refactor moves these the glob must be updated with it.
    // 1e4eb8af retired the Application Rules TAB; its route stays in the list as a redirect stub, which
    // is exactly what a width cap can never reappear in — cheap to keep, so it stays covered.
    expect(leavePages()).toEqual(
      expect.arrayContaining([
        'app/admin/leave/page.tsx',
        'app/admin/leave/entitlements/page.tsx',
        'app/admin/leave/application-rules/page.tsx',
        'app/admin/leave/approval/page.tsx',
        'app/admin/leave/payroll/page.tsx',
        'app/admin/leave/audit/page.tsx',
        'app/admin/leave/import/page.tsx',
        // The new module — the screens these tabs are being replaced by (a6fe37fc Round 5).
        'app/admin/leave-config/types/page.tsx',
        'app/admin/leave-config/company-rules/page.tsx',
        'app/admin/leave-config/entitlement-tables/page.tsx',
        'app/admin/leave-config/approval-chains/page.tsx',
        'app/admin/leave-config/generate/page.tsx',
        'app/admin/leave-config/adjustments/page.tsx',
        'app/admin/leave-config/import/page.tsx',
        // 7f69bd71 — the Reset records sub-screen, and the two record tab addresses that are redirect
        // stubs now (kept covered: a width cap can never reappear in a stub, so it costs nothing).
        'app/admin/leave-config/records/page.tsx',
        'app/admin/leave-config/records/entitlement/page.tsx',
        'app/admin/leave-config/records/balances/page.tsx',
      ]),
    );
  });

  it.each(files)('%s has no centered max-width cap', (file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const offending = classNameLiterals(source).filter(capsPage);
    expect(offending, `${file} re-introduces a page-level width cap: ${offending.join(' | ')}`).toEqual([]);
  });
});
