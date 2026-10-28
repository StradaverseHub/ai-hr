'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { publicErrorMessage } from '@/lib/public-error';
import {rewardPolicyFromForm} from './policy-input';
import { rewardCalendarStages, rewardOffcycleSlaStages, saveRewardCalendar, RewardMaintenanceError, previewRewardAccessChange, saveRewardAccessChange, deleteRewardReview, RewardPolicyGroupError, previewRewardSeniorMembership, saveRewardSeniorMembership, importOnehrRewardResults, createOffcycleReview, createRewardUnit, decideRewardUnit, getRewardUnit, importRewardFacts, postRewardUnit, saveRewardEntry, saveRewardPolicy, previewRewardMultiplier, saveRewardMultiplier, setRewardMember, setRewardUnitLump, previewRewardLump, setRewardPayWindowKeep, previewRewardSourceRefresh, saveRewardSourceRefresh } from '@/packs/rewards/service';
import { emptyFacts, isSalaryReductionAttempt, performances, talents, type RewardPolicy, type RewardRole } from '@/packs/rewards/model';

const str = (f: FormData, key: string) => String(f.get(key) ?? '').trim();
const number = (f: FormData, key: string) => Number(str(f, key));
const scaled = (f: FormData, key: string, scale = 100) => str(f, key) === '' ? null : Math.round(number(f, key) * scale);
const errorText = (e: unknown) => e instanceof ZodError ? e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : publicErrorMessage(e);
/** 328ebe84: a negative merit/promotion/special (or EC bonus/lump) reads as the business rule, in the viewer's language. */
const rewardErrorText = async (e: unknown) => isSalaryReductionAttempt(e) ? (await getTranslations('rewards'))('unitBonus.noReduction') : errorText(e);

async function change(f: FormData, work: (s: Awaited<ReturnType<typeof getSession>>, unitId: string, revision: number) => Promise<unknown>, configuration = false) {
  const s = await getSession(); const unitId = str(f, 'unitId');
  const url = `${configuration ? '/admin/rewards' : '/rewards'}/${encodeURIComponent(unitId)}`;
  try { await work(s, unitId, number(f, 'revision')); }
  catch (e) { redirect(`${url}?error=${encodeURIComponent(await rewardErrorText(e))}`); }
  revalidatePath('/rewards', 'layout'); revalidatePath('/admin/rewards', 'layout'); redirect(url);
}

export async function createRewardAction(f: FormData) {
  const s = await getSession(); let unitId: string;
  try { unitId = await createRewardUnit(s, { name: str(f, 'name'), year: number(f, 'year'), companyId: str(f, 'companyId'), businessUnitId: str(f, 'businessUnitId'), cycleId: str(f, 'cycleId') || undefined, snapshotDate: str(f, 'snapshotDate'),sharedPolicyVersionId:str(f,'sharedPolicyVersionId')||undefined }); }
  catch (e) {if(e instanceof RewardPolicyGroupError)redirect(`/admin/rewards?sharedError=${e.code}`);redirect(`/admin/rewards?error=${encodeURIComponent(errorText(e))}`);}
  revalidatePath('/rewards'); revalidatePath('/admin/rewards'); redirect(`/admin/rewards/${unitId}`);
}
export async function memberAction(f: FormData) { return change(f, (s, id, rev) => setRewardMember(s, id, rev, str(f, 'userId'), str(f, 'role') as RewardRole, str(f, 'remove') === 'true'), true); }
/** 4e3e1af7: Use suggested amount / Set amount / Withhold for this BU, with a reason (required to withhold). */
export async function lumpAction(f: FormData) {
  const mode = str(f, 'mode'), reason = str(f, 'reason');
  return change(f, (s, id, rev) => setRewardUnitLump(s, id, rev, mode === 'set' ? { mode, cents: scaled(f, 'lump') ?? 0, reason } : { mode: mode === 'withhold' ? 'withhold' : 'auto', reason }));
}
/** c28db2f0: per-plan effect of a candidate unit lump sum, recalculated as the amount is typed. */
export async function previewRewardLumpAction(unitId: string, revision: number, cents: number | null) {
  try { return { ok: true as const, preview: await previewRewardLump(await getSession(), unitId, revision, cents) }; }
  catch (error) { return { ok: false as const, error: errorText(error) }; }
}
/** 8ad87ae8: keep (or stop keeping) one person eligible despite a pay change in the exclusion window. */
export async function payWindowKeepAction(f: FormData) {
  const s = await getSession(), unitId = str(f, 'unitId'), url = `/rewards/${encodeURIComponent(unitId)}?view=excluded`;
  try { await setRewardPayWindowKeep(s, unitId, number(f, 'revision'), str(f, 'entryId'), str(f, 'keep') === 'true', str(f, 'reason')); }
  catch (e) { redirect(`${url}&error=${encodeURIComponent(await rewardErrorText(e))}`); }
  revalidatePath('/rewards', 'layout'); redirect(url);
}
/** 40bf44f7: refresh is preview → confirm; the confirm carries the previewed date and digest. */
export async function previewSourceRefreshAction(unitId: string, revision: number, asOf: string) {
  try { return { ok: true as const, preview: await previewRewardSourceRefresh(await getSession(), unitId, revision, asOf || undefined) }; }
  catch (error) { return { ok: false as const, error: errorText(error) }; }
}
export async function saveSourceRefreshAction(unitId: string, revision: number, asOf: string, previewDigest: string) {
  try {
    await saveRewardSourceRefresh(await getSession(), unitId, revision, asOf, previewDigest);
    revalidatePath('/rewards', 'layout'); revalidatePath('/admin/rewards', 'layout');
    return { ok: true as const };
  } catch (error) { return { ok: false as const, error: errorText(error) }; }
}
export async function decideAction(f: FormData) { return change(f, (s, id, rev) => decideRewardUnit(s, id, rev, str(f, 'action') as 'submit' | 'approve' | 'return' | 'reject' | 'withdraw', str(f, 'reason'), f.has('acknowledged'))); }
export async function postAction(f: FormData) { return change(f, (s, id, rev) => postRewardUnit(s, id, rev, str(f, 'batchId') || undefined)); }
/** Reward calendar (migration 0646). `revision` is the calendar's own revision (0 when not yet created). */
export async function calendarAction(f: FormData) {
  const date = (key: string) => str(f, key) || null;
  const days = (key: string) => str(f, key) === '' ? null : number(f, key);
  return change(f, (s, id, rev) => saveRewardCalendar(s, id, rev, {
    due: Object.fromEntries(rewardCalendarStages.map(k => [k, date(`due.${k}`)])),
    caseDue: date('caseDue'),
    offcycleDays: Object.fromEntries(rewardOffcycleSlaStages.map(k => [k, days(`days.${k}`)])),
  }), true);
}

export async function entryAction(f: FormData) {
  return change(f, async (s, id, rev) => {
    const recommendation = {
      meritBp: scaled(f, 'merit'), promotionGrade: str(f, 'promotionGrade') || null,
      promotionBp: scaled(f, 'promotion'), specialBp: scaled(f, 'special'),
      multiplierBp: scaled(f, 'multiplier', 10000), bonusCents: scaled(f, 'bonus'), lumpCents: scaled(f, 'lump'), reason: str(f, 'reason'), currentRoleSummary: str(f, 'currentRoleSummary'), proposedRoleSummary: str(f, 'proposedRoleSummary'),
    };
    let facts: unknown = f.has('facts') ? {
      talent: str(f, 'talent') || null, performance: str(f, 'performance') || null,
      confidentiality: str(f, 'confidentiality'), seniorPlan: f.has('seniorPlan'),
      erCase: f.has('erCase'), pipCase: f.has('pipCase'), erDecision: str(f, 'erDecision'), pipDecision: str(f, 'pipDecision'),
      caseReason: str(f, 'caseReason'), branch: str(f, 'branch'), segment: str(f, 'segment'), reviewed: f.has('reviewed'),
    } : undefined;
    if (!f.has('facts') && f.has('cases')) {
      const view = await getRewardUnit(s, id);
      const existing = view.rows.find(e => e.id === str(f, 'entryId'));
      if (!existing) throw new Error('Reward record unavailable.');
      facts = { ...existing.facts, erDecision: str(f, 'erDecision'), pipDecision: str(f, 'pipDecision'), caseReason: str(f, 'caseReason') };
    }
    await saveRewardEntry(s, id, rev, str(f, 'entryId'), recommendation, facts);
  });
}

export async function policyAction(f: FormData) {
  return change(f, async (s,id,rev)=>{
    const view=await getRewardUnit(s,id);
    await saveRewardPolicy(s,id,rev,rewardPolicyFromForm(f,view.unit.policy));
  },true);
}

/** bcd7cc0f: the unit multiplier is previewed per plan, then saved with a reason through its one owner. */
export async function previewRewardMultiplierAction(unitId: string, revision: number, multiplierBp: number | null) {
  try { return { ok: true as const, preview: await previewRewardMultiplier(await getSession(), unitId, revision, multiplierBp) }; }
  catch (error) { return { ok: false as const, error: errorText(error) }; }
}
export async function saveRewardMultiplierAction(unitId: string, revision: number, multiplierBp: number | null, reason: string, previewDigest: string) {
  try {
    await saveRewardMultiplier(await getSession(), unitId, revision, multiplierBp, reason, previewDigest);
    revalidatePath('/rewards', 'layout'); revalidatePath('/admin/rewards', 'layout');
    return { ok: true as const };
  } catch (error) { return { ok: false as const, error: errorText(error) }; }
}

export async function importFactsAction(f: FormData) {
  return change(f, async (s, id, rev) => {
    const file = f.get('file');
    if (!(file instanceof File) || !file.size || file.size > 2_000_000) throw new Error('Choose a CSV file smaller than 2 MB.');
    if (!file.name.toLowerCase().endsWith('.csv')) throw new Error('Save the completed template as CSV before importing.');
    const XLSX = await import('xlsx'); const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: true });
    const records = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets[workbook.SheetNames[0]], { defval: '', raw: false });
    const view = await getRewardUnit(s, id);
    const bool = (v: unknown) => { if (v === '' || v == null || String(v).toLowerCase() === 'false') return false; if (String(v).toLowerCase() === 'true') return true; throw new Error('Boolean columns accept true or false.'); };
    await importRewardFacts(s, id, rev, records.map(r => {
      const existing = view.rows.find(e => e.source.employmentId === r.employmentId);
      if (!existing) throw new Error('The import contains an unavailable employee.');
      return { employmentId: r.employmentId, facts: { ...emptyFacts(), ...existing.facts, talent: (r.talent || null) as typeof talents[number] | null, performance: (r.performance || null) as typeof performances[number] | null, confidentiality: r.confidentiality as 'standard' | 'bg' | 'ec', seniorPlan: bool(r.seniorPlan), erCase: bool(r.erCase), pipCase: bool(r.pipCase), erDecision: r.erDecision as 'pending' | 'in' | 'out', pipDecision: r.pipDecision as 'pending' | 'lift' | 'confirm', caseReason: r.caseReason, branch: r.branch, segment: r.segment, reviewed: bool(r.reviewed) } };
    }));
  });
}

export async function offcycleAction(f: FormData) {
  const s = await getSession(); let id: string;
  const parent = str(f, 'unitId');
  try { id = await createOffcycleReview(s, parent, { kind: str(f, 'kind') as 'adhoc' | 'midyear', entryIds: f.getAll('entryIds').map(String), effectiveFrom: str(f, 'effectiveFrom'), exceptionReason: str(f, 'exceptionReason') }); }
  catch (e) { redirect(`/rewards/${encodeURIComponent(parent)}?error=${encodeURIComponent(errorText(e))}`); }
  revalidatePath('/rewards', 'layout'); redirect(`/rewards/${id}`);
}

export async function importOnehrAction(f:FormData) { return change(f,(s,id,rev)=>importOnehrRewardResults(s,id,rev)); }

export async function previewSeniorMembershipAction(unitId: string, revision: number, input: unknown) {
  try { return { ok: true as const, preview: await previewRewardSeniorMembership(await getSession(), unitId, revision, input) }; }
  catch (error) { return { ok: false as const, error: errorText(error) }; }
}
export async function saveSeniorMembershipAction(unitId: string, revision: number, input: unknown, previewDigest: string) {
  try {
    await saveRewardSeniorMembership(await getSession(), unitId, revision, input, previewDigest);
    revalidatePath('/rewards', 'layout'); revalidatePath('/admin/rewards', 'layout');
    return { ok: true as const };
  } catch (error) { return { ok: false as const, error: errorText(error) }; }
}

export async function previewRewardAccessAction(input:unknown){
 try{return{ok:true as const,preview:await previewRewardAccessChange(await getSession(),input)};}
 catch(error){return{ok:false as const,error:maintenanceErrorCode(error)};}
}
export async function saveRewardAccessAction(input:unknown,digest:string){
 try{await saveRewardAccessChange(await getSession(),input,digest);revalidatePath('/rewards','layout');revalidatePath('/admin/rewards','layout');return{ok:true as const};}
 catch(error){return{ok:false as const,error:maintenanceErrorCode(error)};}
}
function maintenanceErrorCode(error:unknown){return error instanceof RewardMaintenanceError?error.code:'system';}
export async function deleteRewardAction(f:FormData){
 try{await deleteRewardReview(await getSession(),str(f,'unitId'),number(f,'revision'),str(f,'confirmation'));}
 catch(error){redirect(`/admin/rewards?deletionError=${maintenanceErrorCode(error)}`);}
 revalidatePath('/rewards','layout');revalidatePath('/admin/rewards','layout');redirect('/admin/rewards?deleted=1');
}
