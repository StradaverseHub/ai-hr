/**
 * Configurable Personnel-profile dropdown catalogs (7d309da7) — a generic, tenant-wide option table that
 * backs the six formerly-free-text Profile fields: religion / race / nationality / state / country /
 * relationship (emergency-contact). HR admins add / edit / activate / deactivate / delete options here and
 * the Profile-tab dropdowns read through `listProfileOptions`.
 *
 * DELIBERATELY separate from `core/system-labels.ts` (LABEL_KINDS = department/position/cost_center/
 * business_unit are company-scoped typed tables with a sharing junction) — these are flat tenant-wide lists.
 *
 * LEGACY-VALUE TOLERANCE (the #1 correctness requirement): person columns STAY free-text; there is NO data
 * migration. A value stored on a person that is not (or no longer) in the active catalog is PRESERVED on
 * save — `assertProfileValueAllowed` allow-lists active options but always permits the unchanged legacy
 * value. The catalog only governs what an admin may NEWLY pick.
 *
 * SUBSTRATE: every write appends a DomainEvent (aggregateType 'profile-option'). RLS (0180) is tenant-read /
 * admin-write, so the mutations rely on the DB WITH CHECK app.is_admin() rather than a service-layer role
 * check (mirrors core/claims.ts catalog CRUD). These are tenant-level catalog events with no single employee
 * subject → subjectEmploymentId stays undefined (admin-only reads, fail-closed).
 */
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { employment, person, profileOption } from '../db/schema';
import { MY_STATES } from '../localization/my/holidays';
import { DEPENDENT_RELATIONSHIPS } from './dependents';

export const PROFILE_OPTION_CATEGORIES = [
  'religion',
  'race',
  'nationality',
  'state',
  'country',
  'relationship',
  // Personnel Organisation Assignment standardisation (1001ff61) — the eight flat organisation/job fields
  // stored as free text on `employment` (org_division / org_branch / org_region / org_line / org_section /
  // org_team / org_base + employment_category) are now backed by the profile_option catalog, giving each a
  // centrally-managed dropdown in System Labels > Profile Options WITHOUT new tables. Same flat tenant-wide
  // list + legacy-value tolerance as religion/race. These govern EMPLOYMENT columns (see
  // CATEGORY_EMPLOYMENT_COLUMN), not person columns.
  'division',
  'branch',
  'region',
  'line',
  'section',
  'team',
  'base',
  'category',
] as const;
export type ProfileOptionCategory = (typeof PROFILE_OPTION_CATEGORIES)[number];

// 1001ff61 — the subset of categories whose values live on EMPLOYMENT columns (org assignment), as opposed
// to the person-profile categories above. Drives the employment-side active-value validation in
// core/org.ts::setEmploymentInfo and the employment leg of the delete in-use guard.
export const EMPLOYMENT_PROFILE_CATEGORIES = [
  'division',
  'branch',
  'region',
  'line',
  'section',
  'team',
  'base',
  'category',
] as const satisfies readonly ProfileOptionCategory[];

export function isProfileOptionCategory(v: string): v is ProfileOptionCategory {
  return (PROFILE_OPTION_CATEGORIES as readonly string[]).includes(v);
}

/**
 * The person column(s) each category governs — used by the delete in-use guard (a value still referenced by
 * ANY of the listed columns on a person cannot be deleted). `relationship` maps to the emergency-contact
 * relationship field (product decision (c)). 3a25f5ee — `state` and `country` now govern THREE columns each:
 * the legacy single address plus the new Permanent and Correspondence blocks, so an in-use catalog value in
 * any address block is protected from deletion.
 */
export const CATEGORY_PERSON_COLUMN: Partial<Record<ProfileOptionCategory, (keyof typeof person.$inferSelect)[]>> = {
  religion: ['religion'],
  race: ['race'],
  nationality: ['nationality'],
  state: ['state', 'permanentState', 'correspondenceState'],
  country: ['country', 'permanentCountry', 'correspondenceCountry'],
  relationship: ['emergencyContactRelationship'],
};

/**
 * 1001ff61 — the EMPLOYMENT column(s) each org/job category governs, mirroring CATEGORY_PERSON_COLUMN for the
 * person side. Used by the delete in-use guard (a value still stored on ANY listed employment column cannot
 * be deleted — deactivate instead) so the new org dropdowns keep the same referential-integrity protection
 * the person categories have.
 */
export const CATEGORY_EMPLOYMENT_COLUMN: Partial<Record<ProfileOptionCategory, (keyof typeof employment.$inferSelect)[]>> = {
  division: ['orgDivision'],
  branch: ['orgBranch'],
  region: ['orgRegion'],
  line: ['orgLine'],
  section: ['orgSection'],
  team: ['orgTeam'],
  base: ['orgBase'],
  category: ['employmentCategory'],
};

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// relationship = DEPENDENT_RELATIONSHIPS (minus the trailing catch-all) ∪ common emergency kinds, with a
// single trailing 'Other'. Derived from the enum for provenance without migrating the enum itself.
const RELATIONSHIP_VALUES: string[] = [
  ...DEPENDENT_RELATIONSHIPS.filter((r) => r !== 'other').map(cap), // Spouse, Child, Parent, Sibling
  'Guardian',
  'Friend',
  'Relative',
  'Colleague',
  'Other',
];

const CATEGORY_DEFAULTS: Record<ProfileOptionCategory, string[]> = {
  religion: ['Islam', 'Buddhism', 'Christianity', 'Hinduism', 'Sikhism', 'Taoism', 'None', 'Other'],
  race: ['Malay', 'Chinese', 'Indian', 'Bumiputera Sabah', 'Bumiputera Sarawak', 'Other'],
  // 59047802 — full ISO 3166-1 nationality/demonym set, alphabetically ordered, 'Other' last. ASCII forms
  // (no diacritics) so this list stays BYTE-IDENTICAL across the three seed sites (core, 0180, top-up 0209).
  nationality: [
    'Afghan', 'Albanian', 'Algerian', 'American', 'Andorran', 'Angolan', 'Antiguan and Barbudan', 'Argentine',
    'Armenian', 'Australian', 'Austrian', 'Azerbaijani', 'Bahamian', 'Bahraini', 'Bangladeshi', 'Barbadian',
    'Belarusian', 'Belgian', 'Belizean', 'Beninese', 'Bhutanese', 'Bolivian', 'Bosnian and Herzegovinian',
    'Botswanan', 'Brazilian', 'Bruneian', 'Bulgarian', 'Burkinabe', 'Burmese', 'Burundian', 'Cambodian',
    'Cameroonian', 'Canadian', 'Cape Verdean', 'Central African', 'Chadian', 'Chilean', 'Chinese', 'Colombian',
    'Comoran', 'Congolese (Democratic Republic of the Congo)', 'Congolese (Republic of the Congo)', 'Costa Rican',
    'Croatian', 'Cuban', 'Cypriot', 'Czech', 'Danish', 'Djiboutian', 'Dominican (Commonwealth of Dominica)',
    'Dominican (Dominican Republic)', 'Dutch', 'East Timorese', 'Ecuadorian', 'Egyptian', 'Emirati',
    'Equatorial Guinean', 'Eritrean', 'Estonian', 'Ethiopian', 'Fijian', 'Filipino', 'Finnish', 'French',
    'Gabonese', 'Gambian', 'Georgian', 'German', 'Ghanaian', 'Greek', 'Grenadian', 'Guatemalan',
    'Guinea-Bissauan', 'Guinean', 'Guyanese', 'Haitian', 'Honduran', 'Hungarian', 'Icelandic', 'Indian',
    'Indonesian', 'Iranian', 'Iraqi', 'Irish', 'Israeli', 'Italian', 'Ivorian', 'Jamaican', 'Japanese',
    'Jordanian', 'Kazakhstani', 'Kenyan', 'Kiribati', 'Kittitian and Nevisian', 'Kosovar', 'Kuwaiti',
    'Kyrgyzstani', 'Lao', 'Latvian', 'Lebanese', 'Liberian', 'Libyan', 'Liechtensteiner', 'Lithuanian',
    'Luxembourgish', 'Macedonian', 'Malagasy', 'Malawian', 'Malaysian', 'Maldivian', 'Malian', 'Maltese',
    'Marshallese', 'Mauritanian', 'Mauritian', 'Mexican', 'Micronesian', 'Moldovan', 'Monegasque', 'Mongolian',
    'Montenegrin', 'Moroccan', 'Mosotho', 'Mozambican', 'Namibian', 'Nauruan', 'Nepalese', 'New Zealander',
    'Nicaraguan', 'Nigerian', 'Nigerien', 'North Korean', 'Norwegian', 'Omani', 'Pakistani', 'Palauan',
    'Palestinian', 'Panamanian', 'Papua New Guinean', 'Paraguayan', 'Peruvian', 'Polish', 'Portuguese', 'Qatari',
    'Romanian', 'Russian', 'Rwandan', 'Saint Lucian', 'Salvadoran', 'Samoan', 'San Marinese', 'Sao Tomean',
    'Saudi', 'Senegalese', 'Serbian', 'Seychellois', 'Sierra Leonean', 'Singaporean', 'Slovak', 'Slovenian',
    'Solomon Islander', 'Somali', 'South African', 'South Korean', 'South Sudanese', 'Spanish', 'Sri Lankan',
    'Sudanese', 'Surinamese', 'Swazi', 'Swedish', 'Swiss', 'Syrian', 'Taiwanese', 'Tajikistani', 'Tanzanian',
    'Thai', 'Togolese', 'Tongan', 'Trinidadian and Tobagonian', 'Tunisian', 'Turkish', 'Turkmen', 'Tuvaluan',
    'Ugandan', 'Ukrainian', 'Uruguayan', 'Uzbekistani', 'Vanuatuan', 'Vatican', 'Venezuelan', 'Vietnamese',
    'Vincentian', 'Yemeni', 'Zambian', 'Zimbabwean', 'Other',
  ],
  state: [...MY_STATES],
  country: ['Malaysia', 'Singapore', 'Indonesia', 'Thailand', 'Brunei', 'India', 'Other'],
  relationship: RELATIONSHIP_VALUES,
  // 1001ff61 — the org/job catalogs ship EMPTY: their values are organisation-specific master data HR
  // curates itself in System Labels, and until they do the dropdowns fall back to free-text tolerance (an
  // empty catalog imposes no constraint — see assertProfileValueAllowed). Keeping these empty also leaves
  // DEFAULT_PROFILE_OPTIONS (and its byte-identical 0180 seed block) unchanged, so no seed migration is
  // needed and existing free-text values on employment stay valid.
  division: [],
  branch: [],
  region: [],
  line: [],
  section: [],
  team: [],
  base: [],
  category: [],
};

/**
 * The default catalog, kept BYTE-IDENTICAL with the seed block in 0180_profile_option.sql. `value` doubles
 * as the default `label`. `sortOrder` is the index within its category.
 */
export const DEFAULT_PROFILE_OPTIONS: { category: ProfileOptionCategory; value: string; sortOrder: number }[] =
  PROFILE_OPTION_CATEGORIES.flatMap((category) =>
    CATEGORY_DEFAULTS[category].map((value, i) => ({ category, value, sortOrder: i })),
  );

export type ProfileOptionRow = {
  id: string;
  category: ProfileOptionCategory;
  value: string;
  label: string;
  // dafd475a — optional full descriptive text (standard "Description" column). Null when unset.
  description: string | null;
  sortOrder: number;
  isActive: boolean;
};

/** Thrown when an option cannot be deleted because a person still references its value. */
export class ProfileOptionInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileOptionInUseError';
  }
}

/**
 * List a category's options ordered by sort_order then value. `activeOnly` (the Profile-tab picker) hides
 * deactivated options; the admin screen passes it false to manage the full list.
 */
export function listProfileOptions(
  ctx: SessionContext,
  category: ProfileOptionCategory,
  opts: { activeOnly?: boolean } = {},
): Promise<ProfileOptionRow[]> {
  return withTenant(ctx, async (tx) => {
    const where = opts.activeOnly
      ? and(eq(profileOption.category, category), eq(profileOption.isActive, true))
      : eq(profileOption.category, category);
    const rows = await tx
      .select()
      .from(profileOption)
      .where(where)
      .orderBy(asc(profileOption.sortOrder), asc(profileOption.value));
    return rows.map((r) => ({
      id: r.id,
      category: r.category as ProfileOptionCategory,
      value: r.value,
      label: r.label,
      description: r.description ?? null,
      sortOrder: r.sortOrder,
      isActive: r.isActive,
    }));
  });
}

/** All categories in one round-trip (the admin CRUD page). Keyed by category. */
export async function listAllProfileOptions(
  ctx: SessionContext,
  opts: { activeOnly?: boolean } = {},
): Promise<Record<ProfileOptionCategory, ProfileOptionRow[]>> {
  return withTenant(ctx, async (tx) => {
    const where = opts.activeOnly ? eq(profileOption.isActive, true) : undefined;
    const rows = await tx
      .select()
      .from(profileOption)
      .where(where)
      .orderBy(asc(profileOption.category), asc(profileOption.sortOrder), asc(profileOption.value));
    const out = Object.fromEntries(PROFILE_OPTION_CATEGORIES.map((c) => [c, [] as ProfileOptionRow[]])) as Record<
      ProfileOptionCategory,
      ProfileOptionRow[]
    >;
    for (const r of rows) {
      if (isProfileOptionCategory(r.category)) {
        out[r.category].push({
          id: r.id,
          category: r.category,
          value: r.value,
          label: r.label,
          description: r.description ?? null,
          sortOrder: r.sortOrder,
          isActive: r.isActive,
        });
      }
    }
    return out;
  });
}

/**
 * Seed the default catalog for the current tenant. Idempotent via the (tenant, category, value) unique
 * index — a re-run inserts nothing. Existing tenants are seeded by the migration; this covers new tenants /
 * tests. Appends a single catalog event ONLY when it actually created rows (a no-op re-seed is silent).
 */
export function seedProfileOptions(ctx: SessionContext): Promise<{ total: number; created: number }> {
  return withTenant(ctx, async (tx) => {
    const inserted = await tx
      .insert(profileOption)
      .values(
        DEFAULT_PROFILE_OPTIONS.map((d) => ({
          tenantId: ctx.tenantId,
          category: d.category,
          value: d.value,
          label: d.value,
          sortOrder: d.sortOrder,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: profileOption.id });
    if (inserted.length > 0) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'profile-option',
        aggregateId: ctx.tenantId, // catalog-level op keyed to the tenant
        eventType: 'profile-option.catalog.seeded',
        actor: actorOf(ctx),
        payload: { total: DEFAULT_PROFILE_OPTIONS.length, created: inserted.length },
      });
    }
    return { total: DEFAULT_PROFILE_OPTIONS.length, created: inserted.length };
  });
}

export async function createProfileOption(
  ctx: SessionContext,
  p: { category: string; value: string; label?: string | null; description?: string | null; sortOrder?: number | null },
): Promise<{ id: string }> {
  if (!isProfileOptionCategory(p.category)) throw new Error('Unknown option category');
  const value = p.value.trim();
  if (!value) throw new Error('Value is required');
  const label = (p.label ?? '').trim() || value;
  // dafd475a — optional Description; empty ⇒ null (mirrors the org-label description handling).
  const description = (p.description ?? '').trim() || null;
  const sortOrder = Number.isFinite(p.sortOrder as number) ? Number(p.sortOrder) : 0;
  return withTenant(ctx, async (tx) => {
    const [dupe] = await tx
      .select({ id: profileOption.id })
      .from(profileOption)
      .where(and(eq(profileOption.category, p.category), eq(profileOption.value, value)))
      .limit(1);
    if (dupe) throw new Error(`"${value}" already exists in this list`);
    const [row] = await tx
      .insert(profileOption)
      .values({ tenantId: ctx.tenantId, category: p.category, value, label, description, sortOrder })
      .returning({ id: profileOption.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'profile-option',
      aggregateId: row.id,
      eventType: 'profile-option.created',
      actor: actorOf(ctx),
      payload: { category: p.category, value, label, description, sortOrder },
    });
    return { id: row.id };
  });
}

/**
 * Edit the display label + optional description + sort order. `value` is IMMUTABLE — it is the contract
 * with stored person data. `description` is tri-state: undefined ⇒ leave untouched; a string (incl. '') ⇒
 * set/clear it (blank ⇒ null).
 */
export async function updateProfileOption(
  ctx: SessionContext,
  p: { id: string; label: string; description?: string | null; sortOrder?: number | null },
): Promise<void> {
  const label = p.label.trim();
  if (!label) throw new Error('Label is required');
  const sortOrder = Number.isFinite(p.sortOrder as number) ? Number(p.sortOrder) : 0;
  const set: { label: string; sortOrder: number; description?: string | null } = { label, sortOrder };
  if (p.description !== undefined) set.description = (p.description ?? '').trim() || null;
  await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .update(profileOption)
      .set(set)
      .where(eq(profileOption.id, p.id))
      .returning({ id: profileOption.id });
    if (!row) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'profile-option',
      aggregateId: p.id,
      eventType: 'profile-option.updated',
      actor: actorOf(ctx),
      payload: { label, sortOrder, ...(p.description !== undefined ? { description: set.description } : {}) },
    });
  });
}

/** Activate / deactivate. A deactivated option disappears from the picker but survives on existing records. */
export async function setProfileOptionActive(
  ctx: SessionContext,
  p: { id: string; isActive: boolean },
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .update(profileOption)
      .set({ isActive: p.isActive })
      .where(eq(profileOption.id, p.id))
      .returning({ id: profileOption.id });
    if (!row) return;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'profile-option',
      aggregateId: p.id,
      eventType: p.isActive ? 'profile-option.activated' : 'profile-option.deactivated',
      actor: actorOf(ctx),
    });
  });
}

/**
 * Hard-delete an option — ONLY when no person currently stores its value in the governed column (in-use
 * guard). A referenced option must be Deactivated instead, so a person's data is never orphaned from its
 * catalog entry. (subject to business rules — expected_function §2 "Delete Label".)
 */
export async function deleteProfileOption(ctx: SessionContext, id: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [opt] = await tx
      .select({ id: profileOption.id, category: profileOption.category, value: profileOption.value })
      .from(profileOption)
      .where(eq(profileOption.id, id))
      .limit(1);
    if (!opt) return;
    if (!isProfileOptionCategory(opt.category)) throw new Error('Unknown option category');
    // 3a25f5ee — a category may govern several person columns (state/country each span the legacy + permanent
    // + correspondence address blocks). 1001ff61 — the org/job categories govern EMPLOYMENT columns instead.
    // The value is in use if ANY governed column (on either table) references it.
    const personCols = CATEGORY_PERSON_COLUMN[opt.category] ?? [];
    const empCols = CATEGORY_EMPLOYMENT_COLUMN[opt.category] ?? [];
    let usedCount = 0;
    if (personCols.length > 0) {
      const [u] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(person)
        .where(or(...personCols.map((c) => eq(person[c] as never, opt.value))));
      usedCount += Number(u?.n ?? 0);
    }
    if (empCols.length > 0) {
      const [u] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(employment)
        .where(or(...empCols.map((c) => eq(employment[c] as never, opt.value))));
      usedCount += Number(u?.n ?? 0);
    }
    if (usedCount > 0) {
      throw new ProfileOptionInUseError('This value is in use by an employee and cannot be deleted — deactivate it instead.');
    }
    await tx.delete(profileOption).where(eq(profileOption.id, id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'profile-option',
      aggregateId: id,
      eventType: 'profile-option.deleted',
      actor: actorOf(ctx),
      payload: { category: opt.category, value: opt.value },
    });
  });
}

/**
 * Server-side validation for a person-profile save: the new value must be an ACTIVE catalog option — UNLESS
 * it equals the legacy value already stored (legacy-value tolerance: re-saving the profile must never blank
 * an out-of-catalog value). A null/empty new value (clearing the field) is always allowed. Runs inside the
 * caller's tx so it participates in the same RLS session (used by core/org.ts::updatePerson).
 */
export async function assertProfileValueAllowed(
  tx: Tx,
  category: ProfileOptionCategory,
  newValue: string | null,
  legacyValue: string | null,
): Promise<void> {
  if (newValue == null || newValue === '') return; // clearing is always allowed
  if (newValue === legacyValue) return; // unchanged legacy value is permitted (tolerance)
  const active = await tx
    .select({ value: profileOption.value })
    .from(profileOption)
    .where(and(eq(profileOption.category, category), eq(profileOption.isActive, true)));
  // BACKWARD-COMPAT: a tenant whose catalog for this category is empty (never seeded) keeps today's exact
  // free-text behaviour — the dropdown only constrains input once the tenant actually has options.
  if (active.length === 0) return;
  if (active.some((o) => o.value === newValue)) return;
  throw new Error(`"${newValue}" is not an active ${category} option`);
}
