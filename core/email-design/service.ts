/** Email design settings are tenant-wide. Live database grants, never the browser, own admission. */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant, type SessionContext } from '../../db/client';
import { emailDocument, emailKind, emailLocale, type EmailDocument, type EmailKind, type EmailLocale } from '../../lib/email-design/model';
import { validateEmailAsset } from '../../lib/email-design/assets';
export type EmailDesignRow = {
    kind: EmailKind;
    locale: EmailLocale;
    revision: number;
    document: EmailDocument | null;
    updatedAt: string;
    updatedBy: string | null;
};
export async function listEmailDesigns(ctx: SessionContext): Promise<EmailDesignRow[]> {
    return withTenant(ctx, async (tx) => {
        const [access] = await tx.execute<{
            allowed: boolean;
        }>(sql `select app.is_group_admin() as allowed`);
        if (!access?.allowed)
            throw Error('Email design permission required.');
        const rows = await tx.execute<{
            kind: string;
            locale: string;
            revision: number;
            document: unknown;
            updated_at: Date;
            updated_by: string | null;
        }>(sql `select kind,locale,revision,document,updated_at,updated_by from email_design order by kind,locale`);
        return rows.map(row => ({ kind: emailKind.parse(row.kind), locale: emailLocale.parse(row.locale), revision: row.revision, document: row.document === null ? null : emailDocument.parse(row.document), updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by }));
    });
}
export async function saveEmailDesign(ctx: SessionContext, kind: EmailKind, locale: EmailLocale, document: unknown | null, expectedRevision: number) {
    emailKind.parse(kind);
    emailLocale.parse(locale);
    z.number().int().min(0).parse(expectedRevision);
    const parsed = document === null ? null : emailDocument.parse(document);
    if (parsed && parsed.kind !== kind)
        throw Error('Wrong email kind.');
    return withTenant(ctx, async (tx) => { const [row] = await tx.execute<{
        revision: number;
    }>(sql `select app.email_design_save(${kind},${locale},${parsed ? JSON.stringify(parsed) : null}::jsonb,${expectedRevision}) as revision`); return row.revision; });
}
export async function emailDesignHistory(ctx: SessionContext, kind: EmailKind, locale: EmailLocale) {
    emailKind.parse(kind);
    emailLocale.parse(locale);
    return withTenant(ctx, async (tx) => {
        const rows = await tx.execute<{
            revision: number;
            document: unknown;
            created_at: Date;
            created_by: string | null;
        }>(sql `select revision,document,created_at,created_by from email_design_version where kind=${kind} and locale=${locale} order by revision desc limit 100`);
        return rows.map(row => ({ revision: row.revision, document: row.document === null ? null : emailDocument.parse(row.document), createdAt: new Date(row.created_at).toISOString(), createdBy: row.created_by }));
    });
}
export async function uploadEmailAsset(ctx: SessionContext, mime: string, bytes: Uint8Array) {
    await validateEmailAsset(bytes, mime);
    return withTenant(ctx, async (tx) => {
        const [row] = await tx.execute<{
            token: string;
        }>(sql `select app.email_asset_save(${mime},${Buffer.from(bytes)}) as token`);
        return z.string().regex(/^[a-f0-9]{64}$/).parse(row.token);
    });
}
