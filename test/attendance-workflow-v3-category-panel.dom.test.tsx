import React, { type ComponentPropsWithoutRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: en, namespace: namespace as 'approvals' }) }));
vi.mock('next/link', () => ({
    default: ({ prefetch, ...props }: ComponentPropsWithoutRef<'a'> & { prefetch?: boolean | null }) =>
        <a {...props} data-prefetch={String(prefetch)} />,
}));
import { CategoryPanel } from '../app/approvals/category-panel';
const counts = { leave: 0, leaveCancellation: 0, replacementLeave: 0, attendance: 4, overtime: 2, claim: 0, profileChanges: 0, resignations: 0, managerReviews: 0, hrReviews: 0, rewards: 0, probation: 0, contracts: 0 };
afterEach(cleanup);
describe('request-assigned ordinary employee approval navigation', () => {
    it('shows only all, Attendance and OT for the exact-assignment admission path', async () => {
        render(await CategoryPanel({ category: 'all', counts, allCount: 6, admin: false, attendanceOnly: true }));
        expect(screen.getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['/approvals', '/approvals?category=attendance', '/approvals?category=overtime']);
        expect(screen.queryByText(en.approvals.approvalHistory)).toBeNull();
        expect(screen.getByRole('link', { name: /Attendance.*4/i })).toBeVisible();
    });
    it('prefetches only the focused destination and never the active category', async () => {
        render(await CategoryPanel({ category: 'all', counts, allCount: 6, admin: true }));
        const links = screen.getAllByRole('link');
        expect(links.length).toBeGreaterThan(3);
        expect(links.every(link => link.getAttribute('data-prefetch') === 'false')).toBe(true);
        const [selected] = links;
        expect(selected).toHaveAttribute('aria-current', 'page');
        fireEvent.focus(selected);
        expect(selected).toHaveAttribute('data-prefetch', 'false');
        const history = screen.getByRole('link', { name: en.approvals.approvalHistory });
        fireEvent.focus(history);
        expect(links.filter(link => link.getAttribute('data-prefetch') === 'true')).toEqual([history]);
    });
    it('preserves existing non-admin navigation when request-only admission is absent', async () => {
        render(await CategoryPanel({ category: 'all', counts, allCount: 6, admin: false }));
        expect(screen.getByRole('link', { name: en.approvals.approvalHistory })).toHaveAttribute('href', '/approvals/history');
        expect(screen.getAllByRole('link').some(link => link.getAttribute('href') === '/approvals?category=leave')).toBe(true);
        expect(screen.getAllByRole('link').some(link => link.getAttribute('href') === '/approvals?category=claim')).toBe(true);
    });
});
