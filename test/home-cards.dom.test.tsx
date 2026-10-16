// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/app/home/actions', () => ({ loadHomeCardAction: mock.load, dismissHomeInsightAction: vi.fn(), acknowledgeHomeNoticeAction: vi.fn(), saveHomeSettingsAction: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
        href: string;
    }) => <a href={href} {...props}>{children}</a> }));
vi.mock('next-intl', () => ({ useTranslations: () => ((key: string, args?: Record<string, unknown>) => key + (args ? ' ' + JSON.stringify(args) : '')), useFormatter: () => ({ dateTime: (date: Date) => date.toISOString(), number: (n: number) => String(n) }) }));
import { HomeDay, HomeTimeOff } from '../components/home-cards';
const first = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222';
const day = (locationName: string, dayOff: 'leave' | 'holiday' | null = null) => ({ date: '2026-10-16', serverNow: '2026-10-16T01:00:00.000Z', clockedIn: false, openSince: null, workedSeconds: 0, shift: { code: 'DAY', start: '09:00', end: '18:00' }, locationName, dayOff, clockAvailable: dayOff === null, wfhEnabled: false, policyId: null });
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);
describe('independent Home cards and source-bound async state', () => {
    it('does not let a pending day read prevent the time-off card loading', async () => {
        mock.load.mockImplementation((p: {
            card: string;
        }) => p.card === 'day' ? new Promise(() => { }) : Promise.resolve({ ok: true, kind: 'leave', data: { balances: [], next: null, truncated: false } }));
        render(<><HomeDay employmentId={first}/><HomeTimeOff employmentId={first}/></>);
        expect(await screen.findByText('noBalances')).toBeTruthy();
        expect(screen.getByText('loading')).toBeTruthy();
    });
    it.each(['leave', 'holiday'] as const)('keeps the Home clock action hidden for approved %s', async (kind) => {
        mock.load.mockResolvedValue({ ok: true, kind: 'day', data: day('Recorded site', kind) });
        render(<HomeDay employmentId={first}/>);
        expect(await screen.findByText(kind === 'leave' ? 'onLeave' : 'onHoliday')).toBeTruthy();
        expect(screen.queryByRole('link', { name: 'clockIn' })).toBeNull();
        expect(screen.queryByRole('link', { name: 'clockOut' })).toBeNull();
    });
    it('never renders a previous employment or delayed old response under a new selection', async () => {
        let resolveOld!: (value: unknown) => void;
        mock.load.mockImplementation((p: {
            employmentId: string;
        }) => p.employmentId === first ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve({ ok: true, kind: 'day', data: day('Second recorded site') }));
        const root = render(<HomeDay employmentId={first}/>);
        await waitFor(() => expect(mock.load).toHaveBeenCalled());
        root.rerender(<HomeDay employmentId={second}/>);
        expect(await screen.findByText('Second recorded site')).toBeTruthy();
        await act(async () => resolveOld({ ok: true, kind: 'day', data: day('Old private site') }));
        expect(screen.queryByText('Old private site')).toBeNull();
        expect(screen.getByRole('link', { name: 'clockIn' }).getAttribute('href')).toBe('/attendance/clock?employmentId=' + second);
    });
    it('does not claim zero hours or an allowed clock action when the read refuses', async () => {
        mock.load.mockResolvedValue({ ok: false, code: 'unavailable' });
        render(<HomeDay employmentId={first}/>);
        expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'loadFailed');
        expect(screen.queryByText(/^worked/)).toBeNull();
        expect(screen.queryByRole('link', { name: 'clockIn' })).toBeNull();
    });
});
