import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { RewardsAdminTabs } from '../app/(app)/admin/rewards/admin-tabs';
afterEach(cleanup);
describe('086915a8: Rewards admin tabs', () => {
    it.each([['configuration', '/admin/rewards'], ['shared', '/admin/rewards/shared'], ['access', '/admin/rewards/access']] as const)('marks only the %s page as current', (current, href) => {
        render(<NextIntlClientProvider locale="en" messages={en}><RewardsAdminTabs current={current}/></NextIntlClientProvider>);
        const nav = screen.getByRole('navigation', { name: en.rewardsAdminTabs.label });
        const links = Array.from(nav.querySelectorAll('a'));
        expect(links.map(a => [a.textContent, a.getAttribute('href')])).toEqual([[en.rewardsAdminTabs.configuration, '/admin/rewards'], [en.rewardsAdminTabs.shared, '/admin/rewards/shared'], [en.rewardsAdminTabs.access, '/admin/rewards/access']]);
        expect(links.filter(a => a.getAttribute('aria-current') === 'page').map(a => a.getAttribute('href'))).toEqual([href]);
    });
    it('replaces the loose header links on the access and shared pages', () => {
        const access = readFileSync(join(process.cwd(), 'app/(app)/admin/rewards/access/page.tsx'), 'utf8');
        const shared = readFileSync(join(process.cwd(), 'app/(app)/admin/rewards/shared/page.tsx'), 'utf8');
        expect(access).toContain('<RewardsAdminTabs current="access"/>');
        expect(access).not.toContain('href="/admin/rewards"');
        expect(shared).toContain('<RewardsAdminTabs current="shared"/>');
        expect(shared).not.toContain("t('backToReviews')");
    });
    it('replaces the loose links on the configuration page and flags reviews with roles missing', () => {
        const config = readFileSync(join(process.cwd(), 'app/(app)/admin/rewards/page.tsx'), 'utf8');
        expect(config).toContain('<RewardsAdminTabs current="configuration"/>');
        expect(config).not.toContain('href="/admin/rewards/access"');
        expect(config).toContain("ta('rolesMissing'");
    });
});
