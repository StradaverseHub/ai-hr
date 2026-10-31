/** WP14 AI management › Provider: the baseline-checks panel renders every status, per-suite results, acceptance and
 * activation controls, and the platform-default warning, in all six locales. Data owner and actions are stubbed. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viMessages from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';

const catalogues = { en, ms, zh, vi: viMessages, th, ta };
type Locale = keyof typeof catalogues;
const state = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ms' | 'zh' | 'vi' | 'th' | 'ta', view: undefined as unknown }));
vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: state.locale, messages: catalogues[state.locale], namespace }),
  getFormatter: async () => createFormatter({ locale: state.locale, timeZone: 'Asia/Kuala_Lumpur' }),
}));
vi.mock('../core/ai-provider-baseline', () => ({ getAiProviderChangeView: async () => state.view }));
vi.mock('../app/admin/ai/actions', () => ({ acceptProviderBaselineAction: vi.fn(), runProviderBaselineAction: vi.fn(), setActiveProviderAction: vi.fn() }));
import { AiProviderBaselinePanel } from '../app/admin/ai/provider-baseline-panel';

afterEach(cleanup);
const ID = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;
const suites = (read: [number, number, number], human: [number, number, number]) => [
  { id: 'read_plan', total: 144, passed: read[0], failed: read[1], next: read[0] + read[1], state: read[1] ? 'failed' : read[0] + read[1] === 144 ? 'passed' : 'evaluating' },
  { id: 'human_plan', total: 12, passed: human[0], failed: human[1], next: human[0] + human[1], state: human[1] ? 'failed' : human[0] + human[1] === 12 ? 'passed' : 'evaluating' },
];
const run = (n: number, s: string, read: [number, number, number], human: [number, number, number], extra = {}) =>
  ({ id: ID(n), state: s, suites: suites(read, human), acceptedReason: null, acceptedAt: null, updatedAt: '2026-10-29T02:00:00.000Z', ownRun: true, ...extra });
const target = (n: number, provider: string, label: string, model: string, status: string, r: unknown, kind = 'pending') =>
  ({ key: `${kind}:${ID(n)}`, kind, provider, label, model, targetId: kind === 'environment' ? null : ID(n), targetVersion: kind === 'environment' ? null : ID(n + 1), keyLast4: null, status, run: r, activatable: status === 'passed' || status === 'accepted' });
const view = {
  platform: { provider: 'anthropic', label: 'Anthropic (Claude)', model: 'fictional-platform-model', fingerprint: 'a'.repeat(64), evaluated: false },
  targets: [
    target(1, 'anthropic', 'Anthropic (Claude)', 'fictional-pending-model', 'pending', null),
    target(2, 'openai', 'OpenAI', 'fictional-evaluating-model', 'evaluating', run(2, 'evaluating', [24, 0, 0], [0, 0, 0])),
    target(3, 'google', 'Google (Gemini)', 'fictional-passed-model', 'passed', run(3, 'passed', [144, 0, 0], [12, 0, 0])),
    target(4, 'ai_gateway', 'AI gateway', 'fictional-failed-model', 'failed', run(4, 'failed', [10, 1, 0], [0, 0, 0])),
    target(5, 'openrouter', 'OpenRouter', 'fictional/accepted', 'accepted', run(5, 'accepted', [10, 1, 0], [0, 0, 0], { acceptedReason: 'Fictional reviewed reason for acceptance.', acceptedAt: '2026-10-29T03:00:00.000Z' }), 'openrouter_candidate'),
    target(6, 'anthropic', 'Anthropic (Claude)', 'fictional-platform-model', 'pending', null, 'environment'),
  ],
};

describe('provider change baseline panel', () => {
  it.each(Object.keys(catalogues) as Locale[])('renders every status, suite result and control in %s', async locale => {
    state.locale = locale; state.view = view;
    const t = catalogues[locale].admin.ai.baseline;
    const { container } = render(await AiProviderBaselinePanel({ session: { tenantId: 'fictional', userId: 'fictional' } as never }));
    expect(screen.getByText(t.title)).toBeTruthy(); expect(screen.getByText(t.intro)).toBeTruthy();
    for (const status of ['pending', 'evaluating', 'passed', 'failed', 'accepted'] as const) expect(screen.getAllByText(t.status[status]).length, status).toBeGreaterThan(0);
    for (const suite of ['read_plan', 'human_plan'] as const) expect(screen.getAllByText(t.suites[suite]).length).toBeGreaterThan(0);
    expect(container.textContent).toContain('fictional-platform-model');
    expect(screen.getByRole('status').textContent).toContain('fictional-platform-model');
    expect(container.textContent).toContain('Fictional reviewed reason for acceptance.');
    // Activation only for the passed and accepted pending/direct change; acceptance only for failed or unfinished runs.
    expect(screen.getAllByRole('button', { name: t.activate })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: t.acceptButton })).toHaveLength(2);
    const passed = container.querySelector(`#ai-baseline-pending-${ID(3)}`) as HTMLElement;
    expect(within(passed).queryByRole('button', { name: t.run })).toBeNull();
    expect((passed.querySelector('input[name="pendingVersion"]') as HTMLInputElement).value).toBe(ID(4));
    // The run form posts only closed target fields and an explicit consent; the browser never posts a verdict.
    const pending = container.querySelector(`#ai-baseline-pending-${ID(1)}`) as HTMLElement;
    expect([...pending.querySelectorAll('form input')].map(input => (input as HTMLInputElement).name).sort()).toEqual(['consent', 'kind', 'provider', 'targetId', 'targetVersion']);
    expect(within(pending).getByRole('checkbox', { name: t.consent })).toBeTruthy();
    expect(within(container.querySelector(`#ai-baseline-pending-${ID(2)}`) as HTMLElement).getByRole('button', { name: t.continue })).toBeTruthy();
    expect(container.textContent).toContain(t.openRouterActivate);
    expect(container.textContent).not.toMatch(/admin\.ai\.baseline/);
  });
  it.each(Object.keys(catalogues) as Locale[])('flags an active configuration without an admitting baseline in %s, and only then', async locale => {
    state.locale = locale;
    const t = catalogues[locale].admin.ai.baseline;
    state.view = { platform: null, targets: [], active: { provider: 'openai', label: 'OpenAI', model: 'fictional-legacy-model', evaluated: false } };
    const first = render(await AiProviderBaselinePanel({ session: {} as never }));
    const notice = screen.getByRole('status');
    expect(t.activeNotEvaluated).toContain('{model}');
    expect(notice.textContent).toBe(t.activeNotEvaluated.replace('{provider}', 'OpenAI').replace('{model}', 'fictional-legacy-model'));
    first.unmount();
    state.view = { platform: null, targets: [], active: { provider: 'openai', label: 'OpenAI', model: 'fictional-legacy-model', evaluated: true } };
    render(await AiProviderBaselinePanel({ session: {} as never }));
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('states when the platform default has a passed or accepted baseline and when nothing is waiting', async () => {
    state.locale = 'en'; state.view = { platform: { ...view.platform, evaluated: true }, targets: [] };
    render(await AiProviderBaselinePanel({ session: {} as never }));
    expect(screen.getByRole('status').textContent).toBe(en.admin.ai.baseline.platformEvaluated.replace('{provider}', 'Anthropic (Claude)').replace('{model}', 'fictional-platform-model'));
    expect(screen.getByText(en.admin.ai.baseline.none)).toBeTruthy();
  });
});
