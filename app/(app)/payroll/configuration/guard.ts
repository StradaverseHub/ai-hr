import { notFound } from 'next/navigation';
import { actingCompanyCountry } from '@/lib/scope';
import { packFor } from '@/localization/registry';
import type { CountryPack } from '@/localization/country-pack';

/**
 * Country-admin route guard (ADR-0080 rung 5c, D4). The Statutory Configuration routes are the MY
 * pack's own UI, but their MOUNTING is registry-driven: each route resolves the ACTING company's
 * country pack and 404s unless that pack declares a configuration section with the route's key. The
 * gate thus moves from "the route file exists" (a global MY route) to "the acting company's pack
 * declares this section" — a company in another country gets that country's sections, and an unknown
 * country gets none (every config route 404s). Mirrors the `requireAdmin()` guard idiom: call it at
 * the top of the route, after auth; it returns the resolved pack for the page to render from.
 *
 * For a MY tenant — the only reality today — MY declares every section, so this never 404s and output
 * stays byte-identical. `key` is undefined for the landing page (`/payroll/configuration`), which
 * requires only that the pack exists and contributes a configuration surface.
 */
export async function requireConfigSection(key?: string): Promise<CountryPack> {
  const country = await actingCompanyCountry();
  const pack = packFor(country);
  if (!pack || pack.configSections.length === 0) notFound();
  if (key && !pack.configSections.some((s) => s.key === key)) notFound();
  return pack;
}
