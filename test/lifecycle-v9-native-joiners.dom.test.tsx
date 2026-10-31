import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { NativeJoiners, type NativeJoinersData } from '../app/(app)/lifecycle/v9/native-joiners';
import { blankCase, defaultConfig, progress } from '../lib/onboarding-model';
import { todayInKualaLumpur } from '../lib/hr-date';

it('uses the native register, identities and progress while applying V9 company and search filters', () => {
  const today = todayInKualaLumpur(), config = defaultConfig('owner');
  const env = { today, now: today + 'T02:00:00Z', id: () => 'fixture-id', nextNumber: () => 'IT-fixture', leave: {}, taskLoads: {}, lastTaskAssignment: {}, pendingApprovals: {}, lifetimeApprovals: {}, users: [] };
  const first = blankCase('native-one', 'OB-001', 'draft-one', { fullName: 'Fictional Joiner One', employeeId: 'EMP-101', joinDate: today, company: 'company-one' }, env);
  const second = blankCase('native-two', 'OB-002', 'draft-two', { fullName: 'Fictional Joiner Two', employeeId: 'EMP-102', joinDate: today, company: 'company-two' }, env);
  const data: NativeJoinersData = { config, rows: [first, second].map(c => ({ case: c, revision: 1, isNew: false, progress: progress(config, c) })), options: { company: [], department: [], businessGroup: [], grade: [], title: [], employmentType: [], supervisor: [] } };
  const snapshot = JSON.stringify(data);
  const messages = JSON.parse(readFileSync('messages/en.json', 'utf8'));
  render(<NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Kuala_Lumpur"><NativeJoiners data={data} company="company-one" search="EMP-101"/></NextIntlClientProvider>);
  expect(screen.getByRole('link', { name: 'Fictional Joiner One' })).toHaveAttribute('href', '/lifecycle/v9/onboarding/native-one');
  expect(screen.queryByRole('link', { name: 'Fictional Joiner Two' })).not.toBeInTheDocument();
  expect(screen.getByText('OB-001')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'New Joiners' })).not.toBeInTheDocument();
  expect(JSON.stringify(data)).toBe(snapshot);
});
it('shows the module access requirement without a register projection', () => {
  render(<NativeJoiners data={null} company="" search=""/>);
  expect(screen.getByRole('heading', { name: 'New Joiners access' })).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});
