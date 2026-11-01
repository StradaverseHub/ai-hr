/** REVIEW (independent UI review) — drafted as test/review/how-it-works-tabs-aria.dom.test.tsx.
 *
 * components/ai-centre/how-it-works.tsx implements two WAI-ARIA tab lists:
 *  - chapters (line 49-58): every tab carries aria-controls="how-panel-<key>", but only the SELECTED
 *    chapter's panel is rendered (line 59), so three of four aria-controls point at ids that do not exist;
 *  - steps (line 210-217): nine role="tab" buttons with no aria-controls and no role="tabpanel" anywhere
 *    for them; the step text they switch sits in an aria-live div, not a tabpanel.
 * The tab pattern requires each tab to control a panel that exists. Expected fix: render the chapter
 * panels hidden (or only give aria-controls to the selected tab), and either give the step region
 * role="tabpanel" + aria-labelledby with each step tab's aria-controls pointing at it, or make the step
 * dots a plain button group (aria-current="step") instead of tabs.
 *
 * FAILS on 7d57fc6a4; the third case passes and pins the keyboard model that already works. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import aiEn from '../../messages/ai-centre/en.json';
import { enWithAiCentre } from '../helpers/ai-centre-messages';
import { HowItWorks } from '../../components/ai-centre/how-it-works';

const how = aiEn.aiCentre.how;
beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn() }));
});
const show = () => render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never} timeZone="Asia/Kuala_Lumpur"><HowItWorks /></NextIntlClientProvider>);

describe('How it works tab semantics', () => {
  it('fixed L3: every chapter tab aria-controls an element that exists', () => {
    const view = show();
    const tabs = within(screen.getByRole('tablist', { name: how.chaptersLabel })).getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    const dangling = tabs.map(tab => tab.getAttribute('aria-controls')).filter(id => id && !view.container.querySelector(`#${id}`));
    expect(dangling).toEqual([]);
  });

  it('fixed L4: the step tabs control a tabpanel (or are not tabs)', () => {
    const view = show();
    const tabs = within(screen.getByRole('tablist', { name: how.stepsLabel })).getAllByRole('tab');
    expect(tabs).toHaveLength(9);
    for (const tab of tabs) {
      const id = tab.getAttribute('aria-controls');
      expect(id, 'step tab has no aria-controls').toBeTruthy();
      expect(view.container.querySelector(`#${id}`)?.getAttribute('role')).toBe('tabpanel');
    }
  });

  it('REVIEW pass: chapter arrows move selection and focus, and the panel follows', () => {
    show();
    const chapters = screen.getByRole('tablist', { name: how.chaptersLabel });
    const first = within(chapters).getByRole('tab', { name: how.chapters.request });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    const jobs = within(chapters).getByRole('tab', { name: how.chapters.jobs });
    expect(jobs).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(jobs);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', jobs.id);
  });
});
