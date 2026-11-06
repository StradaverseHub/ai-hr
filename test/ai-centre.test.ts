/** AI centre (docs/design/ai-centre/PLAN.md): one centre over existing, already-guarded routes.
 *
 * What this pins, because each fails quietly:
 *  - PERMISSIONS ARE IDENTICAL. No tab is a new route; every tab is a page that exists, under the guard it
 *    had before, and lib/permissions.ts still lists it. Administrator tabs are hidden from non-administrators,
 *    but the page's own requireAdmin stays the gate.
 *  - THE OLD ADDRESS FORWARDS. The orchestrator page repeated the Control Tower work queue; it now forwards
 *    there after the same guard. The AI Centre restructure (owner decisions 26–29) keeps a guarded forward stub for
 *    every removed page (test/ai-centre-operations-guards.test.ts runs them with the real guards).
 *  - EVERY WORKER HAS A FAMILY (ADR-0170 §3.13). A new AI feature or built-in check without a placement fails.
 *  - SIX LANGUAGES, SAME KEYS AND PLACEHOLDERS.
 *  - THE APPROVED DIGESTS ARE NOT TOUCHED. The centre's files sit outside both digest scopes. */
import { describe, expect, it } from 'vitest';
import {messagesForLocale} from '../i18n/catalogs';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_GROUPS, CENTRE_SECTIONS, CENTRE_TABS, adminGroupOf, centreSectionsFor, centreTabsFor, isCentreView } from '../lib/ai-centre/centre-nav';
import { BUILT_IN_PLACEMENT, BUILT_IN_SHOWN_AS_FEATURE, FEATURE_PLACEMENT, WORKER_FAMILIES, groupByFamily } from '../lib/ai-centre/worker-families';
import { AI_FEATURES } from '../lib/ai/features';
import { AI_MANAGEMENT_SECTIONS } from '../app/control-tower/agents/sections';
import { isAiSourceFile } from '../scripts/ai-agent-source-scope.mjs';
import { AI_ARCHITECTURE_LABEL, AI_PRODUCT_NAME, aiCentreName } from '../lib/ai-centre/brand';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Every product source file (app, components, lib, core, packs), repository-relative. */
const walkSource = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => { for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(rel); }
    else if (/\.(tsx?|mjs)$/.test(entry.name)) out.push(rel);
  } };
  for (const dir of ['app', 'components', 'lib', 'core', 'packs']) if (fs.existsSync(path.join(ROOT, dir))) walk(dir);
  return out;
};
const pageOf = (href: string) => `app${href.split('?')[0]}/page.tsx`.replace('app/page.tsx', 'app/page.tsx');

describe('AI centre tabs keep every permission identical', () => {
  it('every tab is an existing page, listed in the permission registry', () => {
    const permissions = read('lib/permissions.ts');
    for (const tab of CENTRE_TABS) {
      const route = tab.href.split('?')[0];
      expect(fs.existsSync(path.join(ROOT, pageOf(tab.href))), tab.href).toBe(true);
      expect(permissions, route).toContain(`'${route}'`);
    }
  });

  it('administrator tabs are the former Control Tower pages behind requireAdmin, and only administrators see them', () => {
    const admin = CENTRE_TABS.filter(tab => tab.adminOnly);
    // Issue 17 (owner: "Merge both entirely"): Operations and Administration, each a group with a second tab row.
    // AI Centre restructure (owner decision 27): Insights is an administrator tab too (a view of /assistant, guarded inside
    // the view and by its services); Operations opens on Loops.
    expect(admin.map(tab => [tab.key, tab.href, tab.sections])).toEqual([['operations', '/control-tower/loops', true], ['insights', '/assistant?view=insights', false], ['administration', '/control-tower/agents/features', true]]);
    for (const tab of admin.filter(tab => tab.href.startsWith('/control-tower'))) expect(read(pageOf(tab.href))).toContain('requireAdmin');
    expect(read('app/assistant/page.tsx')).toContain("if (sp.view === 'insights' && !admin) redirect('/me/payroll-readiness');");
    expect(read('app/assistant/page.tsx')).toContain("{sp.view === 'insights' && <AiCentreInsights session={s} isAdmin={admin} ");
    expect(read('components/ai-centre/insights.tsx')).toContain('if(!isAdmin)return null;');
    expect(read('core/capacity/ledger.ts')).toContain('requireCapacityAdmin(ctx);');
    // Phase 2 hardening: the layout also admits a read-only auditor, for the Audit loop page only (every other page
    // calls requireAdmin itself; test/ai-centre-operations-guards.test.ts pins both).
    expect(read('app/control-tower/layout.tsx')).toContain('await requireAdminOrAuditReader();');
    // AI v2 Phase 1: the Inbox tab is retired; Today at / replaces it. AI Centre restructure (owner decision 29): the
    // approved order, Ask · Operations ▾ · Insights · Policies · Administration ▾ · How it works; Delegated jobs hidden.
    expect(centreTabsFor({ isAdmin: false }).map(tab => tab.key)).toEqual(['ask', 'policies', 'how']);
    expect(centreTabsFor({ isAdmin: true }).map(tab => tab.key)).toEqual(['ask', 'operations', 'insights', 'policies', 'administration', 'how']);
    // Its own linkable page (app/policies, a signed-in session) inside the AI Centre tab bar, so Ask can link it.
    expect(read('app/policies/page.tsx')).toContain('<AiCentrePolicies session={s} query={query} />');
    expect(read('app/policies/page.tsx')).toContain('<AiCentreTabs active="policies" isAdmin={isAdmin(s)} />');
  });

  it('every second-row tab is an existing /control-tower page behind requireAdmin, listed in the permission registry', () => {
    const permissions = read('lib/permissions.ts');
    const all = Object.values(CENTRE_SECTIONS).flat();
    // AI v2 W8: Loops (app/control-tower/loops, requireAdmin, lib/permissions.ts) sits after the overview; checked below.
    expect(CENTRE_SECTIONS.operations.map(section => section.key)).toEqual(['loops', 'payrollCycle', 'exceptions', 'readiness']);
    expect(CENTRE_SECTIONS.administration.map(section => section.key)).toEqual(['workers', 'setup', 'spend', 'buildList']);
    for (const section of all) {
      expect(section.href.startsWith('/control-tower'), section.href).toBe(true);
      expect(read(pageOf(section.href)), section.href).toContain('requireAdmin()');
      expect(permissions, section.href).toContain(`'${section.href}'`);
    }
    // Each group tab opens its first section, and each page lights its own section tab.
    for (const tab of CENTRE_TABS.filter(tab => tab.sections)) expect(CENTRE_SECTIONS[tab.key as 'operations' | 'administration'][0].href).toBe(tab.href);
    for (const section of CENTRE_SECTIONS.operations) expect(read(pageOf(section.href)), section.href).toContain(`<OperationsTabs session={s} active="${section.key}" />`);
    expect(read('app/control-tower/agents/screen.tsx')).toContain('<AiCentreGroupTabs group="administration" active={group} payroll={false} groupAdmin={isGroupAdmin(s)} />');
    expect(read('app/control-tower/agents/build-list/page.tsx')).toContain('<AiCentreGroupTabs group="administration" active="buildList" payroll={false} groupAdmin />');
    // The Payroll cycle section's four pages each light it, with their in-section row.
    for (const [file, page] of [['app/control-tower/loops/payroll-cycle/page.tsx', 'pre'], ['app/control-tower/loops/payroll-cycle/salary/page.tsx', 'salary'],
      ['app/control-tower/loops/payroll-cycle/settings/page.tsx', 'settings']] as const) {
      expect(read(file), file).toContain('<OperationsTabs session={s} active="payrollCycle" />');
      expect(read(file), file).toContain(`<PayrollCycleSubnav active="${page}" />`);
    }
    expect(read('app/control-tower/loops/loop_payroll_audit/page.tsx')).toContain('{!auditor && <><OperationsTabs session={s} active="payrollCycle" /><PayrollCycleSubnav active="audit" /></>}');
  });

  it('the payroll queues are offered only with payroll, as their former sidebar rows were', () => {
    // Loops and Record readiness are not payroll queues: offered with or without payroll.
    expect(centreSectionsFor('operations', { payroll: false }).map(section => section.key)).toEqual(['loops', 'readiness']);
    expect(centreSectionsFor('operations', { payroll: true }).map(section => section.key)).toEqual(['loops', 'payrollCycle', 'exceptions', 'readiness']);
    // The Build list is offered to a group administrator only, as its page admits only them.
    expect(centreSectionsFor('administration', { payroll: false }).map(section => section.key)).toEqual(['workers', 'setup', 'spend']);
    expect(centreSectionsFor('administration', { payroll: false, groupAdmin: true }).map(section => section.key)).toEqual(['workers', 'setup', 'spend', 'buildList']);
  });

  it('the employee views live on /assistant, behind its unchanged session layout', () => {
    for (const view of ['how', 'insights']) {
      expect(isCentreView(view)).toBe(true);
      expect(CENTRE_TABS.some(tab => tab.href === `/assistant?view=${view}`)).toBe(true);
    }
    // Delegated jobs is hidden until it works: no tab, and its view forwards to Ask before any view renders.
    expect(CENTRE_TABS.some(tab => tab.href.includes('view=jobs'))).toBe(false);
    expect(read('app/assistant/page.tsx')).toContain("if (sp.view === 'jobs') redirect('/assistant');");
    expect(isCentreView('workers')).toBe(false);
    // The retired Inbox view is no tab and no view: its address moves to Today for good (308), before any view renders.
    expect(isCentreView('inbox')).toBe(false);
    expect(CENTRE_TABS.some(tab => tab.href.includes('view=inbox'))).toBe(false);
    const page = read('app/assistant/page.tsx');
    expect(page).toContain("if (sp.view === 'inbox') permanentRedirect(todayInboxRedirect(sp.recommend));");
    expect(page.indexOf("permanentRedirect(todayInboxRedirect")).toBeLessThan(page.indexOf('if (isCentreView(sp.view))'));
    expect(page).not.toMatch(/AiCentreInbox|InboxCountBadge/);
    const layout = read('app/assistant/layout.tsx');
    expect(layout).toContain('getBrowserCommandSession');
    expect(layout).toContain("redirect('/login')");
    // The conversation keeps its own grant check; the centre views do not replace it.
    expect(read('app/assistant/page.tsx')).toContain('if (!access.allowed)');
  });

  it('groups every AI management section under one administrator tab, except the forwarded orchestrator', () => {
    const grouped = Object.values(ADMIN_GROUPS).flat().map(item => item.section);
    expect([...grouped].sort()).toEqual(AI_MANAGEMENT_SECTIONS.filter(section => section !== 'orchestrator').sort());
    expect(adminGroupOf('provider')).toBe('spend');
    // Workers is one list: the inventory is part of it, so it is no section of its own (its page forwards to Workers).
    expect(AI_MANAGEMENT_SECTIONS).not.toContain('inventory');
    expect(ADMIN_GROUPS.workers.map(item => item.section)).toEqual(['features']);
    expect(read('app/control-tower/agents/screen.tsx')).toContain("const inventory = section==='features' ? await aiInventoryView(s, view).catch(() => null) : null;");
    expect(read('app/control-tower/agents/screen.tsx')).toContain("{section==='features'&&(inventorySection ?? <p role=\"status\" data-inventory-unavailable");
    expect(adminGroupOf('orchestrator')).toBeNull();
  });

  it('the provider section stays limited to group administrators by the screen, not by the sidebar', () => {
    expect(read('app/control-tower/agents/provider/page.tsx')).toContain('if(!isGroupAdmin(session)) redirect');
    expect(read('app/control-tower/agents/screen.tsx')).toContain('availableAiManagementSections({spend:!!view.spend,provider:isGroupAdmin(s)})');
  });
});

describe('old AI management addresses', () => {
  it('the orchestrator page forwards to Record readiness, where its work queue now is, after the same guard', () => {
    const page = read('app/control-tower/agents/orchestrator/page.tsx');
    expect(page.indexOf('await requireAdmin()')).toBeGreaterThan(-1);
    expect(page.indexOf('await requireAdmin()')).toBeLessThan(page.indexOf("redirect('/control-tower/readiness')"));
  });

  it('every other AI management page still renders its section under requireAdmin', () => {
    for (const section of ['provider', 'assistant', 'features', 'allowances', 'spending', 'runs']) {
      const page = read(`app/control-tower/agents/${section}/page.tsx`);
      expect(page, section).toContain('requireAdmin');
      expect(page, section).toContain(`section:'${section}'`);
    }
  });
});

describe('every worker belongs to one family (ADR-0170 §3.13)', () => {
  it('places every AI feature', () => {
    for (const feature of AI_FEATURES) expect(FEATURE_PLACEMENT[feature.id], feature.id).toBeDefined();
    expect(Object.keys(FEATURE_PLACEMENT).sort()).toEqual(AI_FEATURES.map(feature => feature.id).sort());
    for (const placement of Object.values(FEATURE_PLACEMENT)) expect(WORKER_FAMILIES).toContain(placement.family);
  });

  it('places every built-in check the Control Tower reads', () => {
    const ids = [...read('core/control-domains.ts').matchAll(/\n\s+id: '([A-Za-z]+)',\n\s+kind: '(?:deterministic|llm)'/g)].map(match => match[1]);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(id in BUILT_IN_PLACEMENT || BUILT_IN_SHOWN_AS_FEATURE.includes(id), id).toBe(true);
  });

  it('the template-only chasers are shown as reminders that use no model, and no decider is switchable', () => {
    for (const id of ['approval_chasers', 'review_chasers', 'clock_reminders', 'document_reminders', 'lifecycle_chasers'] as const)
      expect(FEATURE_PLACEMENT[id]).toEqual({ family: 'chaser', trigger: 'scheduled', effect: 'remindTemplate' });
    expect(Object.values(FEATURE_PLACEMENT).some(placement => placement.family === 'decider')).toBe(false);
    expect(BUILT_IN_PLACEMENT.autonomy.family).toBe('decider');
  });

  it('groups rows without dropping any', () => {
    const grouped = groupByFamily(AI_FEATURES, feature => FEATURE_PLACEMENT[feature.id].family);
    expect(Object.values(grouped).flat()).toHaveLength(AI_FEATURES.length);
  });
});

describe('AI centre messages', () => {
  type Dict = { [key: string]: string | Dict };
  const flat = (value: Dict, prefix = ''): [string, string][] =>
    Object.entries(value).flatMap(([key, child]) => typeof child === 'string' ? [[prefix + key, child] as [string, string]] : flat(child, `${prefix}${key}.`));
  // Plural arms ({Today}, {# days}) are translated text, not placeholders: drop them before collecting names.
  // An argument opens at even brace depth; at odd depth a brace opens a plural or select branch, whose text is not a
  // placeholder (so AI v2 P2-2a's `{status, select, draft {…} …}` reads as `status`, as a plural always did).
  const placeholders = (text: string) => {
    const names: string[] = [];
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') { if (depth % 2 === 0) { const match = /^\s*(\w+)/.exec(text.slice(i + 1)); if (match) names.push(match[1]); } depth++; }
      else if (text[i] === '}') depth--;
    }
    return names.sort().join(',');
  };
  const catalogue = (locale: string) => new Map(flat(JSON.parse(read(`messages/ai-centre/${locale}.json`))));
  /** The login story's keys that may name Noveri (owner, 3 November 2026: "Keep Noveri on login"); no other login key may. */
  const LOGIN_NOVERI_KEYS = ['storyLabel', 'storyDescription', 'clockAlt'] as const;
  const en = catalogue('en');

  it.each(['ms', 'zh', 'vi', 'ta', 'th'])('%s has every key, with the same placeholders, and no blank value', locale => {
    const other = catalogue(locale);
    expect([...other.keys()].sort()).toEqual([...en.keys()].sort());
    for (const [key, text] of en) {
      expect(other.get(key), `${locale} ${key}`).toBeTruthy();
      expect(placeholders(other.get(key)!), `${locale} ${key}`).toBe(placeholders(text));
    }
  });

  it.each(['en','ms','zh','vi','ta','th'] as const)('%s merges AI Centre copy into the request catalogue', async locale => {
    const messages=await messagesForLocale(locale);
    for(const [key,value] of catalogue(locale)){
      const actual=key.split('.').reduce<unknown>((node,part)=>node&&typeof node==='object'?(node as Record<string,unknown>)[part]:undefined,messages);
      expect(actual,key).toBe(value);
    }
  });

  it('names the architecture through one constant, never in copy, and shows it only on How it works', () => {
    expect(AI_PRODUCT_NAME).toBe('Noveri');
    // Owner, 3 November 2026: the product surface is "AI Centre"; "Noveri" only on How it works.
    expect(aiCentreName('AI Centre')).toBe('AI Centre');
    // Owner, 3 November 2026 ("Keep Noveri on login"): the login page's story (app/login/noveri-story.tsx, with its copy
    // in messages/login-editorial/<locale>.json, keys LOGIN_NOVERI_KEYS below) may name Noveri too. Exactly these files.
    for (const file of walkSource()) if (!['lib/ai-centre/brand.ts', 'components/ai-centre/how-it-works.tsx', 'app/assistant/page.tsx', 'app/login/noveri-story.tsx'].includes(file))
      expect(read(file), file).not.toMatch(/\bAI_PRODUCT_NAME\b|\bAI_ARCHITECTURE_LABEL\b/);
    // On the login story the name is only the clockwork's watch face.
    expect(read('app/login/noveri-story.tsx').split('\n').filter(line => /AI_PRODUCT_NAME|AI_ARCHITECTURE_LABEL/.test(line) && !/^import /.test(line)))
      .toEqual([expect.stringMatching(/faceLabel=\{AI_ARCHITECTURE_LABEL \?\? undefined\}/)]);
    for (const locale of ['en', 'ms', 'zh', 'vi', 'ta', 'th']) {
      const named = flat(JSON.parse(read(`messages/login-editorial/${locale}.json`))).filter(([, text]) => /\b(Teras|Noveri)\b/.test(text)).map(([key]) => key);
      expect(named, `login-editorial ${locale}`).toEqual([...LOGIN_NOVERI_KEYS]);
    }
    // On the Ask page the name is used only by the How it works view.
    const assistantPage = read('app/assistant/page.tsx');
    expect(assistantPage).toContain("const tc = sp.view === 'how' ? await getTranslations('aiCentre.how') : null;");
    const nameLines = assistantPage.split('\n').filter(line => /AI_PRODUCT_NAME|AI_ARCHITECTURE_LABEL/.test(line) && !/^import /.test(line));
    expect(nameLines).toHaveLength(1);
    expect(nameLines[0]).toMatch(/\{tc && .*AI_ARCHITECTURE_LABEL/);
    expect(AI_ARCHITECTURE_LABEL).toBe(`${AI_PRODUCT_NAME} OS`);
    expect(read('lib/ai-centre/brand.ts')).not.toMatch(/'Noveri OS'/);
    for (const locale of ['en', 'ms', 'zh', 'vi', 'ta', 'th'])
      // Both catalogues, all six locales: no copy names Teras or Noveri; How it works injects the name through {name}.
      for (const [key, text] of [...catalogue(locale), ...flat(JSON.parse(read(`messages/${locale}.json`)))]) expect(text, `${locale} ${key}`).not.toMatch(/\b(Teras|Noveri)\b/);
    for (const file of ['components/ai-centre/how-it-works.tsx', 'components/ai-centre/clockwork-figure.tsx', 'components/ai-centre/centre-tabs.tsx', 'components/assistant/assistant-launcher.tsx', 'components/sidebar.tsx', 'app/assistant/page.tsx'])
      expect(read(file), file).not.toMatch(/['"`]Noveri/);
  });

  /** Issue 17 (owner: "Merge both entirely"): "Control Tower" disappears from user copy in all six locales. Each
   * locale's own rendering of the name is refused too, as it shipped before this change (Malay "Menara Kawalan",
   * Chinese 控制塔 and 控制中心, Vietnamese "Tháp điều khiển" and "Trung tâm điều hành", Tamil கட்டுப்பாட்டு
   * கோபுரம் and மையம், Thai หอควบคุม and ศูนย์ควบคุม). Internal code names, message keys, routes and comments stay. */
  const CONTROL_TOWER: Readonly<Record<string, RegExp>> = {
    en: /\bcontrol[\s-]+tower\b|\btower\b/i,
    ms: /\bcontrol[\s-]+tower\b|menara/i,
    zh: /\bcontrol[\s-]+tower\b|控制塔|控制中心/i,
    vi: /\bcontrol[\s-]+tower\b|tháp điều khiển|trung tâm điều hành/i,
    ta: /\bcontrol[\s-]+tower\b|கட்டுப்பாட்டு\s*(?:க்\s*)?(?:கோபுர|மைய)|கட்டுப்பாட்டுக்\s*கோபுர|கோபுர/i,
    th: /\bcontrol[\s-]+tower\b|หอควบคุม|ศูนย์ควบคุม/i,
  };
  it('refuses "Control Tower" in user copy, in all six locales and both catalogues', () => {
    for (const locale of ['en', 'ms', 'zh', 'vi', 'ta', 'th']) {
      const copy = [...catalogue(locale), ...flat(JSON.parse(read(`messages/${locale}.json`)))];
      expect(copy.length, locale).toBeGreaterThan(1000);
      for (const [key, text] of copy) expect(text, `${locale} ${key}`).not.toMatch(CONTROL_TOWER[locale]);
    }
    // The same guard catches the shipped wording: it is not vacuous.
    expect('Back to the Control Tower').toMatch(CONTROL_TOWER.en);
    expect('Kembali ke Menara Kawalan').toMatch(CONTROL_TOWER.ms);
    expect('返回控制塔').toMatch(CONTROL_TOWER.zh);
    expect('Quay lại Tháp điều khiển').toMatch(CONTROL_TOWER.vi);
    expect('கட்டுப்பாட்டு கோபுரத்திற்குத் திரும்பு').toMatch(CONTROL_TOWER.ta);
    expect('กลับไปที่ศูนย์ควบคุม').toMatch(CONTROL_TOWER.th);
  });

  it('refuses "Control Tower" in the bundled guides, their titles and the product tours (English source)', () => {
    const guides = fs.readdirSync(path.join(ROOT, 'content/guides')).filter(name => name.endsWith('.md'));
    expect(guides.length).toBeGreaterThan(40);
    // Link targets keep the internal /control-tower path; only the words people read are checked.
    const words = (text: string) => text.replace(/\]\([^)]*\)/g, ']').replace(/"(?:route|target)": "(?:[^"\\]|\\.)*"/g, '');
    for (const name of guides) expect(words(read(`content/guides/${name}`)), name).not.toMatch(CONTROL_TOWER.en);
    const manifest = JSON.parse(read('content/guides/manifest.json')).guides as { slug: string; title: string }[];
    expect(manifest.length).toBeGreaterThan(40);
    for (const guide of manifest) expect(guide.title, guide.slug).not.toMatch(CONTROL_TOWER.en);
    expect(words(read('lib/module-tours.json'))).not.toMatch(CONTROL_TOWER.en);
  });

  it('refuses "Control Tower" in string literals of the product source; code names and paths stay', () => {
    const literal = /(['"`])(?:(?!\1)[^\\\n]|\\.)*\bControl\s+Tower\b(?:(?!\1)[^\\\n]|\\.)*\1|>[^<{}\n]*\bControl\s+Tower\b[^<{}\n]*</;
    const files = walkSource();
    expect(files.length).toBeGreaterThan(500);
    for (const file of files) {
      // Comments may keep the history; strip them before looking at what renders.
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
      expect(code, file).not.toMatch(literal);
    }
    expect(`const label = 'Back to the Control Tower';`).toMatch(literal);
  });
});

describe('approved digests', () => {
  it('none of the AI centre files is inside the module-agent source scope', () => {
    const files = ['lib/ai-centre/centre-nav.ts', 'lib/ai-centre/worker-families.ts', 'lib/ai-centre/brand.ts', 'components/ai-centre/centre-tabs.tsx',
      'components/ai-centre/proposal-card.tsx', 'components/ai-centre/how-it-works.tsx', 'components/ai-centre/review-shell.tsx', 'components/ai-centre/delegated-jobs.tsx',
      'components/today/sections.tsx', 'messages/ai-centre/en.json'];
    for (const file of files) expect(isAiSourceFile(file), file).toBe(false);
  });
});
