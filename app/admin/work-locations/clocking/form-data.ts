/**
 * r423 (83c0d3c8) — what the New and Edit clocking-location pages both need beside the record: the companies
 * the location may be opened to and the State vocabulary. ONE helper so the two pages cannot offer
 * different companies or different states.
 *
 * A server-only module (it reads the database through core/read), imported only by the two server pages.
 * The companies are the ones the caller ADMINISTERS (`adminOnly`) — for a group administrator, the only
 * people who reach the form, that is every company — named the way the list names them
 * (company label, else legal name). The states are those of the companies' countries
 * (core/state-vocabulary), which is what the service validates against.
 */
import type { SessionContext } from '@/db/client';
import { listCompanies } from '@/core/read';
import { statesForCountries } from '@/core/state-vocabulary';

export async function clockingFormOptions(s: SessionContext) {
  const companies = await listCompanies(s, { adminOnly: true });
  return {
    companies: companies
      .map((c) => ({ id: c.id, name: c.companyLabel ?? c.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    stateOptions: [...statesForCountries(companies.map((c) => c.country))],
  };
}
