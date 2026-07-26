/**
 * Register every module pack. Import this for the side effect; it exports nothing.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Pack registration used to live as five side-effect imports at the top of `components/sidebar.tsx`
 * (ADR-0080 rungs 2-7). That worked because the sidebar was the only consumer — but it made the
 * registry a CLIENT-COMPONENT side effect, so any SERVER module calling `listPacks('module')` got an
 * empty array. The operator console's module picker is exactly such a caller, and the failure mode is
 * the worst kind: not an error, just a form with no options.
 *
 * The country axis has always had a server-side equivalent — importing `localization/registry` IS the
 * registration (its `registerPack({ kind: 'country', … })` runs at module load, which is why 30 call
 * sites across core/ and app/ just work). This is the module axis's missing counterpart.
 *
 * Client-safety: every `packs/<name>/index.ts` is client-safe by design (flat descriptors and lucide refs
 * only — the service facades live in `packs/<name>/service.ts` and are never imported here), so the
 * sidebar can keep importing this one file instead of five, and no server-only code follows it into
 * the client bundle. `test/module-pack-registration.test.ts` pins that: this file may import pack
 * INDEXES only, never a `service`.
 */
import '@/packs/attendance';
import '@/packs/claims';
import '@/packs/performance';
import '@/packs/leave';
import '@/packs/payroll';
