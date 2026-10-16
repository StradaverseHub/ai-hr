/** Read-only context narrowing. Scope is an additional selection, never a replacement for RLS. */
import { and, eq, inArray } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { myEmployments, myOwnEmploymentSubjects } from './read';
import { todayInKualaLumpur } from '../lib/hr-date';
import { provenCompanyDatesTx } from './employment-company';
export type AssistantReadScope = {
    companyIds: readonly string[];
};
export async function assistantOwnActiveSubjects(ctx: SessionContext, scope?: AssistantReadScope) {
    if (!scope)
        return myEmployments(ctx); // Existing non-conversation callers retain their selection.
    const today = todayInKualaLumpur();
    const own=await myOwnEmploymentSubjects(ctx,{profileEdit:true});if(own.length>20)throw new Error('Narrow the own employment selection.');
    return own.filter(row => row.hiredOn <= today && row.companyProof.companyId && scope.companyIds.includes(row.companyProof.companyId)).map(row => ({ employmentId: row.employmentId, company: row.company }));
}
export async function assistantVisibleEmployment(ctx: SessionContext, id: string, scope?: AssistantReadScope) {
    if (!scope)
        return true;
    if (!scope.companyIds.length)
        return false;
    return withTenant(ctx, async (tx) => !!(await tx.select({ id: schema.employment.id }).from(schema.employment).where(and(eq(schema.employment.id, id), inArray(schema.employment.companyId, [...scope.companyIds]))).limit(1))[0]);
}
/** A past attendance day follows strict dated company proof, never today's transferred company. */
export async function assistantDatedRows<T extends {
    date: string;
}>(ctx: SessionContext, employmentId: string, rows: T[], scope?: AssistantReadScope) {
    if (!scope)
        return { rows, truncated: false };
    return withTenant(ctx, async (tx) => {
        const proof = await provenCompanyDatesTx(tx, rows.map(row => ({ employmentId, date: row.date })));
        const visible = rows.filter(row => { const companyId = proof.get(`${employmentId}|${row.date}`)?.companyId; return !!companyId && scope.companyIds.includes(companyId); });
        return { rows: visible, truncated: visible.length !== rows.length };
    });
}

import {packFor} from '../localization/registry';
/** Current own-person statutory presence, through the country's authoritative owner. Never exports
 * numbers, national identity, relief details, bank data, salary or a computed contribution. */
export async function assistantOwnStatutory(ctx:SessionContext,scope?:AssistantReadScope){
 if(!ctx.personId)return [];
 const subjects=(await myOwnEmploymentSubjects(ctx,{profileEdit:true})).filter(row=>row.companyProof.companyId&&(!scope||scope.companyIds.includes(row.companyProof.companyId)));
 const ids=[...new Set(subjects.flatMap(row=>row.companyProof.companyId?[row.companyProof.companyId]:[]))];if(!ids.length)return [];
 const companies=await withTenant(ctx,tx=>tx.select({id:schema.company.id,country:schema.company.country}).from(schema.company).where(inArray(schema.company.id,ids)));
 const rows=[];for(const subject of subjects){const country=companies.find(company=>company.id===subject.companyProof.companyId)?.country,pack=packFor(country);if(!pack){rows.push({employmentId:subject.employmentId,company:subject.company,country:country??null,profileAvailable:false});continue;}
  const profile=await pack.statutory.get(ctx,ctx.personId);rows.push({employmentId:subject.employmentId,company:subject.company,country:country??null,profileAvailable:!!profile,registrationNumbersRecorded:profile?{epf:!!profile.epfNumber?.trim(),socso:!!profile.socsoNumber?.trim(),incomeTax:!!profile.taxNumber?.trim()}:null});
 }return rows;
}
