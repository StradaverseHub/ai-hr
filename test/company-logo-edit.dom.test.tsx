/**
 * 3c2f55d7 rev 2 — the company-logo edit affordance, RENDERED.
 *
 * The redesign added the one thing the Personnel profile photo does not have: the picked file is shown
 * before it is saved. That preview is state in `CompanyLogoEdit`, but the control that consumes it — the
 * file input and its submit button — lives inside `PhotoEditMenu`, which renders its children behind
 * `{open && …}` and puts a `fixed inset-0` click-catcher behind the panel. So the popover closes on ANY
 * outside click, and when it does the file input unmounts and the pick is gone.
 *
 * A source scan cannot see that. Only a render can answer "after the reader clicks away, is the unsaved
 * preview still on screen telling them to press a button that no longer exists?" — which is exactly the
 * bug this file exists to keep fixed. It also pins the caption's wording contract: the caption must name
 * the submit button that is actually rendered (Upload logo / Replace logo), never a phantom "Save".
 *
 * Scope note: jsdom applies no CSS, so nothing here says anything about how the popover is positioned.
 * Storage, the PNG/JPG rule and the 2 MB limit are server-side and covered by test/company-logo.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import en from '../messages/en.json';
import { CompanyLogoEdit, type CompanyLogoLabels } from '../components/company-logo';

const ORG = en.admin.organization as Record<string, string>;

/**
 * The labels are built the way components/company-panel.tsx builds them — from the real catalogue, with
 * `{action}` filled by whichever submit caption `hasLogo` puts on screen. Using the shipped strings means
 * a future edit that reintroduces a caption naming a non-existent button fails HERE, not in production.
 */
const labelsFor = (hasLogo: boolean): CompanyLogoLabels => {
  const submit = hasLogo ? ORG.logoReplace : ORG.logoUpload;
  return {
    edit: ORG.logoEdit,
    hint: ORG.logoHint,
    upload: ORG.logoUpload,
    replace: ORG.logoReplace,
    remove: ORG.logoRemove,
    none: ORG.logoNone,
    previewPending: ORG.logoPreviewPending.replace('{action}', submit),
  };
};

const PNG = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'brand.png', { type: 'image/png' });

function renderEdit(hasLogo: boolean) {
  const setAction = vi.fn();
  const removeAction = vi.fn();
  const view = render(
    <CompanyLogoEdit
      companyId="c1"
      name="Acme Sdn Bhd"
      hasLogo={hasLogo}
      labels={labelsFor(hasLogo)}
      setAction={setAction}
      removeAction={removeAction}
    />,
  );
  const trigger = () => screen.getByRole('button', { name: ORG.logoEdit });
  const fileInput = () => view.container.querySelector('input[type="file"]') as HTMLInputElement | null;
  const previewImg = () => view.container.querySelector('[data-logo-preview]');
  // The popover's click-catcher: a fixed inset-0 sibling that closes the menu when anything outside it
  // is clicked. Clicking it IS "the reader clicked away".
  const backdrop = () => view.container.querySelector('div.fixed.inset-0') as HTMLElement | null;
  return { ...view, trigger, fileInput, previewImg, backdrop, setAction, removeAction };
}

describe('CompanyLogoEdit · the preview never outlives the control that consumes it', () => {
  it('shows no preview until a file is picked', async () => {
    const user = userEvent.setup();
    const v = renderEdit(false);
    expect(v.previewImg()).toBeNull();
    expect(screen.queryByText(labelsFor(false).previewPending)).not.toBeInTheDocument();

    await user.click(v.trigger());
    expect(v.fileInput()).toBeInTheDocument();
    // Opening the menu alone previews nothing.
    expect(v.previewImg()).toBeNull();
  });

  it('picking a file previews it and captions it with the REAL submit button', async () => {
    const user = userEvent.setup();
    const v = renderEdit(false);
    await user.click(v.trigger());
    await user.upload(v.fileInput()!, PNG());

    expect(v.previewImg()).toBeInTheDocument();
    // The submit the reader can see, and the caption pointing at it, agree.
    const submit = screen.getByRole('button', { name: ORG.logoUpload });
    expect(submit).toBeInTheDocument();
    const caption = screen.getByText(labelsFor(false).previewPending);
    expect(caption).toBeInTheDocument();
    expect(caption.textContent).toContain(ORG.logoUpload);
    expect(caption.textContent).not.toMatch(/\bSave\b/);
  });

  it('clicking AWAY closes the menu and takes the unsaved preview with it', async () => {
    const user = userEvent.setup();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const v = renderEdit(false);
    await user.click(v.trigger());
    await user.upload(v.fileInput()!, PNG());
    expect(v.previewImg()).toBeInTheDocument();

    await user.click(v.backdrop()!);

    // The form is gone — so the pick is gone …
    expect(v.fileInput()).toBeNull();
    expect(screen.queryByRole('button', { name: ORG.logoUpload })).not.toBeInTheDocument();
    // … and so is the preview and its caption. This is the regression this file exists for.
    expect(v.previewImg()).toBeNull();
    expect(screen.queryByText(labelsFor(false).previewPending)).not.toBeInTheDocument();
    // Back to the resting caption, and the object URL was released.
    expect(screen.getByText(`${ORG.logoNone} · ${ORG.logoHint}`)).toBeInTheDocument();
    expect(revoke).toHaveBeenCalled();
    revoke.mockRestore();
  });

  it('closing with the pencil trigger clears it too (both close paths, not just the backdrop)', async () => {
    const user = userEvent.setup();
    const v = renderEdit(true);
    await user.click(v.trigger());
    await user.upload(v.fileInput()!, PNG());
    expect(v.previewImg()).toBeInTheDocument();
    expect(screen.getByText(labelsFor(true).previewPending).textContent).toContain(ORG.logoReplace);

    await user.click(v.trigger()); // toggle shut

    expect(v.fileInput()).toBeNull();
    expect(v.previewImg()).toBeNull();
    expect(screen.queryByText(labelsFor(true).previewPending)).not.toBeInTheDocument();
  });

  it('reopening after a discarded pick starts clean', async () => {
    const user = userEvent.setup();
    const v = renderEdit(true);
    await user.click(v.trigger());
    await user.upload(v.fileInput()!, PNG());
    await user.click(v.backdrop()!);
    await user.click(v.trigger());

    expect(v.fileInput()).toBeInTheDocument();
    expect(v.fileInput()!.files?.length ?? 0).toBe(0);
    expect(v.previewImg()).toBeNull();
  });

  it('the preview is local only — nothing is submitted by picking or by walking away', async () => {
    const user = userEvent.setup();
    const v = renderEdit(true);
    await user.click(v.trigger());
    await user.upload(v.fileInput()!, PNG());
    await user.click(v.backdrop()!);
    expect(v.setAction).not.toHaveBeenCalled();
    expect(v.removeAction).not.toHaveBeenCalled();
  });
});
