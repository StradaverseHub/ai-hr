// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { ReturnedBanner, RewardStageLabel, rewardDecisionTime } from '../app/(app)/rewards/returned-status';

const wrap = (node: ReactNode) => <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Kuala_Lumpur">{node}</NextIntlClientProvider>;
afterEach(cleanup);
const at = new Date(Date.now() - 3_600_000).toISOString();

describe('Rewards Returned banner and stage label', () => {
  it('shows Returned to BU CEO with reason, actor and date instead of Draft', () => {
    render(wrap(<><RewardStageLabel status="draft" returnedTo="bu" /><ReturnedBanner returned={{ reason: 'Merit for the sales team needs a rethink', at, toSeat: 'bu', actorName: 'Fictional BG Reviewer', actorRole: 'bg' }} /></>));
    const banner = screen.getByRole('status', { name: en.rewards.returnedTo.bu });
    expect(banner.textContent).toContain('Merit for the sales team needs a rethink');
    expect(banner.textContent).toContain(`Returned by Fictional BG Reviewer on ${rewardDecisionTime(at)}`);
    expect(banner.textContent).toContain(en.rewards.returnedReason);
    expect(document.body.textContent).not.toContain(en.rewards.stages.draft);
    expect(screen.getAllByText(en.rewards.returnedTo.bu).length).toBe(2);
  });
  it('falls back to the actor role when the name is not readable, and to BG CEO for a BG-origin request', () => {
    render(wrap(<ReturnedBanner returned={{ reason: 'Business case needs a comparator', at, toSeat: 'bg', actorName: null, actorRole: 'gr' }} />));
    expect(screen.getByRole('status', { name: en.rewards.returnedTo.bg }).textContent).toContain(`Returned by ${en.rewards.roles.gr} on`);
  });
  it('keeps the stored stage label when the review is not returned', () => {
    render(wrap(<><RewardStageLabel status="draft" returnedTo={null} /> <RewardStageLabel status="bg" returnedTo={undefined} /></>));
    expect(document.body.textContent).toContain(en.rewards.stages.draft);
    expect(document.body.textContent).toContain(en.rewards.stages.bg);
    expect(document.body.textContent).not.toContain('Returned');
  });
});
