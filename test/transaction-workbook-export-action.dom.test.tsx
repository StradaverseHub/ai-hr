/**
 * Export to Excel without a whole-tree render inside the action (staging timing, 24 Nov 2026).
 *
 * Export to Excel used to redirect() from its server action. Next then fetched the workbook list from its own server
 * with the router state removed, so the whole tree, app shell included, rendered again inside the action: about 33
 * database transactions and ~0.75 s of a ~1.2 s click. Now the action returns the list's address and the form
 * navigates in-app, so only the workbooks segment renders. The list's own poll is PR #272. Fictional fixtures only.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push }) }));

const { WorkbookExportForm } = await import('../app/payroll/transaction-view/workbook-export-form');

beforeEach(() => { refresh.mockReset(); push.mockReset(); });

describe('WorkbookExportForm', () => {
  it('navigates in-app to the workbook list the action returns', async () => {
    const action = vi.fn(async () => '/payroll/transaction-view/workbooks?tab=history&job=job-a');
    render(<WorkbookExportForm action={action}><input type="hidden" name="scope" value="current" /><button type="submit">This view</button></WorkbookExportForm>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'This view' })); });
    expect(action).toHaveBeenCalledTimes(1);
    expect((action.mock.calls[0] as unknown as [FormData])[0].get('scope')).toBe('current');
    expect(push).toHaveBeenCalledWith('/payroll/transaction-view/workbooks?tab=history&job=job-a');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('never navigates anywhere but the workbook list', async () => {
    for (const href of ['https://example.invalid/payroll/transaction-view/workbooks', '/payroll/transaction-view/workbooks-other', '/']) {
      push.mockReset();
      const action = vi.fn(async () => href);
      const { unmount } = render(<WorkbookExportForm action={action}><button type="submit">Export</button></WorkbookExportForm>);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Export' })); });
      expect(action).toHaveBeenCalledTimes(1);
      expect(push, href).not.toHaveBeenCalled();
      unmount();
    }
  });
});

describe('the Transaction View export actions', () => {
  const page = readFileSync(resolve(__dirname, '..', 'app/payroll/transaction-view/page.tsx'), 'utf8');
  const actionBody = (name: string) => {
    const at = page.indexOf(`async function ${name}(`);
    expect(at, `${name} not found`).toBeGreaterThan(-1);
    const body = page.slice(at, page.indexOf('\n  }\n', at));
    expect(body.length).toBeGreaterThan(100);
    return body;
  };

  it('return the list address instead of redirecting, so no whole-tree render rides on the action', () => {
    for (const name of ['startWorkbookExport', 'startHistoryWorkbookExport']) {
      const body = actionBody(name);
      expect(body, name).toContain("'use server'");
      expect(body, name).toContain('await scopedAdmin()');
      expect(body, name).toContain('Promise<string>');
      expect(body, name).not.toMatch(/\bredirect\s*\(/);
      expect(body, name).toMatch(/return `\$\{\w+\}&job=\$\{row\.id\}`/);
    }
    expect(page).toContain('<WorkbookExportForm action={startWorkbookExport}>');
    expect(page).toContain('<WorkbookExportForm key={choice.scope} action={startHistoryWorkbookExport}>');
  });
});
