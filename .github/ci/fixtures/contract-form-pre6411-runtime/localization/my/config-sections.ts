/**
 * MY country-admin configuration sections (ADR-0080 rung 5c, D4). The Statutory Configuration surface
 * the MY pack contributes: one section per statutory body, mounted at its current URL (no user-visible
 * churn). The generic landing page renders the `overview` sections' links from this list, and each
 * config route resolves the acting company's pack and 404s unless it declares a section with the
 * route's key (`app/payroll/configuration/guard.ts`).
 *
 * Order matches `components/statutory-tabs.tsx` (epf, socso, skbbk, eis, pcb, hrdf). SKBBK is a routed
 * section but `overview: false` — it rides the SOCSO bands (674ff6a5) and is not independently
 * versioned, so it does NOT appear in the landing-page per-body version grid. Filtering to `overview`
 * yields epf, socso, eis, pcb, hrdf in that order — byte-identical to the old
 * `STATUTORY_BODIES.filter((b) => b !== 'ot')` grid.
 */
import type { ConfigSectionDescriptor } from '../country-pack';

const BASE = '/payroll/configuration';

export const MY_CONFIG_SECTIONS: ConfigSectionDescriptor[] = [
  { key: 'epf', labelKey: 'body_epf', href: `${BASE}/epf`, overview: true },
  { key: 'socso', labelKey: 'body_socso', href: `${BASE}/socso`, overview: true },
  { key: 'skbbk', labelKey: 'body_skbbk', href: `${BASE}/skbbk` },
  { key: 'eis', labelKey: 'body_eis', href: `${BASE}/eis`, overview: true },
  { key: 'pcb', labelKey: 'body_pcb', href: `${BASE}/pcb`, overview: true },
  { key: 'hrdf', labelKey: 'body_hrdf', href: `${BASE}/hrdf`, overview: true },
];
