/**
 * Register every module pack. Import this for the side effect; it exports nothing.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Pack registration used to live as five side-effect imports at the top of `components/sidebar.tsx`
 * (ADR-0080 rungs 2-7). That worked because the sidebar was the only consumer — but it made the
 * registry a CLIENT-COMPONENT side effect, so any code outside the client bundle calling
 * `listPacks('module')` got an empty array, silently: not an error, just an empty list.
 *
 * The consumer that needs it TODAY is the catalog<->registry drift ratchet
 * (`test/module-catalog-drift.test.ts`), which pins every registered pack to a catalog row in both
 * directions and cannot run inside a client component. (An earlier version of this comment named the
 * operator console's module picker instead — app/operator/page.tsx reads MODULE_CATALOG directly and
 * never calls listPacks, so that justification pointed at a caller that does not exist. It is the kind
 * of comment that gets the wrong thing deleted, hence the correction rather than a tidy-up.) Slice 4's
 * nav filter is the next caller, and it is server-side too.
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
import '@/packs/lifecycle';

import './rewards';
