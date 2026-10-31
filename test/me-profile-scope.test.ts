/**
 * r259 stage one (board item 9583deac) — MY PROFILE READS ONE RECORD, AND THE DATABASE IS WHAT DECIDES SO.
 *
 * The plan promises the reporter: "Employees see only their own record. There is no way to search for or
 * open anybody else." test/me-profile-visibility.test.ts pins the SHAPE of that promise (no picker, no id
 * parameter). This file pins the ENFORCEMENT, against a live cluster, because the shape is the half that
 * a refactor can restore by accident and the enforcement is the half that actually protects anybody.
 *
 * The distinction that matters, and it is the one the brief asked for: the scope must be RLS, not a
 * `.where()` in a page. A filter in a page is one careless edit from being dropped and nothing fails; an
 * RLS policy refuses the row even when the caller asks for it by id. So the cases below do exactly that —
 * they call the ADMIN read (`employeeDetail`) with a COLLEAGUE'S employment id under an employee session,
 * which is the strongest form of the question, and expect nothing back.
 *
 * `app.can_see_employment` (migration 0016) is: admin-for-the-company ∪ self ∪ administrative-manager-of.
 * A plain employee is none of those for a colleague, so the row is invisible to them at the database.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hireEmployee } from '../core/org';
import { updateOwnContact } from '../core/profile';
import { employeeDetail } from '../core/read';
import {setCompensation,compensationHistoryDetailed} from '../core/comp';
import {readOwnProfileWorkspace} from '../core/profile-edit';
import {readOwnProfileFacts} from '../core/profile-view';
import {PERSONNEL_FIELDS,personnelField} from '../lib/personnel-field-registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import { myProfileRecord } from '../app/(app)/me/record';
import { ME_WITHHELD_COLUMNS } from '../app/(app)/me/visible-fields';
import { person } from '../db/schema';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  setModule,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

// Two compatibility DTO facts share short names with protected owners. Exempt ONLY these
// exact legacy paths; a protected key anywhere else (including an array) remains a violation.
const LEGACY_OWN_FACT_PATHS=new Set([
  JSON.stringify(['contact','homeAddress','state']),
  JSON.stringify(['compensation','monthlyAllowance']),
]);
function withheldPaths(value:unknown,withheld:string,path:string[]=[]):string[][] {
  if(value===null||typeof value!=='object')return [];
  return Object.entries(value).flatMap(([key,child])=>{
    const next=[...path,key];
    return [...(key===withheld&&!LEGACY_OWN_FACT_PATHS.has(JSON.stringify(next))?[next]:[]),...withheldPaths(child,withheld,next)];
  });
}


async function hire(name: string) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
}

/** A plain employee principal: linked to a person, holding only the `employee` role. */
async function employeeCtx(personId: string): Promise<SessionContext> {
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { tenantId: b.tenantId, userId, personId, roles: ['employee'] };
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('r259 — /me is scoped to the caller’s own employment', () => {
  it('returns the caller’s OWN record, resolved from the session and not from a parameter', async () => {
    const mine = await hire('Selfreader');
    const ctx = await employeeCtx(mine.personId);

    const record = await myProfileRecord(ctx);

    expect(record, 'an employed principal must get their own record').not.toBeNull();
    expect(record!.employmentId).toBe(mine.employmentId);
    expect(record!.personId).toBe(mine.personId);
    expect(record!.profile.fullName).toBe('Selfreader');
  });

  it('CANNOT reach a colleague’s record even by asking for it by id — RLS refuses the row', async () => {
    const mine = await hire('Selfreader');
    const colleague = await hire('Colleague');
    const ctx = await employeeCtx(mine.personId);

    // The strongest form of the question: the ADMIN read, handed the colleague's id, under the employee's
    // own session. Nothing in the page is between the caller and the database here — if this returns a
    // row, the scope on /me was never real and the screen is one bad refactor from a leak.
    const theirs = await employeeDetail(ctx, colleague.employmentId);
    expect(theirs, 'an employee read a colleague’s employment row').toBeNull();

    // And the admin session CAN see it, so the null above is the policy refusing — not a broken fixture,
    // an empty table, or a query that returns nothing for everyone.
    const asAdmin = await employeeDetail(adminCtx(b), colleague.employmentId);
    expect(asAdmin?.employmentId).toBe(colleague.employmentId);
  });

  it('shows canonical address blocks and retained legacy reconciliation without allowing the retired direct address writer',async()=>{
    const mine=await hire('Selfreader'),ctx=await employeeCtx(mine.personId);
    await owner.db.update(person).set({addressLine1:'ZZLEGACYLINE1',permanentAddressLine1:'ZZPERMLINE1',correspondenceAddressLine1:'ZZCORRLINE1'}).where(eq(person.id,mine.personId));
    const workspace=await readOwnProfileWorkspace(ctx,{employmentId:mine.employmentId});
    expect(workspace.values['profile.contact_and_permanent_address.permanentaddressline1']).toBe('ZZPERMLINE1');expect(workspace.values['profile.correspondence_address.correspondenceaddressline1']).toBe('ZZCORRLINE1');expect(workspace.addressReview).toBe(true);expect(workspace.legacyAddress.addressLine1).toBe('ZZLEGACYLINE1');
    await expect(updateOwnContact(ctx,{addressLine1:'ZZUNAUTHORIZED'})).rejects.toMatchObject({code:'addressReview'});
    const [master]=await owner.db.select().from(person).where(eq(person.id,mine.personId));expect(master.addressLine1).toBe('ZZLEGACYLINE1');expect(master.permanentAddressLine1).toBe('ZZPERMLINE1');expect(master.correspondenceAddressLine1).toBe('ZZCORRLINE1');
  });

  it('a principal linked to no employment gets nothing rather than somebody else’s record', async () => {
    await hire('Somebody');
    // A platform login: a real app_user with no person behind it.
    const ctx: SessionContext = {
      tenantId: b.tenantId,
      userId: b.adminUserId,
      personId: undefined,
      roles: ['employee'],
    };
    expect(await myProfileRecord(ctx)).toBeNull();
  });

  it('carries no manifest-withheld field out of the legacy DTO except its exact legitimate own-fact paths', async () => {
    const mine=await hire('Selfreader'),ctx=await employeeCtx(mine.personId);
    await owner.db.update(person).set({state:'ZZOWNLEGACYSTATE'}).where(eq(person.id,mine.personId));
    await setCompensation(adminCtx(b),{employmentId:mine.employmentId,basicSalary:3500,monthlyAllowance:25.13,effectiveFrom:todayInKualaLumpur(),remarks:'ZZINTERNALSALARYREASON'});
    const record=await myProfileRecord(ctx);
    expect(record?.contact.homeAddress.state).toBe('ZZOWNLEGACYSTATE');
    expect(record?.compensation).toMatchObject({basicSalary:'3500.00',monthlyAllowance:'25.13'});
    expect(JSON.stringify(record)).not.toContain('ZZINTERNALSALARYREASON');

    // The manifest remains the complete authority. The two same-name protected owners stay armed.
    expect(personnelField('leave.eligibility_and_explanation_details.state')).toMatchObject({owner:'leaveEligibility',ownerField:'state',ess:{visibility:'protected'}});
    expect(personnelField('payroll.draft_initial_monthly_allowance.monthlyallowance')).toMatchObject({owner:'draft',ownerField:'monthlyAllowance',ess:{visibility:'protected'}});
    expect(ME_WITHHELD_COLUMNS).toEqual(expect.arrayContaining(['state','monthlyAllowance']));
    expect(ME_WITHHELD_COLUMNS.length,'the withheld list names no columns at all').toBeGreaterThan(20);
    for(const withheld of ME_WITHHELD_COLUMNS)expect(withheldPaths(record,withheld),`legacy employee DTO carries protected ${withheld}`).toEqual([]);
  });

  it('detects same-name protected keys outside the two exact own-fact paths',()=>{
    const allowed={contact:{homeAddress:{state:'Own state'}},compensation:{monthlyAllowance:'25.13'}};
    expect(withheldPaths(allowed,'state')).toEqual([]);expect(withheldPaths(allowed,'monthlyAllowance')).toEqual([]);
    const injected={...allowed,leaveEligibility:{state:'internal'},draft:{monthlyAllowance:'9999.99'},contact:{...allowed.contact,other:{state:'internal'}},rows:[{state:'internal',monthlyAllowance:'9999.99'}],
      // A literal dotted key must not masquerade as the actual nested own-fact path.
      'contact.homeAddress':{state:'internal'}};
    const statePaths=withheldPaths(injected,'state'),allowancePaths=withheldPaths(injected,'monthlyAllowance');
    expect(statePaths).toHaveLength(4);expect(statePaths).toEqual(expect.arrayContaining([['leaveEligibility','state'],['contact','other','state'],['rows','0','state'],['contact.homeAddress','state']]));
    expect(allowancePaths).toHaveLength(2);expect(allowancePaths).toEqual(expect.arrayContaining([['draft','monthlyAllowance'],['rows','0','monthlyAllowance']]));
  });

  it('projects populated current Profile facts and workspace only by visible stable field IDs for the actual own subject',async()=>{
    await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'attendance','active');
    const mine=await hire('Selfreader'),colleague=await hire('Colleague');
    const ctx={...await entitledCtx(b,['employee']),...await employeeCtx(mine.personId)};
    const internal='ZZCURRENTOWNERINTERNALSALARYREASON';
    await setCompensation(adminCtx(b),{employmentId:mine.employmentId,basicSalary:3500,monthlyAllowance:25.13,effectiveFrom:todayInKualaLumpur(),remarks:internal});
    const revisions=await compensationHistoryDetailed(adminCtx(b),mine.employmentId);
    expect(revisions.some(row=>row.remarks===internal),'private sentinel must exist in the canonical salary owner').toBe(true);
    const facts=await readOwnProfileFacts(ctx,mine.employmentId),workspace=await readOwnProfileWorkspace(ctx,{employmentId:mine.employmentId});
    expect(facts.header).toMatchObject({name:'Selfreader'});expect(facts.modules).toEqual({payroll:true,leave:true,attendance:true});
    expect(facts.values['payroll.basic_salary_and_salary_history.basicsalary']).toBe('3500.00');
    expect(workspace.values['profile.personal_details.fullname']).toBe('Selfreader');
    expect(facts.records.length,'real hired history must exercise records.values').toBeGreaterThan(0);
    const emitted=[facts.values,...facts.records.map(row=>row.values),workspace.values,...workspace.registers.map(row=>row.values)];
    for(const values of emitted){
      for(const field of PERSONNEL_FIELDS.filter(field=>field.ess.visibility==='protected'))expect(Object.hasOwn(values,field.id),`protected stable field ID emitted: ${field.id}`).toBe(false);
      for(const id of Object.keys(values))expect(personnelField(id)?.ess.visibility,`undeclared or nonvisible field ID: ${id}`).toBe('visible');
    }
    expect(JSON.stringify({facts,workspace})).not.toContain(internal);
    await expect(readOwnProfileFacts(ctx,colleague.employmentId)).rejects.toMatchObject({code:'permission'});
    await expect(readOwnProfileWorkspace(ctx,{employmentId:colleague.employmentId})).rejects.toMatchObject({code:'permission'});
  });
});
