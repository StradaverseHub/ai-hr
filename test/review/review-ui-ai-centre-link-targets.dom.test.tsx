/** REVIEW (independent UI review) — drafted as test/review/ai-centre-link-targets.dom.test.tsx.
 *
 * PASSING coverage test. Every fixed href the AI centre renders resolves to an app/<route>/page.tsx, and the
 * tab bar hides administrator tabs from non-administrators (the pages' own requireAdmin stays the gate).
 * Hrefs taken from: lib/ai-centre/centre-nav.ts (tabs, subnav via aiManagementHref), app/assistant/centre/inbox.tsx
 * (findings), core/digest/daily-digest.ts (DIGEST_PAGES), delegated-jobs.tsx, review-shell.tsx,
 * worker-registry.tsx and app/control-tower/how-it-works/page.tsx. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { enWithAiCentre } from '../helpers/ai-centre-messages';
import { ADMIN_GROUPS, CENTRE_TABS } from '../../lib/ai-centre/centre-nav';
import { aiManagementHref } from '../../app/control-tower/agents/sections';

vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
import { AiCentreTabs } from '../../components/ai-centre/centre-tabs';

const pageFor = (href: string) => join(process.cwd(), 'app', href.split(/[?#]/)[0], 'page.tsx');
const FIXED = ['/control-tower/exceptions', '/control-tower/actions', '/control-tower/readiness', '/approvals', '/payroll/statutory-forms',
  '/delegations', '/control-tower/how-it-works', '/admin/scheduled-actions', '/control-tower/agents/allowances'];

describe('AI centre link targets', () => {
  it('REVIEW pass: every tab, subnav and fixed link has a page', () => {
    const hrefs = [...CENTRE_TABS.map(tab => tab.href), ...Object.values(ADMIN_GROUPS).flat().map(item => aiManagementHref(item.section)), ...FIXED];
    expect(hrefs.filter(href => !existsSync(pageFor(href === '/assistant' || href.startsWith('/assistant?') ? '/assistant' : href)))).toEqual([]);
  });

  it('REVIEW pass: a non-administrator sees Ask, Inbox, Delegated jobs and How it works only', () => {
    render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never}><AiCentreTabs active="inbox" isAdmin={false} inboxCount={3} /></NextIntlClientProvider>);
    expect(screen.getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['/assistant', '/assistant?view=inbox', '/assistant?view=jobs', '/assistant?view=how']);
    expect(screen.getByRole('link', { current: 'page' })).toHaveAttribute('href', '/assistant?view=inbox');
    expect(screen.getByText('3 items waiting')).toHaveClass('sr-only');
  });
});
