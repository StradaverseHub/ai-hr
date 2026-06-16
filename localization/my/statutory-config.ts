/**
 * Malaysian statutory ruleset — loader + management service (ADR-0019).
 *
 * The verified figures live as code in statutory-tables.ts (DEFAULT_MY_STATUTORY). This module lets
 * an admin VIEW the active set and OVERRIDE it with an effective-dated, validated, audited version
 * stored in `statutory_ruleset` (tenant-scoped, RLS). The code default is the authoritative floor:
 * an empty table ⇒ exactly the built-in behaviour. Past payslips snapshot their own figures, so an
 * edit only ever affects future runs.
 */
import { and, desc, eq, isNull, lte } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { statutoryPack, statutoryPackSyncLog, statutoryRuleset, statutorySigningKey } from '../../db/schema';
import {
  DEFAULT_MY_STATUTORY,
  MY_STATUTORY_VERSION,
  type ContribBand,
  type PcbBand,
  type StatutoryRuleset,
} from './statutory-tables';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─────────────────────────────── Loader (kernel) — 3-tier merge ───────────────────────────────

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
};

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

  type Cand = { effFrom: string; issuanceMs: number; rank: number; packVersion: string; id: string; res: ActiveResolution };
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

  if (cands.length === 0) {
    return {
      ruleset: DEFAULT_MY_STATUTORY,
      source: 'default',
      effectiveFrom: null,
      version: DEFAULT_MY_STATUTORY.version,
      packVersion: null,
      issuedAt: null,
      signedKeyId: null,
      overrideRow: null,
    };
  }
  cands.sort(
    (a, b) =>
      b.effFrom.localeCompare(a.effFrom) ||
      b.issuanceMs - a.issuanceMs ||
      b.rank - a.rank ||
      b.packVersion.localeCompare(a.packVersion) ||
      b.id.localeCompare(a.id),
  );
  return cands[0].res;
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
    const r = pcb.reliefs;
    if (!r || !nonNeg(r.individual) || !nonNeg(r.spouse) || !nonNeg(r.perChild) || !nonNeg(r.epfReliefCap))
      errs.push('PCB reliefs must all be ≥ 0.');
  }

  if (!data.ot || !nonNeg(data.ot.wageCeiling)) errs.push('Overtime wage ceiling must be ≥ 0.');

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
    ['pcb.reliefs.individual', before.pcb?.reliefs?.individual, after.pcb?.reliefs?.individual],
    ['pcb.reliefs.spouse', before.pcb?.reliefs?.spouse, after.pcb?.reliefs?.spouse],
    ['pcb.reliefs.perChild', before.pcb?.reliefs?.perChild, after.pcb?.reliefs?.perChild],
    ['pcb.reliefs.epfReliefCap', before.pcb?.reliefs?.epfReliefCap, after.pcb?.reliefs?.epfReliefCap],
  ];
  for (const [name, a, b] of scalars) if (a !== b) changed.push(name);
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
  const data: StatutoryRuleset = { ...input.data, version: input.version };
  const problems = validateStatutoryRuleset(data);
  if (problems.length) throw new StatutoryRulesetInvalidError(problems);

  return withTenant(ctx, async (tx) => {
    // The ruleset that was active on the new effective date — the audit "before".
    const before = await getActiveStatutoryMY(tx, { asOf: input.effectiveFrom });
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

export { DEFAULT_MY_STATUTORY, MY_STATUTORY_VERSION };
