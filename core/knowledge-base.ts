/**
 * Knowledge Base (ADR-0017). A tenant-shared document repository: Markdown articles authored in-app
 * and uploaded binary files, in one `kb_document` table. RLS makes reads tenant-wide and writes
 * author-or-admin scoped; this service adds the domain events and the shape/size guards.
 *
 * `content` (the file bytes) is selected ONLY by `getDownload` — never in list/detail reads, so the
 * library and viewer stay light.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { kbDocument } from '../db/schema';

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB (ADR-0017 — Postgres bytea storage)

export type KbAudience = 'all' | 'employee' | 'manager' | 'hr_admin';
const AUDIENCES: KbAudience[] = ['all', 'employee', 'manager', 'hr_admin'];
const cleanAudience = (v: unknown): KbAudience =>
  AUDIENCES.includes(v as KbAudience) ? (v as KbAudience) : 'all';

// Audience is a clearance ladder, not a tag: a document is visible to a viewer whose role rank is at
// least the document's. RLS is tenant-wide for reads (guides are shared), so this audience gate is what
// stops an employee seeing — or deep-linking — a manager/HR-only guide (consultant feedback R34).
const AUDIENCE_RANK: Record<KbAudience, number> = { all: 0, employee: 1, manager: 2, hr_admin: 3 };
function viewerRank(ctx: SessionContext): number {
  const roles = ctx.roles ?? [];
  if (roles.some((r) => r === 'hr_admin' || r === 'super_admin')) return 3;
  if (roles.includes('manager')) return 2;
  return 1; // any authenticated employee sees 'all' + 'employee'
}
/** The audiences a viewer is cleared to see (their rank and below). */
export function visibleAudiencesFor(ctx: SessionContext): KbAudience[] {
  const rank = viewerRank(ctx);
  return AUDIENCES.filter((a) => AUDIENCE_RANK[a] <= rank);
}
const canSeeAudience = (ctx: SessionContext, a: KbAudience): boolean => AUDIENCE_RANK[a] <= viewerRank(ctx);
const cleanCategory = (v: unknown): string => {
  const s = String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'general';
};
const cleanTitle = (v: unknown): string => {
  const s = String(v ?? '').trim();
  if (!s) throw new Error('A title is required.');
  return s.slice(0, 200);
};

type I18nMap = Record<string, { title: string; body: string }> | null;

/** Resolve a document's title/body for the active locale, falling back to the base (English) columns. */
function localize(
  row: { title: string; body?: string | null; i18n?: I18nMap },
  locale?: string,
): { title: string; body: string | null } {
  const tr = locale && locale !== 'en' ? row.i18n?.[locale] : undefined;
  return { title: tr?.title ?? row.title, body: tr?.body ?? row.body ?? null };
}

// ─────────────────────────────── Reads ───────────────────────────────

/** Library listing — metadata only (no body, no bytes). Title resolves to the active locale (via a
 *  JSON path so we never pull the full translations blob into a list). RLS trims to the tenant. */
export function listDocuments(
  ctx: SessionContext,
  opts: {
    category?: string;
    audience?: KbAudience;
    includeArchived?: boolean;
    search?: string;
    locale?: string;
  } = {},
) {
  const localizedTitle =
    opts.locale && opts.locale !== 'en'
      ? sql<string | null>`${kbDocument.i18n} -> ${opts.locale} ->> 'title'`
      : sql<string | null>`null`;
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: kbDocument.id,
        kind: kbDocument.kind,
        title: kbDocument.title,
        localizedTitle,
        slug: kbDocument.slug,
        category: kbDocument.category,
        audience: kbDocument.audience,
        isSystem: kbDocument.isSystem,
        fileName: kbDocument.fileName,
        mimeType: kbDocument.mimeType,
        sizeBytes: kbDocument.sizeBytes,
        createdByUserId: kbDocument.createdByUserId,
        archivedAt: kbDocument.archivedAt,
        updatedAt: kbDocument.updatedAt,
      })
      .from(kbDocument)
      .where(
        and(
          // Viewer clearance — always applied, independent of the UI filter below (R34).
          inArray(kbDocument.audience, visibleAudiencesFor(ctx)),
          opts.includeArchived ? undefined : isNull(kbDocument.archivedAt),
          opts.category ? eq(kbDocument.category, opts.category) : undefined,
          opts.audience && opts.audience !== 'all' ? eq(kbDocument.audience, opts.audience) : undefined,
          opts.search ? sql`${kbDocument.title} ilike ${'%' + opts.search + '%'}` : undefined,
        ),
      )
      .orderBy(asc(kbDocument.category), asc(kbDocument.title));
    return rows.map(({ localizedTitle: lt, ...d }) => ({ ...d, title: lt ?? d.title }));
  });
}

/** One document for viewing — title + article body resolved to `locale` (English fallback). No bytes. */
export function getDocument(ctx: SessionContext, id: string, locale?: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: kbDocument.id,
        kind: kbDocument.kind,
        title: kbDocument.title,
        slug: kbDocument.slug,
        category: kbDocument.category,
        audience: kbDocument.audience,
        isSystem: kbDocument.isSystem,
        body: kbDocument.body,
        i18n: kbDocument.i18n,
        fileName: kbDocument.fileName,
        mimeType: kbDocument.mimeType,
        sizeBytes: kbDocument.sizeBytes,
        createdByUserId: kbDocument.createdByUserId,
        archivedAt: kbDocument.archivedAt,
        createdAt: kbDocument.createdAt,
        updatedAt: kbDocument.updatedAt,
      })
      .from(kbDocument)
      .where(eq(kbDocument.id, id))
      .limit(1);
    if (!row) return null;
    if (!canSeeAudience(ctx, row.audience as KbAudience)) return null; // deep-link guard (R34)
    const { i18n, ...rest } = row;
    const { title, body } = localize(row, locale);
    // title/body are localized for DISPLAY; sourceTitle/sourceBody are the English source the inline
    // editor writes (so editing a guide while viewing a translation never clobbers the source).
    return {
      ...rest,
      title,
      body,
      sourceTitle: row.title,
      sourceBody: row.body ?? '',
      hasTranslations: !!i18n && Object.keys(i18n).length > 0,
    };
  });
}

/** The download payload — the ONLY read that selects the file bytes. Article title/body resolve to
 *  `locale` (English fallback). RLS still applies (tenant member). */
export function getDownload(ctx: SessionContext, id: string, locale?: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        kind: kbDocument.kind,
        title: kbDocument.title,
        body: kbDocument.body,
        i18n: kbDocument.i18n,
        audience: kbDocument.audience,
        fileName: kbDocument.fileName,
        mimeType: kbDocument.mimeType,
        content: kbDocument.content,
      })
      .from(kbDocument)
      .where(eq(kbDocument.id, id))
      .limit(1);
    if (!row) return null;
    if (!canSeeAudience(ctx, row.audience as KbAudience)) return null; // deep-link guard (R34)
    const { title, body } = localize(row, locale);
    return { kind: row.kind, title, body, fileName: row.fileName, mimeType: row.mimeType, content: row.content };
  });
}

/** Whether the caller may edit/delete a given document (mirrors the RLS write policy, for the UI). */
export function canManage(
  ctx: SessionContext,
  doc: { isSystem: boolean; createdByUserId: string | null },
): boolean {
  const admin = (ctx.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');
  if (admin) return true;
  return !doc.isSystem && !!ctx.userId && doc.createdByUserId === ctx.userId;
}

// ─────────────────────────────── Writes ───────────────────────────────

async function logEvent(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  ctx: SessionContext,
  id: string,
  eventType: string,
  payload: unknown,
) {
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'kb-document',
    aggregateId: id,
    eventType,
    actor: actorOf(ctx),
    // KB documents are org-level content, not employee-scoped PII → no subject (admin-only in audit).
    subjectEmploymentId: null,
    payload,
  });
}

/** Author a new Markdown article. */
export async function createArticle(
  ctx: SessionContext,
  p: { title: string; body: string; category?: string; audience?: KbAudience },
) {
  const title = cleanTitle(p.title);
  const body = String(p.body ?? '');
  if (!body.trim()) throw new Error('The article body is empty.');
  const category = cleanCategory(p.category);
  const audience = cleanAudience(p.audience);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(kbDocument)
      .values({
        tenantId: ctx.tenantId,
        kind: 'article',
        title,
        body,
        category,
        audience,
        createdByUserId: ctx.userId ?? null,
        updatedByUserId: ctx.userId ?? null,
      })
      .returning({ id: kbDocument.id });
    await logEvent(tx, ctx, row.id, 'kb.document.created', { kind: 'article', title, category, audience });
    return { id: row.id };
  });
}

/** Edit an article (and/or its metadata). RLS confines it to admins + the author of a non-system doc. */
export async function updateDocument(
  ctx: SessionContext,
  p: { id: string; title?: string; body?: string; category?: string; audience?: KbAudience },
) {
  return withTenant(ctx, async (tx) => {
    const set: Record<string, unknown> = { updatedAt: sql`now()`, updatedByUserId: ctx.userId ?? null };
    if (p.title !== undefined) set.title = cleanTitle(p.title);
    if (p.category !== undefined) set.category = cleanCategory(p.category);
    if (p.audience !== undefined) set.audience = cleanAudience(p.audience);
    if (p.body !== undefined) {
      if (!String(p.body).trim()) throw new Error('The article body is empty.');
      set.body = String(p.body);
    }
    const updated = await tx
      .update(kbDocument)
      .set(set)
      .where(eq(kbDocument.id, p.id))
      .returning({ id: kbDocument.id, kind: kbDocument.kind });
    if (updated.length === 0) throw new Error('Document not found, or you cannot edit it.');
    await logEvent(tx, ctx, p.id, 'kb.document.updated', { fields: Object.keys(set).filter((k) => k !== 'updatedAt' && k !== 'updatedByUserId') });
    return { id: p.id };
  });
}

/** Store an uploaded file (bytes in Postgres). Size + shape are guarded here and by the table CHECK. */
export async function uploadDocument(
  ctx: SessionContext,
  p: {
    title?: string;
    fileName: string;
    mimeType: string;
    content: Buffer;
    category?: string;
    audience?: KbAudience;
  },
) {
  const fileName = String(p.fileName ?? '').trim();
  if (!fileName) throw new Error('A file is required.');
  if (!p.content || p.content.length === 0) throw new Error('The uploaded file is empty.');
  if (p.content.length > MAX_FILE_BYTES) {
    throw new Error(`File is too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB).`);
  }
  const title = cleanTitle(p.title || fileName);
  const category = cleanCategory(p.category);
  const audience = cleanAudience(p.audience);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(kbDocument)
      .values({
        tenantId: ctx.tenantId,
        kind: 'file',
        title,
        category,
        audience,
        fileName,
        mimeType: p.mimeType || 'application/octet-stream',
        sizeBytes: p.content.length,
        content: p.content,
        createdByUserId: ctx.userId ?? null,
        updatedByUserId: ctx.userId ?? null,
      })
      .returning({ id: kbDocument.id });
    await logEvent(tx, ctx, row.id, 'kb.document.uploaded', {
      fileName,
      mimeType: p.mimeType,
      sizeBytes: p.content.length,
      category,
      audience,
    });
    return { id: row.id };
  });
}

/** Soft-archive (hide) a document. */
export async function archiveDocument(ctx: SessionContext, id: string) {
  return withTenant(ctx, async (tx) => {
    const updated = await tx
      .update(kbDocument)
      .set({ archivedAt: sql`now()`, updatedAt: sql`now()`, updatedByUserId: ctx.userId ?? null })
      .where(and(eq(kbDocument.id, id), isNull(kbDocument.archivedAt)))
      .returning({ id: kbDocument.id });
    if (updated.length === 0) throw new Error('Document not found, or you cannot archive it.');
    await logEvent(tx, ctx, id, 'kb.document.archived', {});
    return { id };
  });
}

/** Restore an archived document. */
export async function restoreDocument(ctx: SessionContext, id: string) {
  return withTenant(ctx, async (tx) => {
    const updated = await tx
      .update(kbDocument)
      .set({ archivedAt: null, updatedAt: sql`now()`, updatedByUserId: ctx.userId ?? null })
      .where(eq(kbDocument.id, id))
      .returning({ id: kbDocument.id });
    if (updated.length === 0) throw new Error('Document not found, or you cannot restore it.');
    await logEvent(tx, ctx, id, 'kb.document.restored', {});
    return { id };
  });
}
