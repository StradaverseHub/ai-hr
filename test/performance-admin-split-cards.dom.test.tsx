/**
 * D-P1-32 PT-X4 — the two cards the admin area splits across pages, rendered for real: the competency architecture
 * card draws only the sections its page asks for (the cycle page still draws all four), and its forms carry the
 * page's return path; Review progress in `fixed` mode offers no module or people/raters switch, and a module the
 * cycle does not run shows the empty state instead of the reader's fallback module.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import en from '../messages/en.json';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';

const ports = vi.hoisted(() => ({ progress: vi.fn(), raters: vi.fn(), session: vi.fn() }));
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: en, namespace: namespace as never }) }));
vi.mock('next/navigation', async (importActual) => ({ ...await importActual<typeof import('next/navigation')>(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('../lib/scope', () => ({ scopedSession: ports.session }));
vi.mock('../packs/performance/service', () => ({ getAssessmentProgress: ports.progress, getAssessmentAssessorProgress: ports.raters }));
vi.mock('../app/(app)/performance/onehr-actions', () => ({ onehrCycleAction: vi.fn(), assessmentArchitectureAction: vi.fn(), assessmentGenerateProfilesAction: vi.fn() }));
import { CatalogueAdmin } from '../app/(app)/performance/onehr/catalogue-admin';
import { AssessmentProgressAdmin } from '../app/(app)/performance/onehr/progress-admin';
import { ProgressTable } from '../app/(app)/performance/onehr/progress-table';

const c = en.onehr.catalogueAdmin, p = en.onehr.progressAdmin;
const CYCLE = '11111111-2222-4333-8444-555555555555';
const show = (node: ReactNode) => render(<NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>);
const summaries = () => [...document.querySelectorAll('details > summary')].map((s) => s.textContent);
const row = { reviewId: 'review-1', name: 'Ann Lee', code: 'E1', company: 'Unit A', companyId: 'company-1', group: 'Group A', department: 'Sales', grade: '10', cells: { competency: { state: 'pending', label: 'not_submitted', count: 2, completed: 0 }, pm: { state: 'done', label: 'approved', count: 1, completed: 1 } } };
const assessment = (module: string, availableModules: string[]) => ({ availableModules, cycle: { id: CYCLE, name: '2026 Year-End', status: 'open' }, filter: { module, state: 'all' }, counts: {}, rows: [row] });

beforeEach(() => {
  vi.clearAllMocks();
  ports.session.mockResolvedValue({ s: { tenantId: 'tenant' }, scopeIds: [] });
  ports.raters.mockResolvedValue([]);
});

describe('the competency architecture card, split by section', () => {
  const props = { cycleId: CYCLE, revision: 4, policy: defaultPolicy(framework), companies: [{ id: 'company-1', name: 'Unit A' }] };

  it('draws all four sections on the cycle page, with no return path', () => {
    show(<CatalogueAdmin {...props} />);
    expect(summaries()).toEqual([c.import, c.profiles, c.routes, c.generate]);
    expect(document.querySelectorAll('input[name="returnTo"]')).toHaveLength(0);
  });

  it('draws only the asked-for sections, and its forms come back to the admin page', () => {
    show(<CatalogueAdmin {...props} sections={['routes']} returnTo={`/performance/${CYCLE}/career/settings`} />);
    expect(summaries()).toEqual([c.routes]);
    const back = document.querySelector<HTMLInputElement>('form input[name="returnTo"]');
    expect(back?.value).toBe(`/performance/${CYCLE}/career/settings`);
    expect(back?.closest('form')?.querySelector('input[name="action"]')?.getAttribute('value')).toBe('career-route');
  });

  it('keeps import and generation apart from the profiles', () => {
    show(<CatalogueAdmin {...props} sections={['generate']} />);
    expect(summaries()).toEqual([c.generate]);
  });
});

describe('Review progress fixed to one module', () => {
  it('offers no module or people/raters switch, and shows that module\'s rows', () => {
    show(<ProgressTable fixed assessment={assessment('competency', ['pm', 'competency']) as never} assessors={[]} initial={{ kind: 'assessments', group: '', company: '' }} />);
    expect(screen.queryByLabelText(p.module)).toBeNull();
    expect(screen.queryByRole('button', { name: p.assessors })).toBeNull();
    expect(screen.getByText('Ann Lee')).toBeInTheDocument();
    expect(screen.getByText(p.labels.not_submitted)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: p.export })).toHaveAttribute('href', expect.stringContaining('module=competency'));
  });

  it('still offers both switches on the cycle page', () => {
    show(<ProgressTable assessment={assessment('competency', ['pm', 'competency']) as never} assessors={[]} initial={{ kind: 'assessments', group: '', company: '' }} />);
    expect(screen.getByLabelText(p.module)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: p.assessors })).toBeInTheDocument();
  });

  it('shows the empty state for a module the cycle does not run, never the reader\'s fallback module', async () => {
    ports.progress.mockResolvedValue(assessment('pm', ['pm']));
    show(await AssessmentProgressAdmin({ cycleId: CYCLE, initial: { progressModule: 'career', progressKind: 'assessments' }, fixed: true }));
    expect(ports.progress).toHaveBeenCalledWith(expect.anything(), CYCLE, { module: 'career' });
    expect(screen.getByText(p.empty)).toBeInTheDocument();
    expect(screen.queryByText('Ann Lee')).toBeNull();
  });

  it('draws the raters for 360\'s Rater progress', async () => {
    ports.progress.mockResolvedValue(assessment('feedback', ['feedback']));
    ports.raters.mockResolvedValue([{ employmentId: 'rater-1', name: 'Rae', code: null, email: null, company: 'Unit A', group: 'Group A', department: 'Ops', lastLogin: null, assigned: 2, done: 1, remaining: 1, state: 'active' }]);
    show(await AssessmentProgressAdmin({ cycleId: CYCLE, initial: { progressModule: 'feedback', progressKind: 'assessors' }, fixed: true }));
    expect(screen.getByText('Rae')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: p.assessments })).toBeNull();
  });
});
