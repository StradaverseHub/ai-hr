'use server';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { jobErrorGuidance } from './error-guidance';
import { requireAdmin } from '@/lib/authz';
import { saveJobDraft, transitionJob, configureJobForm, attachJobDocument, removeJobAttachment, type JobInput, type FormDefinition } from '@/packs/job-descriptions/service';
const BASE = '/admin/job-descriptions';
export type SaveState = {
    error: string;
};
const text = (fd: FormData, key: string) => String(fd.get(key) ?? '');
const failure=async(e:unknown)=>jobErrorGuidance(e,await getTranslations('jobDescriptions'));
export async function saveDraftAction(_state: SaveState, fd: FormData): Promise<SaveState> {
    const s = await requireAdmin();
    let id: string;
    try {
        const raw = text(fd, 'payload');
        if (raw.length > 800000)
            throw new Error('Document is too large');
        const input = JSON.parse(raw) as JobInput;
        const jobId = text(fd, 'jobId');
        const saved = await saveJobDraft(s, input, jobId ? { jobId, revisionId: text(fd, 'revisionId'), lockVersion: Number(text(fd, 'lockVersion')) } : undefined);
        id = saved.jobId;
    }
    catch (e) {
        return { error: await failure(e) };
    }
    redirect(`${BASE}/${id}?saved=1`);
}
export async function transitionAction(fd: FormData) { const s = await requireAdmin(); const id = text(fd, 'jobId'); const action = text(fd, 'transition'); if (!['submit', 'review', 'return', 'approve', 'revise', 'inactivate', 'reactivate', 'delete', 'acknowledge'].includes(action))
    return; let error = ''; try {
    if (action === 'delete' && text(fd, 'confirm') !== 'yes')
        throw new Error('Confirm draft deletion');
    await transitionJob(s, { jobId: id, revisionId: text(fd, 'revisionId'), lockVersion: Number(text(fd, 'lockVersion')), action: action as Parameters<typeof transitionJob>[1]['action'], comments: text(fd, 'comments'), receiptOn:text(fd,'receiptOn') });
}
catch (e) {
    error = await failure(e);
} redirect(error ? `${BASE}/${encodeURIComponent(id)}?error=${encodeURIComponent(error)}` : action === 'delete' ? BASE : `${BASE}/${id}?saved=1`); }
export async function configureAction(_state: SaveState, fd: FormData): Promise<SaveState> { const s = await requireAdmin(); const companyId = text(fd, 'companyId'); try {
    const raw = text(fd, 'definition');
    if (raw.length > 150000)
        throw new Error('Form is too large');
    await configureJobForm(s, companyId, Number(text(fd, 'expectedVersion')), JSON.parse(raw) as FormDefinition);
}
catch (e) {
    return { error: await failure(e) };
} redirect(`${BASE}/configuration?company=${companyId}&saved=1`); }
export async function uploadAction(fd: FormData) { const s = await requireAdmin(); const id = text(fd, 'jobId'); let error = ''; try {
    const file = fd.get('attachment');
    if (!(file instanceof File) || file.size > 2097152)
        throw new Error('Choose a file up to 2 MB');
    await attachJobDocument(s, { jobId: id, revisionId: text(fd, 'revisionId'), lockVersion: Number(text(fd, 'lockVersion')), name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
}
catch (e) {
    error = await failure(e);
} redirect(`${BASE}/${encodeURIComponent(id)}?${error ? `error=${encodeURIComponent(error)}` : 'saved=1'}`); }
export async function removeAttachmentAction(fd: FormData) { const s = await requireAdmin(); const id = text(fd, 'jobId'); let error = ''; try {
    await removeJobAttachment(s, { jobId: id, revisionId: text(fd, 'revisionId'), lockVersion: Number(text(fd, 'lockVersion')), attachmentId: text(fd, 'attachmentId') });
}
catch (e) {
    error = await failure(e);
} redirect(`${BASE}/${encodeURIComponent(id)}?${error ? `error=${encodeURIComponent(error)}` : 'saved=1'}`); }
