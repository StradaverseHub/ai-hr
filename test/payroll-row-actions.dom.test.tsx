/**
 * 65e2d5de — the Payroll Process row-action menu, PROVED BY RENDERING.
 *
 * WHY IT NEEDS ITS OWN RENDER TEST. The island's whole contract is a COUNT: it renders nothing for a row
 * with no actions, renders a lone action inline, and only builds a menu from two or more. That count comes
 * from `Children.toArray`, which silently drops the `false` a `{cond && <X/>}` produces — and the server
 * page hands it exactly that shape, three conditions deep. Get the counting wrong and a closed payroll run
 * grows a ⋯ button that opens an empty panel, or a run with one permitted action hides it behind a click.
 * Neither shows up in tsc, the suite or `next build`, and both are what the reporter would see first.
 *
 * The visibility RULES are not tested here and do not live here — they stay on the server page, asserted
 * against its source in test/payroll-process-workflow-65e2d5de.test.ts. This file is only about placement.
 *
 * Scope note (inherited from client-pager.dom.test.tsx): jsdom applies no CSS and computes no layout, so
 * this catches rendering and interaction logic, not a visual regression.
 */
import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PayrollRowActions } from '../app/payroll/row-actions';

const trigger = () => screen.queryByRole('button', { name: 'More actions' });

describe('65e2d5de — the ⋯ menu appears only when it earns its place', () => {
  it('no permitted action ⇒ nothing at all, not an empty menu', () => {
    // A CLOSED run: every condition on the server page is false, so the island is handed three `false`s.
    const { container } = render(
      <PayrollRowActions moreLabel="More actions">
        {false}
        {false}
        {false}
      </PayrollRowActions>,
    );
    expect(container.innerHTML).toBe('');
    expect(trigger()).not.toBeInTheDocument();
  });

  it('exactly one permitted action ⇒ it renders inline, with no menu to open', () => {
    // The real case: multi-cycle off but the reset switch on, which leaves Reset alone beside View.
    // A LINK since 9f8cd608 — Reset opens its own screen exactly as Reprocess and Remove Employee do.
    render(
      <PayrollRowActions moreLabel="More actions">
        {false}
        {false}
        <a href="/payroll/b1/reset">Reset payroll</a>
      </PayrollRowActions>,
    );
    expect(screen.getByRole('link', { name: 'Reset payroll' })).toBeInTheDocument();
    expect(trigger(), 'a menu of one costs a click and saves no width').not.toBeInTheDocument();
  });

  it('two or more ⇒ one trigger, and the actions are hidden until it is pressed', async () => {
    const user = userEvent.setup();
    render(
      <PayrollRowActions moreLabel="More actions">
        <a href="/payroll/b1/reprocess">Reprocess</a>
        <a href="/payroll/b1/remove">Remove Employee</a>
        <a href="/payroll/b1/reset">Reset payroll</a>
      </PayrollRowActions>,
    );
    // Closed: this is the width the reporter asked back — one control in the cell, not four.
    expect(screen.queryByRole('link', { name: 'Reprocess' })).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger()!);
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // Every action arrives, in the order of escalation the server page renders them in: correct one
    // person, take one person off, clear the whole run.
    const items = [...screen.getByRole('menu').querySelectorAll('a, button')].map((el) => el.textContent);
    expect(items).toEqual(['Reprocess', 'Remove Employee', 'Reset payroll']);
  });

  it('the actions handed in are rendered as they were given — the island rewrites nothing', async () => {
    // It receives already-rendered nodes precisely so it cannot alter what an action DOES. A dropped href
    // or a stripped form would be a silent change to a destructive payroll control.
    //
    // The <form> below is a SYNTHETIC node, and deliberately so: it is not the shape the payroll list
    // hands in (since 9f8cd608 that is links only — pinned at the call site in
    // test/payroll-reset-screen-9f8cd608.test.ts), it is the strongest thing that can be handed to this
    // island, and the island's contract is that it passes it through untouched.
    const user = userEvent.setup();
    render(
      <PayrollRowActions moreLabel="More actions">
        <a href="/payroll/b1/reprocess?from=%2Fpayroll%3Fyear%3D2026">Reprocess</a>
        <form action="/x">
          <input type="hidden" name="batchId" value="b1" />
          <button type="submit">Reset Payroll</button>
        </form>
      </PayrollRowActions>,
    );
    await user.click(trigger()!);
    expect(screen.getByRole('link', { name: 'Reprocess' })).toHaveAttribute(
      'href',
      '/payroll/b1/reprocess?from=%2Fpayroll%3Fyear%3D2026',
    );
    const hidden = screen.getByRole('menu').querySelector('input[name="batchId"]') as HTMLInputElement;
    expect(hidden.value).toBe('b1');
  });

  it('clicking away closes it, and pressing the trigger again toggles', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <PayrollRowActions moreLabel="More actions">
        <a href="/a">A</a>
        <a href="/b">B</a>
      </PayrollRowActions>,
    );
    await user.click(trigger()!);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    // The click-away backdrop, which is what makes the panel dismissible without a global listener.
    await user.click(container.querySelector('.fixed.inset-0') as HTMLElement);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(trigger()!);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(trigger()!);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('a scroll ANYWHERE closes it, because the panel is nailed to viewport coordinates', async () => {
    // THE DEFECT THIS PINS. `toggle` measures getBoundingClientRect ONCE and renders the panel `fixed` at
    // those coordinates. Scroll the page and the row moves; the panel does not. It ends up beside a
    // DIFFERENT payroll run while still carrying the original row's hrefs, so a click acts on the run the
    // menu was opened on rather than the one being read. Closing on scroll is the whole mitigation.
    //
    // 9f8cd608 — WHAT IS NO LONGER TRUE HERE, recorded because it was the older, worse half of this note:
    // the panel used to carry a destructive <form> with a ConfirmSubmit whose description said only "this
    // payroll run", so a mis-aimed confirm was unrecoverable and unannounced. Every item is a link to its
    // own screen now, and each of those screens names the company, period, cycle, payment date and
    // headcount of the run it is about — so a mis-aimed click lands somewhere it can be read and left.
    // (It also removed a second defect this test could never see: the dialog was OWNED by this panel, so
    // the very focus-scroll asserted below destroyed it as it opened. jsdom computes no layout, produces
    // no such scroll, and passed regardless.)
    //
    // The backdrop's own onWheel does not cover this. A wheel with the cursor over the PANEL bubbles
    // panel → wrapper and never reaches the backdrop; keyboard scrolling (PageDown, arrows), touch
    // scrolling and a window resize produce no backdrop event at all. Only a window listener does.
    const user = userEvent.setup();
    render(
      <PayrollRowActions moreLabel="More actions">
        <a href="/a">A</a>
        <a href="/payroll/b1/reset">Reset payroll</a>
      </PayrollRowActions>,
    );

    // A scroll on a container that is NOT the backdrop — dispatched on document, caught in capture phase.
    await user.click(trigger()!);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    act(() => {
      document.dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    // And a resize, which moves the row horizontally and has no backdrop event of any kind.
    await user.click(trigger()!);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
