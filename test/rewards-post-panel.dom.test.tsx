// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { RewardPostPanel } from '../app/(app)/rewards/post-panel';

const wrap = (node: ReactNode) => <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Kuala_Lumpur">{node}</NextIntlClientProvider>;
const action = async () => {};
afterEach(cleanup);

describe('H1: the review page Post control follows the posting predicate', () => {
  it('a payroll seat without HR administration sees the reason and no Post button', () => {
    render(wrap(<RewardPostPanel posting="needs-admin" batches={[]} fields={null} action={action} />));
    expect(document.body.textContent).toBe(en.rewards.postNeedsAdmin);
    expect(screen.queryByRole('button', { name: en.rewards.post })).toBeNull();
  });
  it('DR-13 (APR-022): a payroll seat holder who cannot post sees the explanatory line and no Post control', () => {
    // The payroll seat is the hand-off recipient of an approved review; enactment stays administrator-owned.
    const { container } = render(wrap(<RewardPostPanel posting="needs-admin" batches={[{ id: 'b1', period: '2026-10' }]} fields={<input name="revision" defaultValue="1" />} action={action} />));
    expect(en.rewards.postNeedsAdmin.length).toBeGreaterThan(0);
    expect(container.textContent).toBe(en.rewards.postNeedsAdmin);
    expect(screen.queryByRole('button', { name: en.rewards.post })).toBeNull();
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('select[name="batchId"]')).toBeNull();
    expect(container.querySelector('input[name="revision"]')).toBeNull();
  });
  it('an HR administrator with the seat sees Post; an empty batch list explains itself', () => {
    render(wrap(<RewardPostPanel posting="allowed" batches={[]} fields={null} action={action} />));
    expect(screen.getByRole('button', { name: en.rewards.post })).toBeTruthy();
    expect(document.body.textContent).toContain(en.rewards.noPayrollBatch);
    cleanup();
    render(wrap(<RewardPostPanel posting="allowed" batches={[{ id: 'b1', period: '2026-10' }]} fields={null} action={action} />));
    expect(document.body.textContent).not.toContain(en.rewards.noPayrollBatch);
    expect(screen.getByRole('option', { name: '2026-10' })).toBeTruthy();
  });
  it('renders nothing for a viewer without the payroll seat', () => {
    const { container } = render(wrap(<RewardPostPanel posting="no-seat" batches={[]} fields={null} action={action} />));
    expect(container.textContent).toBe('');
  });
});
