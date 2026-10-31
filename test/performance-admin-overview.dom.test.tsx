/**
 * D-P1-32 PT-X4 — the ONE module Overview (app/(app)/performance/onehr/module-overview.tsx), keyed by module: the count
 * at each of the module's stages from the existing Review progress reader, and, once the module's window has
 * closed, who is not done (for 360 Feedback, the raters, from the raters' reader). A module the cycle does not run
 * shows that, and the reader's fallback to another module is never counted as this one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '../messages/en.json';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';

const ports = vi.hoisted(() => ({ progress: vi.fn(), raters: vi.fn(), session: vi.fn() }));
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: en, namespace: namespace as never }), getLocale: async () => 'en' }));
vi.mock('../lib/scope', () => ({ scopedSession: ports.session }));
vi.mock('../packs/performance/service', () => ({ getAssessmentProgress: ports.progress, getAssessmentAssessorProgress: ports.raters }));
import { LATE_SHOWN, ModuleOverview } from '../app/(app)/performance/onehr/module-overview';

const CYCLE = '11111111-2222-4333-8444-555555555555';
const o = en.performanceAdmin.overview, labels = en.onehr.progressAdmin.labels;
const day = 86_400_000;
const at = (offset: number) => new Date(Date.now() + offset).toISOString();
const base = defaultPolicy(framework);
const policy = (windows: Record<string, { opensAt: string | null; closesAt: string | null }> = {}, modules: Partial<typeof base.modules> = {}) => ({ ...base, windows, modules: { ...base.modules, calibration: true, ...modules } });
const row = (name: string, module: string, state: 'pending' | 'active' | 'done', label: string) => ({ reviewId: `review-${name}`, name, code: null, company: 'Unit A', companyId: 'company-1', group: 'Group A', department: 'Sales', grade: '10', cells: { [module]: { state, label, count: 1, completed: state === 'done' ? 1 : 0 } } });
const progress = (rows: unknown[], availableModules = ['pm', 'competency', 'feedback', 'calibration', 'career']) => ({ availableModules, cycle: { id: CYCLE, name: '2026 Year-End', status: 'open' }, filter: { module: availableModules[0] }, counts: {}, rows });
const show = async (props: Parameters<typeof ModuleOverview>[0]) => render(<NextIntlClientProvider locale="en" messages={en}>{await ModuleOverview(props)}</NextIntlClientProvider>);
const tile = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
const lateCard = () => screen.getByRole('heading', { name: o.late }).closest('div')!.parentElement!;

beforeEach(() => {
  vi.clearAllMocks();
  ports.session.mockResolvedValue({ s: { tenantId: 'tenant' }, scopeIds: [] });
  ports.raters.mockResolvedValue([]);
});

describe('the module Overview', () => {
  it('counts Performance by stage, every stage drawn, and names who is late once the window has closed', async () => {
    ports.progress.mockResolvedValue(progress([row('Zed', 'pm', 'pending', 'not_set'), row('Amy', 'pm', 'active', 'awaiting_approval'), row('Bob', 'pm', 'done', 'approved'), row('Cat', 'pm', 'pending', 'not_set')]));
    await show({ cycleId: CYCLE, section: 'performance', module: 'pm', policy: policy({ pm_results: { opensAt: at(-10 * day), closesAt: at(-day) } }), cycleName: '2026 Year-End' });
    expect(ports.progress).toHaveBeenCalledWith(expect.anything(), CYCLE, { module: 'pm' });
    expect(ports.raters).not.toHaveBeenCalled();
    expect([tile(labels.not_set), tile(labels.not_submitted), tile(labels.awaiting_approval), tile(labels.approved)]).toEqual(['2', '0', '1', '1']);
    const late = within(lateCard()).getAllByRole('listitem');
    expect(late.map((li) => li.querySelector('a')?.textContent)).toEqual(['Amy', 'Cat', 'Zed']);
    expect(within(late[0]).getByRole('link')).toHaveAttribute('href', '/performance/review/review-Amy');
    expect(late[0]).toHaveTextContent(labels.awaiting_approval);
    expect(screen.queryByText('Bob')).toBeNull();
    expect(screen.getByText(/4 people · Closed/)).toBeInTheDocument();
  });

  it('names nobody while the window is open', async () => {
    ports.progress.mockResolvedValue(progress([row('Zed', 'competency', 'pending', 'not_submitted')]));
    await show({ cycleId: CYCLE, section: 'competency', module: 'competency', policy: policy({ tc_self: { opensAt: at(-day), closesAt: at(day) } }), cycleName: '2026 Year-End' });
    expect(tile(labels.not_submitted)).toBe('1');
    expect(screen.getByText(o.notYet)).toBeInTheDocument();
    expect(within(lateCard()).queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByText(/1 person · Closes/)).toBeInTheDocument();
  });

  it('for 360 Feedback, counts the people by stage and names the raters still owing feedback', async () => {
    ports.progress.mockResolvedValue(progress([row('Subject', 'feedback', 'active', 'feedback_pending')]));
    ports.raters.mockResolvedValue([
      { employmentId: 'rater-1', name: 'Rae', code: null, email: null, company: 'Unit A', group: '', department: 'Ops', lastLogin: null, assigned: 3, done: 1, remaining: 2, state: 'active' },
      { employmentId: 'rater-2', name: 'Done Dee', code: null, email: null, company: 'Unit A', group: '', department: 'Ops', lastLogin: null, assigned: 2, done: 2, remaining: 0, state: 'done' },
    ]);
    await show({ cycleId: CYCLE, section: 'feedback', module: 'f360', policy: policy({ f360: { opensAt: at(-10 * day), closesAt: at(-day) } }), cycleName: '2026 Year-End' });
    expect(ports.progress).toHaveBeenCalledWith(expect.anything(), CYCLE, { module: 'feedback' });
    expect(tile(labels.feedback_pending)).toBe('1');
    const late = within(lateCard()).getAllByRole('listitem');
    expect(late).toHaveLength(1);
    expect(late[0]).toHaveTextContent('Rae');
    expect(late[0]).toHaveTextContent('1 of 3 submitted');
    expect(late[0].querySelector('a')).toBeNull();
  });

  it('says a module is off, and never counts the reader\'s fallback module as this one', async () => {
    ports.progress.mockResolvedValue(progress([row('Pm person', 'pm', 'pending', 'not_set')], ['pm']));
    await show({ cycleId: CYCLE, section: 'career', module: 'idp', policy: policy({ idp_self: { opensAt: at(-10 * day), closesAt: at(-day) } }), cycleName: '2026 Year-End' });
    expect(screen.getByText('This module is off for 2026 Year-End.')).toBeInTheDocument();
    expect(document.querySelector('dl')).toBeNull();
    expect(screen.queryByText('Pm person')).toBeNull();
    expect(screen.getByText(/0 people/)).toBeInTheDocument();
  });

  it('names the first ones and sends the rest to the module\'s Run page', async () => {
    const rows = Array.from({ length: LATE_SHOWN + 3 }, (_, i) => row(`Person ${String(i).padStart(2, '0')}`, 'career', 'pending', 'not_shared'));
    ports.progress.mockResolvedValue(progress(rows));
    await show({ cycleId: CYCLE, section: 'career', module: 'idp', policy: policy({ idp_self: { opensAt: at(-10 * day), closesAt: at(-day) } }), cycleName: '2026 Year-End' });
    expect(within(lateCard()).getAllByRole('listitem')).toHaveLength(LATE_SHOWN);
    expect(screen.getByRole('link', { name: '3 more in Run' })).toHaveAttribute('href', `/performance/${CYCLE}/career/run`);
  });
});
