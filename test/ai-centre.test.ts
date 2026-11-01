/** AI centre (docs/design/ai-centre/PLAN.md): one centre over existing, already-guarded routes.
 *
 * What this pins, because each fails quietly:
 *  - PERMISSIONS ARE IDENTICAL. No tab is a new route; every tab is a page that exists, under the guard it
 *    had before, and lib/permissions.ts still lists it. Administrator tabs are hidden from non-administrators,
 *    but the page's own requireAdmin stays the gate.
 *  - THE OLD ADDRESS FORWARDS. The orchestrator page repeated the Control Tower work queue; it now forwards
 *    there after the same guard.
 *  - EVERY WORKER HAS A FAMILY (ADR-0170 §3.13). A new AI feature or built-in check without a placement fails.
 *  - SIX LANGUAGES, SAME KEYS AND PLACEHOLDERS.
 *  - THE APPROVED DIGESTS ARE NOT TOUCHED. The centre's files sit outside both digest scopes. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_GROUPS, CENTRE_TABS, adminGroupOf, centreTabsFor, isCentreView } from '../lib/ai-centre/centre-nav';
import { BUILT_IN_PLACEMENT, BUILT_IN_SHOWN_AS_FEATURE, FEATURE_PLACEMENT, WORKER_FAMILIES, groupByFamily } from '../lib/ai-centre/worker-families';
import { AI_FEATURES } from '../lib/ai/features';
import { AI_MANAGEMENT_SECTIONS } from '../app/control-tower/agents/sections';
import { isAiSourceFile } from '../scripts/ai-agent-source-scope.mjs';
import { aiCentreName } from '../lib/ai-centre/brand';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
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

  it('administrator tabs are AI management pages behind requireAdmin, and only administrators see them', () => {
    const admin = CENTRE_TABS.filter(tab => tab.adminOnly);
    expect(admin.map(tab => tab.key)).toEqual(['workers', 'setup', 'spend']);
    for (const tab of admin) {
      expect(tab.href.startsWith('/control-tower/agents')).toBe(true);
      expect(read(pageOf(tab.href))).toContain('requireAdmin');
    }
    expect(read('app/control-tower/layout.tsx')).toContain('requireAdmin');
    expect(centreTabsFor({ isAdmin: false }).map(tab => tab.key)).toEqual(['ask', 'inbox', 'jobs', 'how']);
    expect(centreTabsFor({ isAdmin: true }).map(tab => tab.key)).toEqual(['ask', 'inbox', 'jobs', 'workers', 'setup', 'spend', 'how']);
  });

  it('the employee views live on /assistant, behind its unchanged session layout', () => {
    for (const view of ['inbox', 'jobs', 'how']) {
      expect(isCentreView(view)).toBe(true);
      expect(CENTRE_TABS.some(tab => tab.href === `/assistant?view=${view}`)).toBe(true);
    }
    expect(isCentreView('workers')).toBe(false);
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
    expect(adminGroupOf('inventory')).toBe('workers');
    expect(adminGroupOf('orchestrator')).toBeNull();
  });

  it('the provider section stays limited to group administrators by the screen, not by the sidebar', () => {
    expect(read('app/control-tower/agents/provider/page.tsx')).toContain('if(!isGroupAdmin(session)) redirect');
    expect(read('app/control-tower/agents/screen.tsx')).toContain('availableAiManagementSections({spend:!!view.spend,provider:isGroupAdmin(s)})');
  });
});

describe('old AI management addresses', () => {
  it('the orchestrator page forwards to the Control Tower work queue after the same guard', () => {
    const page = read('app/control-tower/agents/orchestrator/page.tsx');
    expect(page.indexOf('await requireAdmin()')).toBeGreaterThan(-1);
    expect(page.indexOf('await requireAdmin()')).toBeLessThan(page.indexOf("redirect('/control-tower')"));
  });

  it('every other AI management page still renders its section under requireAdmin', () => {
    for (const section of ['inventory', 'provider', 'assistant', 'features', 'allowances', 'spending', 'runs']) {
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
  const placeholders = (text: string) => {
    let rest = text, previous = '';
    while (rest !== previous) { previous = rest; rest = rest.replace(/(=\d+|zero|one|two|few|many|other)\s*\{[^{}]*\}/g, ''); }
    return [...rest.matchAll(/\{(\w+)/g)].map(match => match[1]).sort().join(',');
  };
  const catalogue = (locale: string) => new Map(flat(JSON.parse(read(`messages/ai-centre/${locale}.json`))));
  const en = catalogue('en');

  it.each(['ms', 'zh', 'vi', 'ta', 'th'])('%s has every key, with the same placeholders, and no blank value', locale => {
    const other = catalogue(locale);
    expect([...other.keys()].sort()).toEqual([...en.keys()].sort());
    for (const [key, text] of en) {
      expect(other.get(key), `${locale} ${key}`).toBeTruthy();
      expect(placeholders(other.get(key)!), `${locale} ${key}`).toBe(placeholders(text));
    }
  });

  it('is merged over the main catalogue for every locale', () => {
    const request = read('i18n/request.ts');
    expect(request).toContain("import aiCentreEn from '../messages/ai-centre/en.json'");
    expect(request).toContain('import(`../messages/ai-centre/${locale}.json`)');
  });

  it('names the product through one constant, never in copy', () => {
    expect(aiCentreName('AI centre')).toBe('AI centre');
    for (const [, text] of en) expect(text).not.toMatch(/\bTeras\b/);
  });
});

describe('approved digests', () => {
  it('none of the AI centre files is inside the module-agent source scope', () => {
    const files = ['lib/ai-centre/centre-nav.ts', 'lib/ai-centre/worker-families.ts', 'lib/ai-centre/brand.ts', 'components/ai-centre/centre-tabs.tsx',
      'components/ai-centre/proposal-card.tsx', 'components/ai-centre/how-it-works.tsx', 'components/ai-centre/review-shell.tsx', 'components/ai-centre/delegated-jobs.tsx',
      'app/assistant/centre/inbox.tsx', 'messages/ai-centre/en.json'];
    for (const file of files) expect(isAiSourceFile(file), file).toBe(false);
  });
});
