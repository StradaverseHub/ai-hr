/** Closed email document contract shared by the editor, previews and isolated delivery processes. */
import { z } from 'zod';
import { notificationEmailCategories, notificationEmailLocales } from '../notification-email-model';
export const emailKinds = ['invitation', 'recovery', ...notificationEmailCategories.map(value => `workflow.${value}` as const), 'attendance_cc', 'assessment_reminder', 'employee_master_report'] as const;
export const emailKind = z.enum(emailKinds);
export type EmailKind = z.infer<typeof emailKind>;
export const emailLocale = z.enum(notificationEmailLocales);
export type EmailLocale = z.infer<typeof emailLocale>;
export const secureEmailUrl = z.url().max(2000).refine(value => { try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password;
}
catch {
    return false;
} }, 'Use an HTTPS link.');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const blockStyle = z.object({ background: color.optional(), color: color.optional(), font: z.enum(['Arial', 'Georgia', 'Verdana', 'Tahoma', 'Trebuchet MS']).optional(), size: z.number().int().min(10).max(48).optional(), align: z.enum(['left', 'center', 'right']).optional(), padding: z.number().int().min(0).max(64).optional() }).strict();
const base = { id: z.uuid(), style: blockStyle };
const plain = z.string().max(10000);
const run = z.object({ text: plain, bold: z.boolean().optional(), italic: z.boolean().optional(), href: secureEmailUrl.optional() }).strict();
const column = z.object({ heading: z.string().max(200), text: plain }).strict();
export const emailBlock = z.discriminatedUnion('type', [
    z.object({ ...base, type: z.literal('header'), label: z.string().max(200), src: secureEmailUrl.optional() }).strict(),
    z.object({ ...base, type: z.literal('banner'), src: secureEmailUrl, alt: z.string().max(300) }).strict(),
    z.object({ ...base, type: z.literal('text'), heading: z.string().max(200), runs: z.array(run).min(1).max(100) }).strict(),
    z.object({ ...base, type: z.literal('image'), src: secureEmailUrl, alt: z.string().max(300) }).strict(),
    z.object({ ...base, type: z.literal('button'), label: z.string().min(1).max(200), href: secureEmailUrl }).strict(),
    z.object({ ...base, type: z.literal('columns'), columns: z.tuple([column, column]) }).strict(),
    z.object({ ...base, type: z.literal('divider') }).strict(),
    z.object({ ...base, type: z.literal('spacer'), height: z.number().int().min(4).max(100) }).strict(),
    z.object({ ...base, type: z.literal('social'), links: z.array(z.object({ label: z.string().min(1).max(100), href: secureEmailUrl }).strict()).max(8) }).strict(),
    z.object({ ...base, type: z.literal('footer'), text: plain }).strict(),
    // Wording, links, expiry and recipients never enter the administrator's document.
    z.object({ id: z.uuid(), type: z.literal('system'), style: z.object({ background: color.optional(), color: color.optional() }).strict() }).strict(),
]);
export type EmailBlock = z.infer<typeof emailBlock>;
export const emailDocument = z.object({ version: z.literal(1), kind: emailKind, subject: z.string().max(200).regex(/^[^\r\n]*$/), background: color, blocks: z.array(emailBlock).min(1).max(80) }).strict().superRefine((doc, ctx) => {
    if (doc.blocks.filter(block => block.type === 'system').length !== 1)
        ctx.addIssue({ code: 'custom', message: 'Keep exactly one AIHR block.' });
    if (new Set(doc.blocks.map(block => block.id)).size !== doc.blocks.length)
        ctx.addIssue({ code: 'custom', message: 'Block identifiers must be unique.' });
    const allowed = new Set(emailPlaceholders(doc.kind));
    const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
    for (const value of strings({ subject: doc.subject, blocks: doc.blocks }))
        for (const match of value.matchAll(/\{([a-z_]+)\}/g))
            if (!allowed.has(match[1]))
                ctx.addIssue({ code: 'custom', message: `Detail ${match[1]} is not available for this email.` });
    if (JSON.stringify(doc).length > 100000)
        ctx.addIssue({ code: 'custom', message: 'Design is too large.' });
});
export type EmailDocument = z.infer<typeof emailDocument>;
export function emailPlaceholders(kind: EmailKind): string[] { return ['first_name', 'company_name', ...(kind === 'invitation' ? ['organization_code', 'expiry_days'] : kind === 'recovery' ? ['expiry_minutes'] : kind === 'assessment_reminder' ? ['count', 'cycle', 'things'] : kind.startsWith('workflow.') ? ['category'] : [])]; }
export function defaultEmailDocument(kind: EmailKind): EmailDocument { return { version: 1, kind, subject: '', background: '#f5f5f5', blocks: [{ id: '00000000-0000-4000-8000-000000000001', type: 'header', label: 'AIHR', style: { background: '#222244', color: '#ffffff', padding: 24 } }, { id: '00000000-0000-4000-8000-000000000002', type: 'system', style: { background: '#ffffff', color: '#202020' } }] }; }
const detailData = z.object({ first_name: z.string().max(200).optional(), company_name: z.string().max(500).optional(), organization_code: z.string().max(100).optional(), expiry_days: z.string().max(10).optional(), expiry_minutes: z.string().max(10).optional(), count: z.string().max(20).optional(), things: z.string().max(100).optional(), cycle: z.string().max(300).optional(), category: z.string().max(100).optional() }).strict();
export type EmailDesignEnvelope = {
    document: EmailDocument | null;
    kind: EmailKind;
    locale: EmailLocale;
    data?: z.infer<typeof detailData>;
};
export const emailDesignEnvelope = z.object({ document: emailDocument.nullable(), kind: emailKind, locale: emailLocale, data: detailData.optional() }).strict().refine(value => !value.document || value.document.kind === value.kind);
