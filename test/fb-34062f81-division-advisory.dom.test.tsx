// @vitest-environment jsdom
/**
 * 34062f81 — Payroll > Pay Items: "Basic Salary / Calendar days in the month × Days worked" is VALID, and
 * the division advisory must read as information, not as a refusal. A genuine validation failure keeps its
 * own error and no advisory. The translator is stubbed to echo keys, so these assert keys and roles.
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PayRule } from '../core/pay-rule';

vi.mock('../app/(app)/admin/pay-components/actions', () => ({
  searchPreviewEmployeesAction: vi.fn(async () => []),
  previewPayRuleAction: vi.fn(),
  draftPayRuleAction: vi.fn(),
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

import { PayRuleEditor } from '../app/(app)/admin/pay-components/pay-rule-editor';

afterEach(() => cleanup());

const base = { code: 'UPL', kind: 'deduction', prorates: false, aiEnabled: false, payItems: [], previewEmployees: [], catalogueOnly: true };

const reported: PayRule = {
  kind: 'formula',
  start: { ref: 'basic' },
  terms: [
    { op: '/', operand: { ref: 'calendar_days' } },
    { op: '*', operand: { ref: 'days' } },
  ],
};

describe('34062f81 · the division advisory is informational', () => {
  it('the reported formula is Valid, and the advisory is a neutral note rather than a warning', () => {
    render(<PayRuleEditor {...base} rule={reported} />);
    expect(screen.getByText('valid')).toBeInTheDocument();
    const note = screen.getByTestId('formula-division-advisory');
    expect(note).toHaveAttribute('role', 'note');
    expect(note).toHaveTextContent('formulaDivisionNote');
    // Not drawn in the amber/destructive palette that made it look like a rejection.
    expect(note.className).not.toMatch(/amber|destructive|red-/);
    expect(screen.queryByText(/^errors\./)).toBeNull();
  });

  it('a literal zero divisor is still a genuine error, shown as an error and without the advisory', () => {
    const zero: PayRule = {
      kind: 'formula',
      start: { ref: 'basic' },
      terms: [
        { op: '/', operand: { ref: 'number', value: 0 } },
        { op: '*', operand: { ref: 'days' } },
      ],
    };
    render(<PayRuleEditor {...base} rule={zero} />);
    const err = screen.getByText('errors.UNSAFE_DIVISION');
    expect(err.className).toMatch(/text-destructive/);
    expect(screen.queryByTestId('formula-division-advisory')).toBeNull();
  });

  it('a formula with no live divisor shows no advisory at all', () => {
    const literal: PayRule = {
      kind: 'formula',
      start: { ref: 'basic' },
      terms: [
        { op: '/', operand: { ref: 'number', value: 26 } },
        { op: '*', operand: { ref: 'days' } },
      ],
    };
    render(<PayRuleEditor {...base} rule={literal} />);
    expect(screen.getByText('valid')).toBeInTheDocument();
    expect(screen.queryByTestId('formula-division-advisory')).toBeNull();
  });
});
