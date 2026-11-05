/** REVIEW (independent UI review) — drafted as test/review/ai-centre-link-targets.dom.test.tsx.
 *
 * PASSING coverage test. Every fixed href the AI centre renders resolves to an app/<route>/page.tsx, and the
 * tab bar hides administrator tabs from non-administrators (the pages' own requireAdmin stays the gate).
 * Hrefs taken from: lib/ai-centre/centre-nav.ts (tabs, subnav via aiManagementHref), the retired Inbox (removed; Today replaces it)
 * (findings), core/digest/daily-digest.ts (DIGEST_PAGES), delegated-jobs.tsx, review-shell.tsx,
 * worker-registry.tsx and app/control-tower/how-it-works/page.tsx (now the 308 to How it works). */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { enWithAiCentre } from '../helpers/ai-centre-messages';
import { ADMIN_GROUPS, CENTRE_SECTIONS, CENTRE_TABS } from '../../lib/ai-centre/centre-nav';
import { aiManagementHref } from '../../app/control-tower/agents/sections';

vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
import { AiCentreTabs } from '../../components/ai-centre/centre-tabs';

const pageFor = (href: string) => join(process.cwd(), 'app', href.split(/[?#]/)[0], 'page.tsx');
// AI Centre restructure: the setup finding opens /payroll/setup (Today fix c), prepared fixes open Exceptions, Settings is
// where threshold proposals are decided, and a person's own readiness is its own page.
const FIXED = ['/control-tower/exceptions', '/control-tower/readiness', '/approvals', '/payroll/statutory-forms', '/payroll/setup',
  '/delegations', '/control-tower/how-it-works', '/admin/scheduled-actions', '/control-tower/agents/allowances', '/control-tower/loops/payroll-cycle/settings',
  '/me/payroll-readiness', '/control-tower/agents/build-list'];

describe('AI centre link targets', () => {
  it('REVIEW pass: every tab, subnav and fixed link has a page', () => {
    const hrefs = [...CENTRE_TABS.map(tab => tab.href), ...Object.values(CENTRE_SECTIONS).flat().map(section => section.href), ...Object.values(ADMIN_GROUPS).flat().map(item => aiManagementHref(item.section)), ...FIXED];
    expect(hrefs.filter(href => !existsSync(pageFor(href === '/assistant' || href.startsWith('/assistant?') ? '/assistant' : href)))).toEqual([]);
  });

  it('REVIEW pass: a non-administrator sees Ask, Policies and How it works only (Insights is for administrators, Delegated jobs hidden)', () => {
    render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never}><AiCentreTabs active="how" isAdmin={false} /></NextIntlClientProvider>);
    expect(screen.getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['/assistant', '/policies', '/assistant?view=how']);
    expect(screen.getByRole('link', { current: 'page' })).toHaveAttribute('href', '/assistant?view=how');
  });
});
