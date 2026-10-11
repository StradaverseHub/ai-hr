'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { getSession } from '@/lib/session';
import { publicErrorMessage } from '@/lib/public-error';
import { createOffcycleReview, createRewardUnit, decideRewardUnit, getRewardUnit, importRewardFacts, postRewardUnit, refreshRewardSources, saveRewardEntry, saveRewardPolicy, setRewardMember, setRewardUnitLump } from '@/packs/rewards/service';
import { emptyFacts, performances, talents, type RewardPolicy, type RewardRole } from '@/packs/rewards/model';

const str = (f: FormData, key: string) => String(f.get(key) ?? '').trim();
const number = (f: FormData, key: string) => Number(str(f, key));
const scaled = (f: FormData, key: string, scale = 100) => str(f, key) === '' ? null : Math.round(number(f, key) * scale);
const errorText = (e: unknown) => e instanceof ZodError ? e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : publicErrorMessage(e);

async function change(f: FormData, work: (s: Awaited<ReturnType<typeof getSession>>, unitId: string, revision: number) => Promise<unknown>) {
  const s = await getSession(); const unitId = str(f, 'unitId');
  const url = `/rewards/${encodeURIComponent(unitId)}`;
  try { await work(s, unitId, number(f, 'revision')); }
  catch (e) { redirect(`${url}?error=${encodeURIComponent(errorText(e))}`); }
  revalidatePath('/rewards', 'layout'); redirect(url);
}

export async function createRewardAction(f: FormData) {
  const s = await getSession(); let unitId: string;
  try { unitId = await createRewardUnit(s, { name: str(f, 'name'), year: number(f, 'year'), companyId: str(f, 'companyId'), businessUnitId: str(f, 'businessUnitId'), cycleId: str(f, 'cycleId') || undefined, snapshotDate: str(f, 'snapshotDate') }); }
  catch (e) { redirect(`/rewards?error=${encodeURIComponent(errorText(e))}`); }
  revalidatePath('/rewards'); redirect(`/rewards/${unitId}`);
}
export async function memberAction(f: FormData) { return change(f, (s, id, rev) => setRewardMember(s, id, rev, str(f, 'userId'), str(f, 'role') as RewardRole, str(f, 'remove') === 'true')); }
export async function lumpAction(f: FormData) { return change(f, (s, id, rev) => setRewardUnitLump(s, id, rev, scaled(f, 'lump'))); }
export async function refreshAction(f: FormData) { return change(f, (s, id, rev) => refreshRewardSources(s, id, rev)); }
export async function decideAction(f: FormData) { return change(f, (s, id, rev) => decideRewardUnit(s, id, rev, str(f, 'action') as 'submit' | 'approve' | 'return' | 'reject' | 'withdraw', str(f, 'reason'), f.has('acknowledged'))); }
export async function postAction(f: FormData) { return change(f, (s, id, rev) => postRewardUnit(s, id, rev, str(f, 'batchId') || undefined)); }

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

function lines(text: string, columns: number): string[][] {
  if (!text.trim()) return [];
  return text.split(/\r?\n/).filter(x => x.trim()).map(line => {
    const cells = line.split(',').map(x => x.trim());
    if (cells.length !== columns || !cells[0]) throw new Error(`Each row needs ${columns} comma-separated values.`);
    return cells;
  });
}
function matrix(text: string, columns: number, scale: number) {
  const result: Record<string, number[]> = {};
  for (const [key, ...values] of lines(text, columns)) {
    if (Object.hasOwn(result, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Grade or segment names must be unique.');
    result[key] = values.map(x => { const n = Number(x); if (!x || !Number.isFinite(n)) throw new Error('Enter a number in every matrix cell.'); return Math.round(n * scale); });
  }
  return result;
}
export async function policyAction(f: FormData) {
  return change(f, async (s, id, rev) => {
    const view = await getRewardUnit(s, id); const p = view.unit.policy;
    const meritMatrix = Object.fromEntries(talents.map(t => [t, [0, 1, 2].map(pos => Math.round(number(f, `merit.${t}.${pos}`) * 100))]));
    const branchRatings = Object.fromEntries(lines(str(f, 'branchRatings'), 2));
    const policy = { ...p, effectiveFrom: str(f, 'effectiveFrom'), joinedBefore: str(f, 'joinedBefore'), confirmedBy: str(f, 'confirmedBy'), blockedFrom: str(f, 'blockedFrom'), blockedTo: str(f, 'blockedTo'),
      patActual: scaled(f, 'patActual'), patTarget: scaled(f, 'patTarget'), targetMonthsBp: scaled(f, 'targetMonths', 10000), multiplierBp: scaled(f, 'multiplier', 10000),
      standardPools: [0, 1, 2].map(i => Math.round(number(f, `standard.${i}`) * 100)), hPools: [0, 1, 2].map(i => Math.round(number(f, `h.${i}`) * 100)),
      meritMatrix, ranges: matrix(str(f, 'ranges'), 4, 100), bonusMatrix: matrix(str(f, 'bonusMatrix'), 6, 10000), bonusStructure: str(f, 'bonusStructure'),
      branchFactors: matrix(str(f, 'branchFactors'), 6, 10000), branchRatings,
      seniorGrades: str(f, 'seniorGrades').split(',').map(x => x.trim()).filter(Boolean),
      lumpStepCents: scaled(f, 'lumpStep'), lumpShareBp: scaled(f, 'lumpShare'), lumpCapCents: scaled(f, 'lumpCap'), exemptReason: str(f, 'exemptReason'),
    };
    await saveRewardPolicy(s, id, rev, policy as RewardPolicy);
  });
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
