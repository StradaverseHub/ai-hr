import { expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChecklistPopulation } from '../app/(app)/lifecycle/v9/checklist-population';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import { nativeV9Facts } from '../lib/lifecycle-v9-native';
import { blankCase, type Environment } from '../lib/onboarding-model';
it('shows overlap warnings and the retained choice in the population preview', () => {
  const config = v9Defaults(); config.checklists = [{ id: 'first', name: 'First', module: 'onb', rules: {}, tasks: [] }, { id: 'second', name: 'Second', module: 'onb', rules: {}, tasks: [] }];
  const native = blankCase('case', 'OB-1', 'draft', { fullName: 'Fictional retained joiner' }, { now: '2026-10-30T00:00:00Z' } as Environment);
  render(<ChecklistPopulation config={config} checklist={config.checklists[0]} candidates={[{ id: native.id, module: 'onb', facts: nativeV9Facts(native), selectedChecklistId: 'second' }]}/>);
  expect(screen.getByRole('status')).toHaveTextContent('Equally specific rules can also match Second');
  fireEvent.click(screen.getByText('Population preview · 1 of 1 match'));
  expect(screen.getByText('Fictional retained joiner')).toBeVisible();
  expect(screen.getByText('Second · retained case choice')).toBeVisible();
  expect(screen.getByText('0 cases use this checklist. Confirmed case snapshots and manual choices are retained when rules change.')).toBeVisible();
});
