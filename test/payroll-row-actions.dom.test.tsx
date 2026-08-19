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
import { render, screen } from '@testing-library/react';
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
    render(
      <PayrollRowActions moreLabel="More actions">
        {false}
        {false}
        <button type="button">Reset Payroll</button>
      </PayrollRowActions>,
    );
    expect(screen.getByRole('button', { name: 'Reset Payroll' })).toBeInTheDocument();
    expect(trigger(), 'a menu of one costs a click and saves no width').not.toBeInTheDocument();
  });

  it('two or more ⇒ one trigger, and the actions are hidden until it is pressed', async () => {
    const user = userEvent.setup();
    render(
      <PayrollRowActions moreLabel="More actions">
        <a href="/payroll/b1/reprocess">Reprocess</a>
        <a href="/payroll/b1/remove">Remove Employee</a>
        <button type="button">Reset Payroll</button>
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
    expect(items).toEqual(['Reprocess', 'Remove Employee', 'Reset Payroll']);
  });

  it('the actions handed in are rendered as they were given — the island rewrites nothing', async () => {
    // It receives already-rendered nodes precisely so it cannot alter what an action DOES. A dropped href
    // or a stripped form would be a silent change to a destructive payroll control.
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
});
