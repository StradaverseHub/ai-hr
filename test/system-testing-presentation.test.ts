/** Read presentation only: these renders do not claim an app journey or a manual guide pass. */
import { Children, cloneElement, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ locale: 'en' }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => state.locale,
  getTranslations: async (namespace: string) => createTranslator({ locale: state.locale, namespace, messages: JSON.parse(readFileSync(new URL(`../messages/${state.locale}.json`, import.meta.url), 'utf8')), onError: error => { throw error; } }),
}));
vi.mock('../app/(app)/admin/system-testing/workspace-actions', () => ({ confirmTestingCatalogueAction: vi.fn() }));
vi.mock('../components/system-testing/action-form', () => ({ TestingActionForm: ({children,label}:{children:ReactNode;label:string}) => createElement('section', null, label, children) }));
vi.mock('../components/system-testing/legacy-mapping-form', () => ({ TestingLegacyMappingForm: () => null }));
import { TestingGuide } from '../components/system-testing/guide';
import { TestingRecordedTime } from '../components/system-testing/recorded-time';
import { TestingCatalogueReview } from '../components/system-testing/catalogue-review';

async function recordedTimes(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(recordedTimes));
  if (!isValidElement<{children?:ReactNode;value?:Date}>(node)) return node;
  if (node.type === TestingRecordedTime && node.props.value instanceof Date) return TestingRecordedTime({ value: node.props.value });
  return cloneElement(node, undefined, ...await Promise.all(Children.toArray(node.props.children).map(recordedTimes)));
}
const sourceRef = 'a'.repeat(40), buildRecordId = '10000000-0000-4000-8000-000000000001', catalogueHash = 'b'.repeat(64), contentHash = 'c'.repeat(64);
const recorded = new Date('2025-06-04T16:07:12Z');
function data(): Parameters<typeof TestingCatalogueReview>[0]['data'] {
  return {
    preview: { format: 1, catalogueHash, libraryHash: 'd'.repeat(64), previewHash: 'e'.repeat(64), entries: [], legacyMappings: [], identity: { status: 'verified_build_identity', identity: { sourceRef, buildRecordId, catalogueHash, contentHash }, activeServiceVerified: false } },
    library: [], coverage: { screens: [], modules: [], manualExecutionVerified: false }, historyTruncated: false,
    history: [{ id: buildRecordId, updateHash: 'f'.repeat(64), previewHash: 'e'.repeat(64), catalogueHash, sourceRef, sourceContentHash: contentHash, createdAt: recorded, confirmedByUserId: buildRecordId, confirmedByName: 'Fictional Reviewer', appliedCount: 2 }],
  };
}
describe('recorded Testing metadata', () => {
  it.each(['en','ms','zh','ta','th','vi'])('includes the actual HR date and time and all bounded build fields in %s', async locale => {
    state.locale = locale;
    const element = await TestingRecordedTime({ value: recorded });
    const parts = new Intl.DateTimeFormat(locale, {timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(recorded);
    expect(parts.find(part=>part.type==='day')?.value).toBe('05');
    expect(parts.find(part=>part.type==='hour')?.value).toBe('00');
    expect(parts.find(part=>part.type==='minute')?.value).toBe('07');
    expect(element.props.dateTime).toBe('2025-06-04T16:07:12.000Z');
    if(locale==='en'){ expect(element.props.children).toContain('Jun 5, 2025'); expect(element.props.children).toContain('12:07:12 AM'); }
    const later = await TestingRecordedTime({ value: new Date(recorded.getTime()+60_000) });
    expect(element.props.children).not.toBe(later.props.children);
    const html = renderToStaticMarkup(await recordedTimes(await TestingCatalogueReview({ data: data() })));
    for (const value of [sourceRef,buildRecordId,catalogueHash,contentHash,'Fictional Reviewer','2025-06-04T16:07:12.000Z']) expect(html).toContain(value);
    const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8')).systemTestingWorkspace;
    for (const key of ['updateLatest','identityNotArrival','activeServiceUnverified','recordedBy']) expect(html.replaceAll('&amp;','&')).toContain(messages[key]);
    expect(html).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
  });
  it('keeps the frozen title/module/function visible in before-after guides without inventing a legacy function', async () => {
    state.locale = 'en';
    const entry = JSON.parse(readFileSync(new URL('../lib/system-testing/catalogue.json', import.meta.url),'utf8')).entries.find((row:{semanticId:string})=>row.semanticId==='personnel.profile.reopen');
    const html = renderToStaticMarkup(await TestingGuide({ definition: entry.definition }));
    for (const value of [entry.definition.title,'employees','personnel.profile']) expect(html).toContain(value);
    const legacy = renderToStaticMarkup(await TestingGuide({ definition: { format:0,history:'upgrade_baseline',title:'Legacy fixture',moduleCode:'employees',precondition:null,steps:[],testType:'functional',priority:'medium',expectedBehavior:null,expectedFunction:null } }));
    expect(legacy).toContain('Legacy fixture'); expect(legacy).toContain('Not specified');
    expect(legacy).toContain('Original instructions for earlier observations are unknown.');
    expect(legacy).not.toContain('personnel.profile');
  });
  it('does not display a verified identity when compiled provenance is unavailable', async () => {
    state.locale = 'en';
    const unavailable = data(); unavailable.preview.identity = { status: 'review_required', reason: 'missing_identity' }; unavailable.history = [];
    const html = renderToStaticMarkup(await recordedTimes(await TestingCatalogueReview({ data: unavailable })));
    expect(html).toContain('Updates cannot be confirmed.');
    expect(html).not.toContain(buildRecordId);
    expect(html).not.toContain(contentHash);
  });
});
