/**
 * Malaysian statutory ruleset — loader + management service (ADR-0019).
 *
 * The verified figures live as code in statutory-tables.ts (DEFAULT_MY_STATUTORY). This module lets
 * an admin VIEW the active set and OVERRIDE it with an effective-dated, validated, audited version
 * stored in `statutory_ruleset` (tenant-scoped, RLS). The code default is the authoritative floor:
 * an empty table ⇒ exactly the built-in behaviour. Past payslips snapshot their own figures, so an
 * edit only ever affects future runs.
 */
import { assertChildQualificationReliefs, prepareChildQualificationReliefs, ChildReliefConfigurationError } from '../child-qualification';
import { and, desc, eq, isNull, lte } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  statutoryComponentOverride,
  statutoryPack,
  statutoryPackSyncLog,
  statutoryRuleset,
  statutorySigningKey,
} from '../../db/schema';
import {
  CHILD_RELIEF_CATEGORY_KEYS,
  DEFAULT_MY_STATUTORY,
  MY_STATUTORY_VERSION,
  STATUTORY_BODIES,
  type ContribBand,
  type PcbBand,
  type StatutoryBody,
  type StatutoryRuleset,
} from './statutory-tables';

function today(): string {
  return todayInKualaLumpur();
}

// ─────────────────────────────── Loader (kernel) — 3-tier merge ───────────────────────────────

/** Per-body provenance (ADR-0037): which version of THIS body applied, and from where. */
export type ComponentProvenance = {
  version: string;
  source: 'default' | 'override' | 'pack' | 'component';
  effectiveFrom: string | null;
};

export type ActiveResolution = {
  ruleset: StatutoryRuleset;
  source: 'default' | 'override' | 'pack';
  effectiveFrom: string | null;
  version: string;
  packVersion: string | null;
  issuedAt: string | null;
  signedKeyId: string | null;
  /** The winning tenant override row (only when source === 'override'). */
  overrideRow: StatutoryRulesetRow | null;
  /** Per-body provenance after the overlay (ADR-0037): each statutory body's effective version+source. */
  components: Record<StatutoryBody, ComponentProvenance>;
};

/** The bundled baseline resolution, before the per-body overlay is applied. */
type BaselineResolution = Omit<ActiveResolution, 'components'>;

/**
 * Resolve the active ruleset for `asOf` across THREE sources, in ONE tx snapshot (ADR-0020 §6):
 *   tenant override (statutory_ruleset) ∪ vendor pack (statutory_pack) → else code DEFAULT_MY_STATUTORY.
 *
 * Total order (head wins): effective_from DESC, then issuanceTs DESC (pack.issued_at | override.created_at),
 * then source rank (an override outranks a pack ONLY at equal issuanceTs — a tenant must RE-ISSUE after a
 * pack to keep winning, so a same-date vendor correction is never silently shadowed), then packVersion DESC,
 * then id. Packs signed by a REVOKED key are excluded. The pack read FAILS SAFE: any error → packs ignored,
 * so the kernel can never break because of the pack channel. Empty override + empty pack ⇒ DEFAULT.
 */
async function resolveActiveRulesetMY(tx: Tx, asOf: string): Promise<ActiveResolution> {
  const overrides = await tx
    .select()
    .from(statutoryRuleset)
    .where(
      and(
        eq(statutoryRuleset.country, 'MY'),
        isNull(statutoryRuleset.archivedAt),
        lte(statutoryRuleset.effectiveFrom, asOf),
      ),
    );

  let packs: (typeof statutoryPack.$inferSelect)[] = [];
  // Break-glass (ADR-0020 §1): an incident can pin the engine to the code default + tenant overrides only.
  try {
    if (process.env.STATUTORY_PACK_DISABLE === '1') throw new Error('packs disabled');
    const keys = await tx
      .select({ keyId: statutorySigningKey.keyId, status: statutorySigningKey.status })
      .from(statutorySigningKey);
    const active = new Set(keys.filter((k) => k.status !== 'revoked').map((k) => k.keyId));
    const rows = await tx
      .select()
      .from(statutoryPack)
      .where(and(eq(statutoryPack.country, 'MY'), lte(statutoryPack.effectiveFrom, asOf)));
    packs = rows.filter((pk) => active.has(pk.signedKeyId)); // exclude revoked-key packs
  } catch {
    packs = []; // fail safe: the pack channel must never break payroll
  }

  type Cand = { effFrom: string; issuanceMs: number; rank: number; packVersion: string; id: string; res: BaselineResolution };
  const cands: Cand[] = [];
  for (const o of overrides) {
    cands.push({
      effFrom: o.effectiveFrom,
      issuanceMs: o.createdAt.getTime(),
      rank: 1, // override outranks pack only at equal issuanceTs
      packVersion: '',
      id: o.id,
      res: {
        ruleset: o.data as StatutoryRuleset,
        source: 'override',
        effectiveFrom: o.effectiveFrom,
        version: o.version,
        packVersion: null,
        issuedAt: null,
        signedKeyId: null,
        overrideRow: mapRow(o),
      },
    });
  }
  for (const pk of packs) {
    cands.push({
      effFrom: pk.effectiveFrom,
      issuanceMs: pk.issuedAt.getTime(),
      rank: 0,
      packVersion: pk.packVersion,
      id: pk.id,
      res: {
        ruleset: pk.data as StatutoryRuleset,
        source: 'pack',
        effectiveFrom: pk.effectiveFrom,
        version: pk.rulesetVersion,
        packVersion: pk.packVersion,
        issuedAt: pk.issuedAt.toISOString(),
        signedKeyId: pk.signedKeyId,
        overrideRow: null,
      },
    });
  }

  let base: BaselineResolution;
  if (cands.length === 0) {
    base = {
      ruleset: DEFAULT_MY_STATUTORY,
      source: 'default',
      effectiveFrom: null,
      version: DEFAULT_MY_STATUTORY.version,
      packVersion: null,
      issuedAt: null,
      signedKeyId: null,
      overrideRow: null,
    };
  } else {
    cands.sort(
      (a, b) =>
        b.effFrom.localeCompare(a.effFrom) ||
        b.issuanceMs - a.issuanceMs ||
        b.rank - a.rank ||
        b.packVersion.localeCompare(a.packVersion) ||
        b.id.localeCompare(a.id),
    );
    base = cands[0].res;
  }
  return overlayComponents(tx, asOf, base);
}

/**
 * Per-body overlay (ADR-0037): on top of the bundled `base`, replace each body's slice with the
 * newest-effective component override for that body (if any). Returns the merged ruleset + a per-body
 * provenance map. With NO component rows the baseline ruleset is returned untouched (the same object
 * reference when nothing overrides), so the kernel + every golden test stay byte-identical.
 */
async function overlayComponents(tx: Tx, asOf: string, base: BaselineResolution): Promise<ActiveResolution> {
  const rows = await tx
    .select()
    .from(statutoryComponentOverride)
    .where(
      and(
        eq(statutoryComponentOverride.country, 'MY'),
        isNull(statutoryComponentOverride.archivedAt),
        lte(statutoryComponentOverride.effectiveFrom, asOf),
      ),
    );
  // Newest per body: latest effective_from, then latest created_at.
  const newest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = newest.get(r.body);
    if (
      !cur ||
      r.effectiveFrom > cur.effectiveFrom ||
      (r.effectiveFrom === cur.effectiveFrom && r.createdAt.getTime() > cur.createdAt.getTime())
    ) {
      newest.set(r.body, r);
    }
  }

  const components = {} as Record<StatutoryBody, ComponentProvenance>;
  let merged = base.ruleset;
  let cloned = false;
  for (const body of STATUTORY_BODIES) {
    const ov = newest.get(body);
    if (ov) {
      if (!cloned) {
        merged = { ...base.ruleset }; // never mutate the shared DEFAULT_MY_STATUTORY singleton
        cloned = true;
      }
      (merged as Record<string, unknown>)[body] = ov.data;
      components[body] = { version: ov.version, source: 'component', effectiveFrom: ov.effectiveFrom };
    } else {
      components[body] = { version: base.version, source: base.source, effectiveFrom: base.effectiveFrom };
    }
  }
  return { ...base, ruleset: merged, components };
}

/**
 * The ruleset in effect at `asOf` for the kernel: the merged resolution above, reduced to the ruleset.
 * `core/payroll.ts` calls this once per run and threads the result into the calculators.
 */
export async function getActiveStatutoryMY(tx: Tx, p: { asOf: string }): Promise<StatutoryRuleset> {
  return (await resolveActiveRulesetMY(tx, p.asOf)).ruleset;
}

/** Like getActiveStatutoryMY but returns the full resolution (ruleset + source + packVersion + signedKeyId)
 *  so the kernel can snapshot pack provenance onto each payslip (ADR-0020 §7). */
export async function getActiveStatutoryResolvedMY(tx: Tx, p: { asOf: string }): Promise<ActiveResolution> {
  return resolveActiveRulesetMY(tx, p.asOf);
}

// ─────────────────────────── Source / provenance metadata ───────────────────────────
// Drives the transparency surface on /payroll/configuration: each section's official source link,
// verified flag, and effective note. Mirrors docs/architecture/STATUTORY-SOURCES.md.

export type StatutorySource = {
  key: 'epf' | 'socso' | 'eis' | 'pcb' | 'ot';
  authority: string;
  url: string;
  verified: boolean;
  effectiveNote: string;
};

export const MY_STATUTORY_SOURCES: StatutorySource[] = [
  {
    key: 'epf',
    authority: 'KWSP / EPF — Third Schedule, EPF Act 1991',
    url: 'https://www.kwsp.gov.my/en/employer/responsibilities/mandatory-contribution',
    verified: true,
    effectiveNote: 'Standard citizen rates, effective Oct 2025. Low-wage RM20 banding flagged.',
  },
  {
    key: 'socso',
    authority: 'PERKESO — Act 4, Third Schedule',
    url: 'https://www.perkeso.gov.my/images/dokumen/151124-Rate%20Contribution%20ACT%204.pdf',
    verified: true,
    effectiveNote: 'Exact band amounts verified to the RM6,000 ceiling (post-Oct-2024).',
  },
  {
    key: 'eis',
    authority: 'PERKESO — Act 800, Second Schedule',
    url: 'https://www.perkeso.gov.my/images/dokumen/151124-Rate%20Contribution%20ACT%20800.pdf',
    verified: true,
    effectiveNote: 'Exact band amounts verified to the RM6,000 ceiling (post-Oct-2024).',
  },
  {
    key: 'pcb',
    authority: 'LHDN — MTD Computerised Calculation 2026 (Table 1: P, M, R, B)',
    url: 'https://www.hasil.gov.my/media/arvlrzh5/spesifikasi-kaedah-pengiraan-berkomputer-pcb-2026.pdf',
    verified: true,
    effectiveNote: 'Resident brackets unchanged for AY2026. Negative B encodes the RM400/RM800 rebate.',
  },
  {
    key: 'ot',
    authority: 'Employment Act 1955 — First Schedule (Amendment) Order 2022',
    url: 'https://www.ilo.org/dyn/natlex/natlex4.detail?p_isn=48055',
    verified: true,
    effectiveNote: 'Wages above the ceiling fall outside statutory OT (ss.60/60A(3)/60D(3)).',
  },
];

// ─────────────────────────────────── Validation ───────────────────────────────────

const inUnit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const nonNeg = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
/** Treat a missing/null/Infinity upper bound as +∞ (the open-ended top band). */
const ceilOf = (n: number | null | undefined): number =>
  n == null || !Number.isFinite(n) ? Number.POSITIVE_INFINITY : n;

/** `upTo` must be strictly ascending; the final band may be open-ended (null/∞). */
function bandsMonotonic(bands: { upTo: number | null }[]): boolean {
  for (let i = 1; i < bands.length; i++) {
    if (ceilOf(bands[i].upTo) <= ceilOf(bands[i - 1].upTo)) return false;
  }
  return true;
}

/**
 * Validate a candidate ruleset. Returns a list of human-readable problems (empty ⇒ valid). Rates are
 * fractions in [0,1]; thresholds/ceilings/amounts ≥ 0; bands non-empty and monotonic by `upTo`; PCB
 * `R` is a rate, `M`/relief amounts ≥ 0 (B may be negative — it encodes the rebate).
 */
export function validateStatutoryRuleset(data: StatutoryRuleset): string[] {
  const errs: string[] = [];
  if (!data || typeof data !== 'object') return ['Ruleset is missing or malformed.'];
  if (typeof data.version !== 'string' || data.version.trim() === '') errs.push('Version is required.');

  const epf = data.epf;
  if (!epf) errs.push('EPF section is missing.');
  else {
    if (!inUnit(epf.employeeRate)) errs.push('EPF employee rate must be between 0 and 1.');
    if (!inUnit(epf.employerRateLow)) errs.push('EPF employer rate (low band) must be between 0 and 1.');
    if (!inUnit(epf.employerRateHigh)) errs.push('EPF employer rate (high band) must be between 0 and 1.');
    if (!nonNeg(epf.employerThreshold)) errs.push('EPF employer threshold must be ≥ 0.');
    // EPF Third-Schedule band tables (Part A / Part E) are now admin-editable (feedback 99e13860). They
    // are OPTIONAL — an override omitting them falls back to the verified built-ins — but any PRESENT
    // table must ascend by upper bound and carry non-negative contribution AMOUNTS (RM, not rates). This
    // reuses the same monotonic/non-neg checks the SOCSO/EIS band tables use just below.
    for (const [name, bands] of [
      ['Part A', epf.partA],
      ['Part E', epf.partE],
    ] as const) {
      if (bands == null) continue; // absent ⇒ built-in fallback, nothing to validate
      if (!Array.isArray(bands) || bands.length === 0) errs.push(`EPF ${name} bands are empty.`);
      else {
        if (!bandsMonotonic(bands)) errs.push(`EPF ${name} bands must ascend by upper bound.`);
        if (bands.some((b: ContribBand) => !nonNeg(b.employer) || !nonNeg(b.employee)))
          errs.push(`EPF ${name} amounts must be ≥ 0.`);
      }
    }
  }

  if (!nonNeg(data.contribCeiling)) errs.push('Contribution ceiling must be ≥ 0.');

  const socso = data.socso;
  if (!socso) errs.push('SOCSO section is missing.');
  else {
    if (!inUnit(socso.rates?.employer) || !inUnit(socso.rates?.employee))
      errs.push('SOCSO cross-check rates must be between 0 and 1.');
    if (!nonNeg(socso.verifiedUpTo)) errs.push('SOCSO verified-up-to must be ≥ 0.');
    for (const [name, bands] of [
      ['Category 1', socso.category1],
      ['Category 2', socso.category2],
    ] as const) {
      if (!Array.isArray(bands) || bands.length === 0) errs.push(`SOCSO ${name} bands are empty.`);
      else {
        if (!bandsMonotonic(bands)) errs.push(`SOCSO ${name} bands must ascend by upper bound.`);
        if (bands.some((b: ContribBand) => !nonNeg(b.employer) || !nonNeg(b.employee)))
          errs.push(`SOCSO ${name} amounts must be ≥ 0.`);
      }
    }
  }

  const eis = data.eis;
  if (!eis) errs.push('EIS section is missing.');
  else {
    if (!inUnit(eis.rates?.employer) || !inUnit(eis.rates?.employee))
      errs.push('EIS cross-check rates must be between 0 and 1.');
    if (!Array.isArray(eis.bands) || eis.bands.length === 0) errs.push('EIS bands are empty.');
    else {
      if (!bandsMonotonic(eis.bands)) errs.push('EIS bands must ascend by upper bound.');
      if (eis.bands.some((b: ContribBand) => !nonNeg(b.employer) || !nonNeg(b.employee)))
        errs.push('EIS amounts must be ≥ 0.');
    }
  }

  const pcb = data.pcb;
  if (!pcb) errs.push('PCB section is missing.');
  else {
    if (!Array.isArray(pcb.bands) || pcb.bands.length === 0) errs.push('PCB bands are empty.');
    else {
      if (!bandsMonotonic(pcb.bands)) errs.push('PCB bands must ascend by upper bound.');
      pcb.bands.forEach((b: PcbBand, i: number) => {
        if (!nonNeg(b.M)) errs.push(`PCB band ${i + 1}: M must be ≥ 0.`);
        if (!inUnit(b.R)) errs.push(`PCB band ${i + 1}: R (rate) must be between 0 and 1.`);
        if (typeof b.bCat13 !== 'number' || typeof b.bCat2 !== 'number')
          errs.push(`PCB band ${i + 1}: B values must be numbers.`);
      });
    }
    if (pcb.incentive != null) {
      const i = pcb.incentive;
      if (!inUnit(i.rate) || !nonNeg(i.rebateThreshold) || !nonNeg(i.rebateCat13) || !nonNeg(i.rebateCat2))
        errs.push('PCB incentive rate and rebate table must contain valid non-negative numbers.');
    }
    const r = pcb.reliefs;
    if (!r || !nonNeg(r.individual) || !nonNeg(r.spouse) || !nonNeg(r.perChild) || !nonNeg(r.epfReliefCap))
      errs.push('PCB reliefs must all be ≥ 0.');
    // d64d0df4 — the disabled-individual deduction is OPTIONAL (absent ⇒ the built-in fallback in
    // pcbMonth), but any PRESENT value must be a non-negative number. Same treatment as the optional
    // overtime excess multipliers below: absence is fine, a bad value is not.
    else if (r.disabledIndividual != null && !nonNeg(r.disabledIndividual))
      errs.push('PCB disabled-individual relief must be ≥ 0.');
    if (r) {
      try { assertChildQualificationReliefs(r, DEFAULT_MY_STATUTORY.pcb.reliefs.childByCategory); }
      catch { errs.push('pcb_child_relief_configuration_invalid'); }
      if (r.childQualificationWeights && Object.keys(r.childQualificationWeights).some(key => !(CHILD_RELIEF_CATEGORY_KEYS as readonly string[]).includes(key)))
        errs.push('pcb_child_relief_configuration_invalid');
      // d64d0df4 — the disabled-SPOUSE deduction, same optional-with-fallback treatment as above.
      if (r.disabledSpouse != null && !nonNeg(r.disabledSpouse))
        errs.push('PCB disabled-spouse relief must be ≥ 0.');
      // d64d0df4 — the per-category child deduction MAP. The scalar `nonNeg` helpers do not cover a map,
      // so the loop is written out: every value must be a non-negative number, and an UNKNOWN key is
      // REJECTED rather than ignored. A silently-ignored key would let an admin believe they had
      // corrected a figure that the calculation never reads, which is the failure mode this whole item
      // exists to close.
      const byCat = r.childByCategory;
      if (byCat != null) {
        if (typeof byCat !== 'object' || Array.isArray(byCat))
          errs.push('PCB per-category child reliefs must be an object keyed by relief category.');
        else
          for (const [key, amount] of Object.entries(byCat as Record<string, unknown>)) {
            if (!(CHILD_RELIEF_CATEGORY_KEYS as readonly string[]).includes(key))
              errs.push(`PCB per-category child relief: unknown category "${key}".`);
            else if (!nonNeg(amount)) errs.push(`PCB per-category child relief "${key}" must be ≥ 0.`);
          }
      }
    }
  }

  if (!data.ot || !nonNeg(data.ot.wageCeiling)) errs.push('Overtime wage ceiling must be ≥ 0.');
  else {
    // The two excess-hours multipliers are OPTIONAL (missing ⇒ EA fallback in overtimePay). But any PRESENT
    // value must be a finite number > 0 — a 0 or negative multiplier is a data error that would silently
    // zero (or invert) rest-day / holiday overtime pay.
    const posMult = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
    if (data.ot.restDayExcessMultiplier != null && !posMult(data.ot.restDayExcessMultiplier))
      errs.push('Overtime rest-day excess multiplier must be a number greater than 0.');
    if (data.ot.holidayExcessMultiplier != null && !posMult(data.ot.holidayExcessMultiplier))
      errs.push('Overtime public-holiday excess multiplier must be a number greater than 0.');
  }

  return errs;
}

// ───────────────────────────── Read (UI: view + history) ─────────────────────────────

export type StatutoryRulesetRow = {
  id: string;
  version: string;
  effectiveFrom: string;
  data: StatutoryRuleset;
  notes: string | null;
  createdByUserId: string | null;
  createdAt: string;
  archivedAt: string | null;
};

function mapRow(row: typeof statutoryRuleset.$inferSelect): StatutoryRulesetRow {
  return {
    id: row.id,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    data: row.data as StatutoryRuleset,
    notes: row.notes,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

/**
 * The active ruleset for display — delegates to the SAME merged resolution the kernel uses (ADR-0020 §6),
 * so `/payroll/configuration` always reflects what generation will actually apply: built-in default, a
 * vendor pack (with packVersion + issuedAt), or a tenant override.
 */
export async function readActiveStatutoryMY(
  ctx: SessionContext,
  p?: { asOf?: string },
): Promise<{
  ruleset: StatutoryRuleset;
  source: 'default' | 'override' | 'pack';
  row: StatutoryRulesetRow | null;
  packVersion: string | null;
  issuedAt: string | null;
  effectiveFrom: string | null;
  components: Record<StatutoryBody, ComponentProvenance>;
}> {
  const asOf = p?.asOf ?? today();
  return withTenant(ctx, async (tx) => {
    const r = await resolveActiveRulesetMY(tx, asOf);
    return {
      ruleset: r.ruleset,
      source: r.source,
      row: r.overrideRow,
      packVersion: r.packVersion,
      issuedAt: r.issuedAt,
      effectiveFrom: r.effectiveFrom,
      components: r.components,
    };
  });
}

/** All stored versions (incl. archived), newest effective first — the history/audit list. */
export async function listStatutoryRulesetsMY(ctx: SessionContext): Promise<StatutoryRulesetRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(statutoryRuleset)
      .where(eq(statutoryRuleset.country, 'MY'))
      .orderBy(desc(statutoryRuleset.effectiveFrom), desc(statutoryRuleset.createdAt));
    return rows.map(mapRow);
  });
}

// ─────────────────────────── Vendor packs (read: panel + staleness) ───────────────────────────

export type StatutoryPackRow = {
  id: string;
  packVersion: string;
  rulesetVersion: string;
  effectiveFrom: string;
  signedKeyId: string;
  keyRevoked: boolean;
  issuedAt: string;
  validUntil: string;
  ingestedAt: string;
  ingestedSource: string | null;
};

/** Ingested vendor packs (national; readable by all tenants), newest effective first — the pack panel. */
export async function listStatutoryPacksMY(ctx: SessionContext): Promise<StatutoryPackRow[]> {
  return withTenant(ctx, async (tx) => {
    const keys = await tx
      .select({ keyId: statutorySigningKey.keyId, status: statutorySigningKey.status })
      .from(statutorySigningKey);
    const revoked = new Set(keys.filter((k) => k.status === 'revoked').map((k) => k.keyId));
    const rows = await tx
      .select()
      .from(statutoryPack)
      .where(eq(statutoryPack.country, 'MY'))
      .orderBy(desc(statutoryPack.effectiveFrom), desc(statutoryPack.packVersion));
    return rows.map((r) => ({
      id: r.id,
      packVersion: r.packVersion,
      rulesetVersion: r.rulesetVersion,
      effectiveFrom: r.effectiveFrom,
      signedKeyId: r.signedKeyId,
      keyRevoked: revoked.has(r.signedKeyId),
      issuedAt: r.issuedAt.toISOString(),
      validUntil: r.validUntil.toISOString(),
      ingestedAt: r.ingestedAt.toISOString(),
      ingestedSource: r.ingestedSource,
    }));
  });
}

/** Latest ingested packVersion + last sync — the staleness signal (ADR-0020 §8). */
export async function statutorySyncStatusMY(
  ctx: SessionContext,
): Promise<{ latestIngested: string | null; lastSync: { ranAt: string; ingested: number; failed: number; error: string | null } | null }> {
  return withTenant(ctx, async (tx) => {
    const [top] = await tx
      .select({ pv: statutoryPack.packVersion })
      .from(statutoryPack)
      .where(eq(statutoryPack.country, 'MY'))
      .orderBy(desc(statutoryPack.packVersion))
      .limit(1);
    const [log] = await tx.select().from(statutoryPackSyncLog).orderBy(desc(statutoryPackSyncLog.ranAt)).limit(1);
    return {
      latestIngested: top?.pv ?? null,
      lastSync: log ? { ranAt: log.ranAt.toISOString(), ingested: log.ingested, failed: log.failed, error: log.error } : null,
    };
  });
}

// ─────────────────────────────── Write (validated + audited) ───────────────────────────────

export class StatutoryRulesetInvalidError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid statutory ruleset: ${problems.join('; ')}`);
    this.name = 'StatutoryRulesetInvalidError';
  }
}

/** Shallow diff of the figures that realistically change — for the audit payload. */
function changedFields(before: StatutoryRuleset, after: StatutoryRuleset): string[] {
  const changed: string[] = [];
  const scalars: [string, number | undefined, number | undefined][] = [
    ['epf.employeeRate', before.epf?.employeeRate, after.epf?.employeeRate],
    ['epf.employerRateLow', before.epf?.employerRateLow, after.epf?.employerRateLow],
    ['epf.employerRateHigh', before.epf?.employerRateHigh, after.epf?.employerRateHigh],
    ['epf.employerThreshold', before.epf?.employerThreshold, after.epf?.employerThreshold],
    ['contribCeiling', before.contribCeiling, after.contribCeiling],
    ['ot.wageCeiling', before.ot?.wageCeiling, after.ot?.wageCeiling],
    ['ot.restDayExcessMultiplier', before.ot?.restDayExcessMultiplier, after.ot?.restDayExcessMultiplier],
    ['ot.holidayExcessMultiplier', before.ot?.holidayExcessMultiplier, after.ot?.holidayExcessMultiplier],
    ['pcb.reliefs.individual', before.pcb?.reliefs?.individual, after.pcb?.reliefs?.individual],
    ['pcb.reliefs.spouse', before.pcb?.reliefs?.spouse, after.pcb?.reliefs?.spouse],
    ['pcb.reliefs.perChild', before.pcb?.reliefs?.perChild, after.pcb?.reliefs?.perChild],
    ['pcb.reliefs.epfReliefCap', before.pcb?.reliefs?.epfReliefCap, after.pcb?.reliefs?.epfReliefCap],
    // d64d0df4 — a change to the OKU deduction moves the tax of every flagged employee, so it belongs in
    // the audit's changed-field list alongside the other reliefs.
    [
      'pcb.reliefs.disabledIndividual',
      before.pcb?.reliefs?.disabledIndividual,
      after.pcb?.reliefs?.disabledIndividual,
    ],
    // d64d0df4 — same reasoning for the disabled-spouse deduction: it moves the tax of every flagged
    // category-2 employee, so a change to it belongs in the audit's changed-field list.
    ['pcb.reliefs.disabledSpouse', before.pcb?.reliefs?.disabledSpouse, after.pcb?.reliefs?.disabledSpouse],
  ];
  for (const [name, a, b] of scalars) if (a !== b) changed.push(name);
  // EPF Third-Schedule band tables are now admin-editable (feedback 99e13860); surface a table edit in the
  // audit's changed-field list the same way PCB/SOCSO/EIS band edits are surfaced.
  // d64d0df4 — the per-category child relief is a MAP, not a scalar, so it is compared the way the EPF
  // band TABLES below it are. Without this a per-category amount could be corrected (or dropped) without
  // the audit's changed-field list ever mentioning it — the one relief that would be edited silently.
  if (JSON.stringify(before.pcb?.reliefs?.childQualificationWeights) !== JSON.stringify(after.pcb?.reliefs?.childQualificationWeights)) changed.push('pcb.reliefs.childQualificationWeights');
  if (before.pcb?.reliefs?.childQualificationVersion !== after.pcb?.reliefs?.childQualificationVersion) changed.push('pcb.reliefs.childQualificationVersion');
  if (JSON.stringify(before.pcb?.reliefs?.childByCategory) !== JSON.stringify(after.pcb?.reliefs?.childByCategory))
    changed.push('pcb.reliefs.childByCategory');
  if (JSON.stringify(before.epf?.partA) !== JSON.stringify(after.epf?.partA)) changed.push('epf.partA');
  if (JSON.stringify(before.epf?.partE) !== JSON.stringify(after.epf?.partE)) changed.push('epf.partE');
  if (JSON.stringify(before.pcb?.incentive) !== JSON.stringify(after.pcb?.incentive)) changed.push('pcb.incentive');
  if (JSON.stringify(before.pcb?.bands) !== JSON.stringify(after.pcb?.bands)) changed.push('pcb.bands');
  if (JSON.stringify(before.socso?.category1) !== JSON.stringify(after.socso?.category1))
    changed.push('socso.category1');
  if (JSON.stringify(before.socso?.category2) !== JSON.stringify(after.socso?.category2))
    changed.push('socso.category2');
  if (JSON.stringify(before.eis?.bands) !== JSON.stringify(after.eis?.bands)) changed.push('eis.bands');
  return changed;
}

/**
 * Save a new effective-dated ruleset version. Validates first (throws StatutoryRulesetInvalidError on
 * bad input), inserts a NEW row (never mutates an existing version — provenance stays intact), and
 * appends a `statutory.config.updated` event with the before/after + changed-field list. Admin-only
 * (RLS `statutory_ruleset_insert` requires app.is_admin()).
 */
export async function saveStatutoryRulesetMY(
  ctx: SessionContext,
  input: { effectiveFrom: string; version: string; data: StatutoryRuleset; notes?: string | null },
): Promise<{ id: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom))
    throw new StatutoryRulesetInvalidError(['Effective-from must be a YYYY-MM-DD date.']);
  return withTenant(ctx, async (tx) => {
    // Normalize only the new appended record; the resolved before value and stored rows remain untouched.
    const before = await getActiveStatutoryMY(tx, { asOf: input.effectiveFrom });
    let data: StatutoryRuleset;
    try {
      data = { ...input.data, version: input.version, pcb: { ...input.data.pcb, reliefs:
        prepareChildQualificationReliefs(input.data.pcb.reliefs, before.pcb.reliefs, DEFAULT_MY_STATUTORY.pcb.reliefs.childByCategory) } };
    } catch (e) {
      if (e instanceof ChildReliefConfigurationError) throw new StatutoryRulesetInvalidError([e.code]);
      throw new StatutoryRulesetInvalidError(validateStatutoryRuleset(input.data));
    }
    const problems = validateStatutoryRuleset(data);
    if (problems.length) throw new StatutoryRulesetInvalidError(problems);
    const [row] = await tx
      .insert(statutoryRuleset)
      .values({
        tenantId: ctx.tenantId,
        country: 'MY',
        version: input.version,
        effectiveFrom: input.effectiveFrom,
        data,
        notes: input.notes ?? null,
        createdByUserId: ctx.userId ?? null,
      })
      .returning({ id: statutoryRuleset.id });

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'statutory-ruleset',
      aggregateId: row.id,
      eventType: 'statutory.config.updated',
      actor: actorOf(ctx),
      payload: {
        country: 'MY',
        version: input.version,
        effectiveFrom: input.effectiveFrom,
        changed: changedFields(before, data),
        before,
        after: data,
      },
    });
    return { id: row.id };
  });
}

/** Soft-archive a stored version (admin). The active resolution skips archived rows. */
export async function archiveStatutoryRulesetMY(ctx: SessionContext, id: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .update(statutoryRuleset)
      .set({ archivedAt: new Date() })
      .where(and(eq(statutoryRuleset.id, id), isNull(statutoryRuleset.archivedAt)))
      .returning({ id: statutoryRuleset.id, version: statutoryRuleset.version });
    if (!row) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'statutory-ruleset',
      aggregateId: row.id,
      eventType: 'statutory.config.archived',
      actor: actorOf(ctx),
      payload: { country: 'MY', version: row.version },
    });
  });
}

// ─────────────────── Per-body component overrides (ADR-0037, #6) ───────────────────
// A finer-grained override than statutory_ruleset: one row replaces ONE body's slice, effective-dated,
// overlaid on top of the bundled baseline by resolveActiveRulesetMY above. Lets a single body (e.g. a
// mid-year SOCSO revision) move on its own legal timeline without re-issuing the whole ruleset.

export type StatutoryComponentRow = {
  id: string;
  body: StatutoryBody;
  version: string;
  effectiveFrom: string;
  data: unknown;
  notes: string | null;
  createdByUserId: string | null;
  createdAt: string;
  archivedAt: string | null;
};

function mapComponentRow(row: typeof statutoryComponentOverride.$inferSelect): StatutoryComponentRow {
  return {
    id: row.id,
    body: row.body as StatutoryBody,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    data: row.data,
    notes: row.notes,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

/**
 * Validate ONE body's slice. epf/socso/eis/pcb/ot are checked by probing a full ruleset with just this
 * body replaced (the rest stay the verified defaults, so only THIS body's problems surface); hrdf has a
 * dedicated rate check (it isn't part of the legacy ruleset validator).
 */
export function validateStatutoryComponent(body: StatutoryBody, data: unknown): string[] {
  if (data == null || typeof data !== 'object') return [`${body.toUpperCase()} data is missing or malformed.`];
  if (body === 'hrdf') {
    const h = data as { mandatoryRate?: unknown; optionalRate?: unknown };
    const errs: string[] = [];
    if (!inUnit(h.mandatoryRate)) errs.push('HRDF mandatory rate must be between 0 and 1.');
    if (!inUnit(h.optionalRate)) errs.push('HRDF optional rate must be between 0 and 1.');
    return errs;
  }
  const probe = { ...DEFAULT_MY_STATUTORY, [body]: data } as StatutoryRuleset;
  return validateStatutoryRuleset(probe);
}

/** All stored per-body overrides (incl. archived), newest effective first — the history/audit list. */
export async function listComponentOverridesMY(ctx: SessionContext): Promise<StatutoryComponentRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(statutoryComponentOverride)
      .where(eq(statutoryComponentOverride.country, 'MY'))
      .orderBy(desc(statutoryComponentOverride.effectiveFrom), desc(statutoryComponentOverride.createdAt));
    return rows.map(mapComponentRow);
  });
}

/**
 * Save a new effective-dated override for ONE statutory body. Validates the slice first, appends a NEW
 * row (provenance intact), and logs `statutory.component.updated`. Admin-only via RLS.
 */
export async function setComponentOverrideMY(
  ctx: SessionContext,
  input: { body: StatutoryBody; effectiveFrom: string; version: string; data: unknown; notes?: string | null },
): Promise<{ id: string }> {
  if (!STATUTORY_BODIES.includes(input.body))
    throw new StatutoryRulesetInvalidError([`Unknown statutory body: ${String(input.body)}.`]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom))
    throw new StatutoryRulesetInvalidError(['Effective-from must be a YYYY-MM-DD date.']);
  if (typeof input.version !== 'string' || input.version.trim() === '')
    throw new StatutoryRulesetInvalidError(['Version is required.']);
  return withTenant(ctx, async (tx) => {
    let data = input.data;
    if (input.body === 'pcb') {
      const before = await getActiveStatutoryMY(tx, { asOf: input.effectiveFrom });
      const pcb = data as StatutoryRuleset['pcb'];
      try { data = { ...pcb, reliefs: prepareChildQualificationReliefs(pcb.reliefs, before.pcb.reliefs, DEFAULT_MY_STATUTORY.pcb.reliefs.childByCategory) }; }
      catch (e) { if (e instanceof ChildReliefConfigurationError) throw new StatutoryRulesetInvalidError([e.code]); throw new StatutoryRulesetInvalidError(validateStatutoryComponent(input.body, data)); }
    }
    const problems = validateStatutoryComponent(input.body, data);
    if (problems.length) throw new StatutoryRulesetInvalidError(problems);
    const [row] = await tx
      .insert(statutoryComponentOverride)
      .values({
        tenantId: ctx.tenantId,
        country: 'MY',
        body: input.body,
        version: input.version.trim(),
        effectiveFrom: input.effectiveFrom,
        data: data as object,
        notes: input.notes ?? null,
        createdByUserId: ctx.userId ?? null,
      })
      .returning({ id: statutoryComponentOverride.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'statutory-component-override',
      aggregateId: row.id,
      eventType: 'statutory.component.updated',
      actor: actorOf(ctx),
      payload: { country: 'MY', body: input.body, version: input.version, effectiveFrom: input.effectiveFrom, data },
    });
    return { id: row.id };
  });
}

/** Soft-archive a per-body override (admin). The overlay skips archived rows. */
export async function archiveComponentOverrideMY(ctx: SessionContext, id: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .update(statutoryComponentOverride)
      .set({ archivedAt: new Date() })
      .where(and(eq(statutoryComponentOverride.id, id), isNull(statutoryComponentOverride.archivedAt)))
      .returning({
        id: statutoryComponentOverride.id,
        body: statutoryComponentOverride.body,
        version: statutoryComponentOverride.version,
      });
    if (!row) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'statutory-component-override',
      aggregateId: row.id,
      eventType: 'statutory.component.archived',
      actor: actorOf(ctx),
      payload: { country: 'MY', body: row.body, version: row.version },
    });
  });
}

export { DEFAULT_MY_STATUTORY, MY_STATUTORY_VERSION };
