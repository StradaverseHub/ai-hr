import { useState } from 'react';
import { expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MatchingRules } from '../app/(app)/lifecycle/v9/workspace-settings';
import { v9EmploymentLabels } from '../lib/lifecycle-v9-employment';
import type { Rules } from '../lib/lifecycle-v9-model';
function Editor() {
  const [rules, change] = useState<Rules>({ employmentType: ['contract'] });
  return <><MatchingRules rules={rules} labels={{ employmentType: v9EmploymentLabels }} dimensions={['employmentType']} disabled={false} change={change}/><output data-testid="rules">{JSON.stringify(rules)}</output></>;
}
it('edits the three approved categories and normalizes the existing Contract alias without duplicate choices', () => {
  render(<Editor/>);
  fireEvent.click(screen.getByText('Employment type · 1 selected'));
  expect(screen.getAllByRole('checkbox')).toHaveLength(3);
  expect(screen.getByRole('checkbox', { name: 'Contract' })).toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Probation' }));
  expect(JSON.parse(screen.getByTestId('rules').textContent!)).toEqual({ employmentType: ['Contract', 'Probation'] });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Contract' }));
  expect(JSON.parse(screen.getByTestId('rules').textContent!)).toEqual({ employmentType: ['Probation'] });
});
it('keeps an existing unsupported rule visible for HR review without relabelling it as Permanent', () => {
  render(<MatchingRules rules={{ employmentType: ['part_time'] }} labels={{ employmentType: v9EmploymentLabels }} dimensions={['employmentType']} disabled={true} change={() => { throw Error('read only'); }}/>);
  fireEvent.click(screen.getByText('Employment type · 1 selected'));
  expect(screen.getByRole('checkbox', { name: 'Part time (existing rule)' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Permanent' })).not.toBeChecked();
  for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toBeDisabled();
});
