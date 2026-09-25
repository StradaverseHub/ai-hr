/**
 * 597c810a point 3 — VIEW THE PROFILE PHOTO, RENDERED AND OPERATED.
 *
 * The reporter's words: "Do not rely only on a small thumbnail to allow the user to inspect the photo…
 * Provide a View button… Open the uploaded Profile Photo in a larger viewing interface… Display the photo
 * at a suitable size while maintaining its original aspect ratio… Provide a clear Close button/action… The
 * user should be able to view the photo without leaving the current employee page."
 *
 * Every clause there is a behaviour, and a source scan cannot answer any of them. What this file drives:
 *   · clicking View opens a labelled modal, and the image inside is `object-contain` at its natural aspect
 *     ratio — NOT the `object-cover` circle of the header, which is the exact rendering the reporter said
 *     was not enough to inspect a photo with;
 *   · Escape closes it, the close control closes it, and a click on the backdrop closes it;
 *   · focus is inside the panel while it is open and TRAPPED there, because a reader who tabs out is
 *     tabbing into a page they cannot see behind an overlay;
 *   · focus RETURNS to the View trigger on every close path — otherwise a keyboard reader lands on <body>,
 *     i.e. the top of a very long employee record, instead of where they were;
 *   · it points at the SAME serve URL the header uses, so no route and no access rule is added.
 *
 * jsdom applies no CSS and computes no layout, so nothing here claims to have measured a size or seen the
 * overlay cover anything. The class names are asserted as the CONTRACT they are (`object-contain` and the
 * viewport bound); what is genuinely exercised is the open/close/focus behaviour.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PhotoLightbox } from '../app/admin/personnel/[employmentId]/photo-lightbox';

const SRC = '/personnel/photo/person-9';

function renderLightbox() {
  const view = render(
    <PhotoLightbox
      src={SRC}
      viewLabel="View photo"
      closeLabel="Close"
      dialogLabel="Aisha Rahman — profile photo"
      alt="Aisha Rahman"
    />,
  );
  const trigger = screen.getByRole('button', { name: 'View photo' });
  return { view, trigger, user: userEvent.setup() };
}

const dialog = () => screen.queryByRole('dialog');
const image = () => document.querySelector('[data-photo-lightbox-image]') as HTMLImageElement | null;

describe('View profile photo — the trigger', () => {
  it('is closed to begin with: no dialog, and no second request for the image', () => {
    renderLightbox();
    expect(dialog()).toBeNull();
    expect(image(), 'the enlarged image must not be fetched until it is asked for').toBeNull();
  });

  it('opens a labelled modal dialog and announces itself as one', async () => {
    const { trigger, user } = renderLightbox();
    await user.click(trigger);
    const d = dialog();
    expect(d).not.toBeNull();
    expect(d!.getAttribute('aria-modal')).toBe('true');
    expect(d!.getAttribute('aria-label')).toBe('Aisha Rahman — profile photo');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the WHOLE photo at its own aspect ratio from the same serve URL — not the header circle', async () => {
    const { trigger, user } = renderLightbox();
    await user.click(trigger);
    const img = image();
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src'), 'no new route: the same RLS-scoped URL the header uses').toBe(SRC);
    expect(img!.getAttribute('alt'), 'the enlarged photo is content, so it carries the name').toBe('Aisha Rahman');
    expect(img!.className, 'object-contain, never object-cover — the crop is what made the header insufficient').toContain(
      'object-contain',
    );
    expect(img!.className).not.toContain('object-cover');
    expect(img!.className, 'a portrait photo must stay inside the viewport').toContain('max-h-[80vh]');
    expect(img!.className).not.toContain('rounded-full');
  });
});

describe('View profile photo — closing, and where focus goes', () => {
  it('focus moves INTO the panel when it opens', async () => {
    const { trigger, user } = renderLightbox();
    await user.click(trigger);
    const close = screen.getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
  });

  it('Escape closes it and returns focus to the View trigger', async () => {
    const { trigger, user } = renderLightbox();
    await user.click(trigger);
    expect(dialog()).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(dialog(), 'Escape is the reporter-facing "close it" and must work').toBeNull();
    expect(document.activeElement, 'a keyboard reader must land back on the control they pressed').toBe(trigger);
  });

  it('the close control closes it and returns focus to the trigger', async () => {
    const { trigger, user } = renderLightbox();
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('a click on the backdrop closes it; a click on the photo does NOT', async () => {
    const { trigger, user } = renderLightbox();
    await user.click(trigger);
    await user.click(image()!);
    expect(dialog(), 'clicking the thing you came to look at must not dismiss it').not.toBeNull();
    // The backdrop is the dialog's parent — the full-viewport click-catcher.
    await user.click(dialog()!.parentElement!);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Tab and Shift+Tab stay inside the panel while it is open', async () => {
    const { trigger, user } = renderLightbox();
    await user.click(trigger);
    const close = screen.getByRole('button', { name: 'Close' });
    await user.tab();
    expect(document.activeElement, 'Tab must not leave the reader behind an overlay they cannot see').toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(close);
    // …and the page underneath is still there when it closes: the reporter asked to inspect the photo
    // WITHOUT leaving the employee page, so nothing here navigates.
    await user.keyboard('{Escape}');
    expect(dialog()).toBeNull();
  });
});
