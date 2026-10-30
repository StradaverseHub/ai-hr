'use client';
import { Joiners } from '../onboarding/joiners';
import { effectiveFacts } from '@/lib/onboarding-model';
import type { OnboardingConfig, onboardingList, onboardingOptions } from '@/packs/lifecycle/service';

/** Only an authorized projection of the existing owner; no V9 copy of a joiner or task is created. */
export type NativeJoinersData = {
  config: OnboardingConfig;
  rows: Awaited<ReturnType<typeof onboardingList>>;
  options: Awaited<ReturnType<typeof onboardingOptions>>;
};
export function NativeJoiners({ data, company, search }: { data: NativeJoinersData | null; company: string; search: string }) {
  if (!data) return <section className="v9-panel"><h2>New Joiners access</h2><p>Your account needs onboarding module access to view this register.</p></section>;
  const query = search.trim().toLocaleLowerCase();
  const rows = data.rows.filter(row => {
    const facts = effectiveFacts(row.case);
    return (!company || facts.company === company) && (!query || `${facts.fullName} ${facts.employeeId} ${row.case.number}`.toLocaleLowerCase().includes(query));
  });
  return <Joiners embedded caseBasePath="/lifecycle/v9/onboarding/" rows={rows} config={data.config} options={data.options}/>;
}
