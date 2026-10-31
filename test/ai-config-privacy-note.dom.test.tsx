/** The /admin/ai privacy note covers every AI feature, not only performance-review drafting (owner,
 * 28 October 2026). It must not promise name redaction: the masking helper (`redactPII`, lib/ai/index.ts)
 * hides only emails, IC numbers and phone numbers, and several features send names or images.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viMessages from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';

const catalogues = { en, ms, zh, vi: viMessages, th, ta };
const state = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ms' | 'zh' | 'vi' | 'th' | 'ta' }));
vi.mock('server-only', () => ({}));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: state.locale, messages: catalogues[state.locale], namespace }),
  getLocale: async () => state.locale,
}));
vi.mock('../lib/authz', () => ({ requireAdmin: async () => ({ tenantId: 'fixture-tenant', userId: 'fixture-user', personId: null, roles: ['hr_admin'], grants: [] }) }));
vi.mock('../core/ai-config', () => ({ getAiConfigView: async () => ({ storable: true, envFallback: null, usingEnvFallback: false, providers: [] }) }));
vi.mock('../core/entitlements', () => ({ isModuleEnabledOrFalse: () => false }));
vi.mock('../components/ai-config-form', () => ({ AiConfigForm: () => null }));
import { AiProviderScreen as AiConfigPage } from '../app/(app)/admin/ai/provider-screen';

describe('/admin/ai privacy note', () => {
  it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders the all-features note in %s', async locale => {
    state.locale = locale;
    render(await AiConfigPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(catalogues[locale].admin.ai.privacyNote)).toBeTruthy();
    expect(screen.getByText(catalogues[locale].admin.ai.subtitle)).toBeTruthy();
  });
  it('states what is sent without promising that names are removed', () => {
    const note = en.admin.ai.privacyNote;
    expect(note).toContain('names');
    expect(note).toContain('none mask names');
    expect(note).not.toMatch(/no names/i);
    expect(note).not.toContain('Draft with AI');
  });
});
