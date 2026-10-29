'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {ownClaimSubject,claimFormSelector} from './subject';
import { cancelClaim, deleteClaimDraft, saveClaimDraft, submitClaimWithAttachment, submitDraftClaims } from '@/packs/claims/service';

const BASE = '/claims';
const returnUrl=(selector:string|string[]|undefined,fields:Record<string,string>)=>BASE+'?'+new URLSearchParams({...fields,...(selector!==undefined?{employmentId:typeof selector==='string'?selector:''}:{})});
const errorUrl = (e: unknown,selector?:string|string[]) => returnUrl(selector,{error:publicErrorMessage(e)});
async function actionSubject(s:Parameters<typeof ownClaimSubject>[0],selector:string|string[]|undefined){
 const own=await ownClaimSubject(s,selector);
 if(!own)throw new Error('No active employment is linked to your account.');
 return own;
}

/**
 * Derive a TRUSTWORTHY mime type from the file's leading bytes (fail-closed: unknown signature → null).
 * This replaces the spoofable client `file.type` (and its blank-type false-reject), so the service-layer
 * MIME allowlist is checked against what the file actually is, not what the browser claimed.
 */
function sniffMime(bytes: Buffer): string | null {
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === '%PDF') return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

const numOrNull = (v: FormDataEntryValue | null): number | null => {
  const str = String(v ?? '').trim();
  return str === '' ? null : Number(str);
};

export type SubmitClaimState = { error: string | null };

/**
 * useActionState-driven: on FAILURE we return { error } instead of redirecting, so the form is never
 * unmounted/navigated away from and every field the user typed (including the file input's selection)
 * survives exactly as-is — the user just fixes the one field the error names and resubmits. On SUCCESS
 * we still redirect (a fresh claims list + an empty form is the correct outcome there). All DB work
 * happens in ONE service tx (submitClaimWithAttachment) so a receipt failure rolls the claim back too:
 * the user's error and the DB now agree — no committed-claim-behind-an-error (ADR-0021 §2 submit fix).
 */
export async function submitClaimAction(_prevState: SubmitClaimState, formData: FormData): Promise<SubmitClaimState> {
  const s = await getSession();
  // e7eb5d83 — ONE form, two buttons. The submit BUTTON carries name="intent" value="draft", and a
  // submitter's name/value is part of the FormData the browser posts, so the two paths need no second
  // form and no duplicated fields. `draftId` is present only when the employee is editing an existing
  // draft (?draft=<id> on the page), which is what turns Save into an update rather than a new row.
  const intent = String(formData.get('intent') ?? '');
  const draftId = String(formData.get('draftId') ?? '').trim() || undefined;
  let toast = 'Claim submitted';
  const selector=claimFormSelector(formData);
  try {
    const me = await actionSubject(s,selector);
    const file = formData.get('receipt');
    const hasFile = file instanceof File && file.size > 0;
    let attachment: { fileName: string; mimeType: string; content: Buffer } | null = null;
    if (hasFile) {
      const content = Buffer.from(await file.arrayBuffer());
      const mimeType = sniffMime(content);
      if (!mimeType) throw new Error('Only PDF, JPG, or PNG files are allowed');
      attachment = { fileName: file.name, mimeType, content };
    }
    const fields = {
      employmentId: me.employmentId,
      claimTypeId: String(formData.get('claimTypeId')),
      claimItemId: String(formData.get('claimItemId') ?? '').trim() || null,
      amount: Number(formData.get('amount')),
      quantityKm: numOrNull(formData.get('quantityKm')),
      incurredOn: String(formData.get('incurredOn')),
      description: String(formData.get('description') ?? '').trim() || null,
    };
    if (intent === 'draft') {
      await saveClaimDraft(s, { ...fields, id: draftId }, attachment);
      toast = 'Draft saved';
    } else if (draftId) {
      // Editing a draft and pressing Submit: persist the edits, then run the real submit transition on
      // that same row. Two transactions, and deliberately so — the second is the one that takes the limit
      // lock and reserves, and it must be the identical path the Drafts list uses. If it refuses (over
      // limit, missing receipt), the SAVE still stands, so nothing the employee typed is lost.
      await saveClaimDraft(s, { ...fields, id: draftId }, attachment);
      await submitDraftClaims(s, { ids: [draftId],...(selector!==undefined?{employmentId:me.employmentId}:{}) });
    } else {
      await submitClaimWithAttachment(s, { ...fields, hasReceipt: hasFile }, attachment);
    }
    revalidatePath(BASE);
  } catch (e) {
    return { error: publicErrorMessage(e) };
  }
  redirect(returnUrl(selector,{toast}));
}

/** Bulk "Submit Selected" over the Drafts list. All-or-nothing in the service; the whole batch competes
 *  for one limit, so a partial result would mean the system chose which claims to file. */
export async function submitDraftsAction(formData: FormData) {
  const s = await getSession();
  const selector=claimFormSelector(formData);
  let redirectTo: string;
  try {
    const ids = formData.getAll('draftIds').map(String).filter(Boolean);
    const own=selector===undefined?null:await actionSubject(s,selector);
    const { submitted } = await submitDraftClaims(s, { ids,...(own?{employmentId:own.employmentId}:{}) });
    revalidatePath(BASE);
    redirectTo = returnUrl(selector,{toast:`${submitted} claim(s) submitted`});
  } catch (e) {
    redirectTo = errorUrl(e,selector);
  }
  redirect(redirectTo);
}

export async function deleteDraftAction(formData: FormData) {
  const s = await getSession();
  const selector=claimFormSelector(formData);
  let redirectTo: string;
  try {
    const own=selector===undefined?null:await actionSubject(s,selector);
    await deleteClaimDraft(s, String(formData.get('id')),own?.employmentId);
    revalidatePath(BASE);
    redirectTo = returnUrl(selector,{toast:'Draft deleted'});
  } catch (e) {
    redirectTo = errorUrl(e,selector);
  }
  redirect(redirectTo);
}

export async function cancelClaimAction(formData: FormData) {
  const s = await getSession();
  const selector=claimFormSelector(formData);
  let redirectTo: string;
  try {
    const own=await actionSubject(s,selector);
    await cancelClaim(s, String(formData.get('id')),own.employmentId);
    revalidatePath(BASE);
    redirectTo = returnUrl(selector,{toast:'Claim cancelled'});
  } catch (e) {
    redirectTo = errorUrl(e,selector);
  }
  redirect(redirectTo);
}
