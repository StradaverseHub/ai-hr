/**
 * 7b5f18c3 + 1b87e8a0 — THE System Settings list idiom is ONE thing.
 *
 * Both items asked for "the standard UI/UX used throughout the System Settings module". There was no
 * such standard inside System Settings (all five children were single hand-rolled pages), but the shape
 * itself was not missing from the product — /admin/pay-components has shipped it for rounds. So the two
 * items were built in one round and both screens import the same toolbar from components/settings-list
 * .tsx rather than each keeping a private copy.
 *
 * WHY THIS FILE EXISTS. "Both screens follow the same conventions" is prose; prose does not fail a
 * build. If one screen later grows its own search box or copies the table class strings inline, the
 * "standard" quietly becomes two standards and the NEXT request makes it three — which is exactly the
 * drift the pairing was meant to prevent. This is the ratchet.
 *
 * IT IS NOT A DEMAND THAT THE SCREENS LOOK IDENTICAL. Hiring Defaults is per-company and edits on a
 * dedicated route; Movement Settings is a flat catalogue and edits in a modal over the list (1b87e8a0
 * re-build — the reporter rejected the form-under-the-list panel it shipped with, because a form below
 * the list costs you your place in the list). Shared conventions, different screens. Only the LIST half
 * is pinned here; test/movement-settings.test.ts pins that screen's Add/Edit surface.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const IDIOM = 'components/settings-list.tsx';

/** The DIRECTIVE, not the words: these files discuss 'use client' in their comments. Same test as
 *  test/server-client-boundary.test.ts uses to classify a file. */
const declaresUseClient = (src: string) => /^\s*['"]use client['"]\s*;/m.test(src.slice(0, 400));

/** Comments in these files DISCUSS the very shapes asserted against; scan the code, not the prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** Every settings LIST that has adopted the idiom. A new one joins this array. */
const LISTS = ['app/admin/settings/hiring-defaults/page.tsx', 'app/admin/settings/movement/page.tsx'] as const;

describe('the shared System Settings list idiom', () => {
  it('is a server module with no translations of its own', () => {
    const src = read(IDIOM);
    // A 'use client' here would drag both settings screens' toolbars into the client bundle and make
    // every prop a serialisation question (test/server-client-boundary.test.ts, the r123 defect).
    expect(declaresUseClient(src), 'settings-list stays server-side').toBe(false);
    // No t() inside: each page keeps ONE namespace so i18n-coverage Check C can still resolve its keys
    // statically (Check C skips any file that opens two namespaces).
    expect(src).not.toMatch(/useTranslations|getTranslations/);
    // Labels and hrefs arrive pre-computed. A function-TYPED prop (`hrefFor: (v: string) => string`)
    // is the exact shape React refuses across a boundary, and the module must not normalise it as an
    // API — which is why the status filter takes {value, href, label} rows instead of a callback.
    expect(code(src), 'no function-typed props in the API').not.toMatch(/:\s*\([^)]*\)\s*=>/);
  });

  it.each(LISTS)('%s builds its toolbar from the shared module, not a private copy', (file) => {
    const src = read(file);
    expect(src).toContain("from '@/components/settings-list'");
    expect(src, 'the toolbar strip').toContain('<SettingsToolbar>');
    expect(src, 'the search box').toContain('<SettingsSearch');
    expect(src, 'the Active/Inactive/All filter').toContain('<SettingsStatusFilter');
    // The search box is the shared GET form. A second hand-rolled one is how the two screens start
    // parsing ?q= differently.
    expect(src, 'no hand-rolled search form').not.toContain('method="get"');
  });

  it.each(LISTS)('%s uses the house table constants rather than copying the class strings', (file) => {
    const src = read(file);
    for (const cls of ['tableWrapCls', 'theadCls', 'thCls', 'tbodyCls']) {
      expect(src, `${file} uses ${cls}`).toContain(cls);
    }
    // components/ui.tsx says these exist BECAUSE System Labels drifted by hand-copying them. Catching
    // the literal is the only way that comment stays true.
    expect(src, `${file} must not inline the thead classes`).not.toContain(
      'bg-muted/50 text-left text-xs uppercase',
    );
  });

  it.each(LISTS)('%s renders row actions from the shared classes', (file) => {
    expect(read(file)).toMatch(/rowActionCls|rowActionMutedCls/);
    expect(read(file)).toContain('rowActionsCls');
  });

  it.each(LISTS)('%s stays OUT of the pagination contract, deliberately', (file) => {
    const src = read(file);
    // 1b87e8a0's plan omits paging on purpose (a settings catalogue is short; searching beats paging),
    // and the shared contract is lib/pagination + components/Pager — test/pagination.test.ts pins the
    // converted surfaces and a sixth HAND-ROLLED pager is what this guards against, in both directions.
    expect(src, `${file} must not hand-roll a pager`).not.toMatch(/rowsPlusOne|const PAGE_SIZE|Showing \d/);
    expect(src, `${file} does not claim the shared pager either`).not.toContain('<Pager');
  });

  it.each(LISTS)('%s is a server component passing no closures to a client component', (file) => {
    expect(declaresUseClient(read(file)), `${file} is a server component`).toBe(false);
  });
});
