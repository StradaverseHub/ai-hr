import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { RewardsAdminTabs } from '../app/admin/rewards/admin-tabs';
const destinations = [
    ['configuration', '/admin/rewards'],
    ['shared', '/admin/rewards/plans'],
    ['salary', '/admin/rewards/salary-structures'],
    ['bonus', '/admin/rewards/bonus-matrices'],
    ['pat', '/admin/rewards/pat-inputs'],
    ['access', '/admin/rewards/access'],
] as const;
afterEach(cleanup);
describe('086915a8: Rewards admin tabs', () => {
    it.each(destinations)('marks only the %s page as current', (current, href) => {
        render(<NextIntlClientProvider locale="en" messages={en}><RewardsAdminTabs current={current}/></NextIntlClientProvider>);
        const nav = screen.getByRole('navigation', { name: en.rewardsAdminTabs.label });
        const links = Array.from(nav.querySelectorAll('a'));
        expect(links.map(a => [a.textContent, a.getAttribute('href')])).toEqual(destinations.map(([key, url]) => [en.rewardsAdminTabs[key], url]));
        expect(links.filter(a => a.getAttribute('aria-current') === 'page').map(a => a.getAttribute('href'))).toEqual([href]);
    });
    it('only shows the two library destinations in the library-only navigation', () => {
        render(<NextIntlClientProvider locale="en" messages={en}><RewardsAdminTabs current="salary" librariesOnly/></NextIntlClientProvider>);
        const nav = screen.getByRole('navigation', { name: en.rewardsAdminTabs.label });
        expect(Array.from(nav.querySelectorAll('a')).map(a => a.getAttribute('href'))).toEqual(['/admin/rewards/salary-structures', '/admin/rewards/bonus-matrices']);
    });
    it('replaces the loose header links on the access and shared pages', () => {
        const access = readFileSync(join(process.cwd(), 'app/admin/rewards/access/page.tsx'), 'utf8');
        const shared = readFileSync(join(process.cwd(), 'app/admin/rewards/shared/page.tsx'), 'utf8');
        expect(access).toContain('<RewardsAdminTabs current="access"/>');
        expect(access).not.toContain('href="/admin/rewards"');
        expect(shared).toContain('<RewardsAdminTabs current="shared"/>');
        expect(shared).not.toContain("t('backToReviews')");
    });
    it('replaces the loose links on the configuration page and flags reviews with roles missing', () => {
        const config = readFileSync(join(process.cwd(), 'app/admin/rewards/page.tsx'), 'utf8');
        expect(config).toContain('<RewardsAdminTabs current="configuration"/>');
        expect(config).not.toContain('href="/admin/rewards/access"');
        expect(config).toContain("ta('rolesMissing'");
    });
});
