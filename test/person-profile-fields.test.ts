/**
 * b4682879 — Personnel Profile redesign: the new personal / contact / structured-address / emergency
 * fields on `person`. Pins:
 *  - updatePerson writes the new profile fields + the person.updated event lists them by NAME only
 *    (never the religion/race VALUES — PDPA / ADR-0030 append-only log);
 *  - setPersonComplianceFields now also sets date of birth (admin path) + rejects a non-admin;
 *  - direct ESS contact aliases cannot bypass versioned address/Emergency approval; permitted phone/
 *    email save immediately while canonical Permanent fields and exact register IDs await HR.
 */
import { asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, updatePerson } from '../core/org';
import { setPersonComplianceFields, updateOwnContact, decideProfileChange } from '../core/profile';
import {readOwnProfileWorkspace,submitOwnProfileEdit} from '../core/profile-edit';
import {saveProfileEditPolicy} from '../core/profile-edit-policy';
import {addEmergencyContact,listEmergencyContacts} from '../core/emergency-contacts';
import type {EssProfileProposal} from '../lib/personnel-ess-model';
import {
  adminCtx,
  closeAll,
  createAppUser,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import type { SessionContext } from '../db/client';

let b: Base;

async function hire(name: string) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
}
async function personRow(personId: string) {
  const [p] = await owner.db.select().from(schema.person).where(eq(schema.person.id, personId));
  return p;
}
// 23ad620e — the emergency contact moved off `person` into its own per-person register.
async function primaryContact(personId: string) {
  const [c] = await owner.db
    .select()
    .from(schema.personEmergencyContact)
    .where(eq(schema.personEmergencyContact.personId, personId));
  return c;
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

describe('b4682879 — person profile fields', () => {
  it('updatePerson writes the new profile fields and keeps fullName/primaryEmail intact', async () => {
    const E = await hire('Profiler');
    await updatePerson(adminCtx(b), {
      personId: E.personId,
      fullName: 'Profiler Full',
      primaryEmail: 'profiler@work.test',
      phone: '0111111111',
      firstName: 'Pro',
      lastName: 'Filer',
      preferredName: 'Prof',
      religion: 'Buddhist',
      race: 'Chinese',
      nationality: 'Malaysian',
      personalEmail: 'prof@home.test',
      addressLine1: '1 Jalan Satu',
      addressLine2: 'Taman Dua',
      postcode: '50000',
      city: 'Kuala Lumpur',
      state: 'WP Kuala Lumpur',
      country: 'Malaysia',
      emergencyContactName: 'Kin',
      emergencyContactRelationship: 'Spouse',
      emergencyContactPhone: '0122222222',
      emergencyContactPhone2: '0133333333',
      emergencyContactAddress: '2 Jalan Dua',
    });
    const p = await personRow(E.personId);
    expect(p.fullName).toBe('Profiler Full');
    expect(p.firstName).toBe('Pro');
    expect(p.lastName).toBe('Filer');
    expect(p.preferredName).toBe('Prof');
    expect(p.religion).toBe('Buddhist');
    expect(p.race).toBe('Chinese');
    expect(p.nationality).toBe('Malaysian');
    expect(p.personalEmail).toBe('prof@home.test');
    expect(p.addressLine1).toBe('1 Jalan Satu');
    expect(p.addressLine2).toBe('Taman Dua');
    expect(p.postcode).toBe('50000');
    expect(p.city).toBe('Kuala Lumpur');
    expect(p.state).toBe('WP Kuala Lumpur');
    expect(p.country).toBe('Malaysia');
    // 23ad620e — the five emergency fields are still ACCEPTED by updatePerson but no longer live on
    // `person`: they route into the per-person register's highest-priority record.
    const ec = await primaryContact(E.personId);
    expect(ec.fullName).toBe('Kin');
    expect(ec.relationship).toBe('Spouse');
    expect(ec.mobilePhone).toBe('0122222222');
    expect(ec.homePhone).toBe('0133333333');
    expect(ec.address).toBe('2 Jalan Dua');
    expect(ec.priority).toBe('primary');
  });

  it('the person.updated event lists the profile fields by NAME and never leaks the religion/race VALUE', async () => {
    const E = await hire('Auditee');
    await updatePerson(adminCtx(b), {
      personId: E.personId,
      fullName: 'Auditee Full',
      primaryEmail: 'aud@work.test',
      religion: 'Hindu',
      race: 'Indian',
    });
    const payload = await latestEventPayload(b.tenantId, E.personId, 'person.updated');
    expect(payload).toBeTruthy();
    // Field names present…
    expect((payload as { fields?: string[] }).fields).toEqual(expect.arrayContaining(['religion', 'race']));
    // …but the sensitive VALUES never appear anywhere in the serialized payload.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('Hindu');
    expect(serialized).not.toContain('Indian');
  });

  it('setPersonComplianceFields sets date of birth (admin), and refuses an unprepared non-admin without changing the record', async () => {
    const E = await hire('DobSetter');
    await setPersonComplianceFields(adminCtx(b), { employmentId: E.employmentId, dateOfBirth: '1990-04-15' });
    expect((await personRow(E.personId)).dateOfBirth).toBe('1990-04-15');

    // A malformed DOB is dropped (never persisted) rather than corrupting the age-band math.
    await expect(
      setPersonComplianceFields(adminCtx(b), { employmentId: E.employmentId, dateOfBirth: '15/04/1990' }),
    ).rejects.toThrow(/nothing to change/i);

    const uid = await createAppUser(b.tenantId, E.personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: uid, personId: E.personId, roles: ['employee'] };
    const before=await personRow(E.personId);
    await expect(
      setPersonComplianceFields(empCtx, { employmentId: E.employmentId, dateOfBirth: '2000-01-01' }),
    ).rejects.toMatchObject({code:'permission',fieldIds:[]});
    expect(await personRow(E.personId)).toEqual(before);
  });

  it('refuses mixed legacy aliases atomically, saves permitted contact details immediately and approves canonical Permanent/Emergency changes', async () => {
    const E=await hire('SelfContact'),hr={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
    const primary=await addEmergencyContact(hr,{personId:E.personId,fullName:'Original Kin',mobilePhone:'012-1111111',homePhone:'0180000000',address:'Original contact address',priority:'primary'});
    const other=await addEmergencyContact(hr,{personId:E.personId,fullName:'Retained backup',priority:'secondary'});
    const phone='profile.contact_and_permanent_address.phone',email='profile.contact_and_permanent_address.personalemail';
    const addressChanges:[string,string][]=[['profile.contact_and_permanent_address.permanentaddressline1','9 Jalan Sembilan'],['profile.contact_and_permanent_address.permanentpostcode','43000'],['profile.contact_and_permanent_address.permanentcity','Kajang'],['profile.contact_and_permanent_address.permanentstate','Selangor'],['profile.contact_and_permanent_address.permanentcountry','Malaysia']];
    const contactChanges:[string,string][]=[['profile.emergency_contact.fullname','My Kin'],['profile.emergency_contact.relationship','Parent'],['profile.emergency_contact.homephone','0188888888'],['profile.emergency_contact.address','9 Jalan Sembilan']];
    await saveProfileEditPolicy(hr,{keys:[phone,email,...addressChanges.map(([id])=>id),...contactChanges.map(([id])=>id)],withdrawnReason:'Only the explicit contact and address fields are enabled'});
    const uid=await createAppUser(b.tenantId,E.personId,'employee');
    const empCtx:SessionContext={...adminCtx(b),userId:uid,personId:E.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
    const beforePerson=await personRow(E.personId),beforeContacts=await listEmergencyContacts(hr,{personId:E.personId});
    await expect(updateOwnContact(empCtx,{phone:'0199999999',personalEmail:'self@home.test',addressLine1:'9 Jalan Sembilan',postcode:'43000',city:'Kajang',state:'Selangor',country:'Malaysia',emergencyContactName:'My Kin',emergencyContactRelationship:'Parent',emergencyContactPhone2:'0188888888',emergencyContactAddress:'9 Jalan Sembilan'})).rejects.toMatchObject({code:'addressReview'});
    expect(await personRow(E.personId)).toEqual(beforePerson);expect(await listEmergencyContacts(hr,{personId:E.personId})).toEqual(beforeContacts);
    expect(await owner.db.select().from(schema.profileChangeRequest).where(eq(schema.profileChangeRequest.personId,E.personId)).orderBy(asc(schema.profileChangeRequest.id))).toEqual([]);

    const workspace=await readOwnProfileWorkspace(empCtx,{employmentId:E.employmentId}),record=workspace.registers.find(row=>row.kind==='emergency'&&row.id===primary.id);expect(record).toBeDefined();
    const proposal:EssProfileProposal={v:2,fields:[[phone,'0199999999'],[email,'self@home.test'],...addressChanges].map(([fieldId,value])=>({fieldId,before:workspace.baselines[fieldId],value})),registers:[{kind:'emergency',id:primary.id,clientId:primary.id,fields:contactChanges.map(([fieldId,value])=>({fieldId,before:record!.baselines[fieldId],value}))}]};
    const result=await submitOwnProfileEdit(empCtx,{employmentId:E.employmentId,proposal});expect(result.saved).toEqual([phone,email]);expect(result.waiting).toEqual([...addressChanges.map(([id])=>id),...contactChanges.map(([id])=>id)]);expect(result.requestId).toBeTruthy();
    const immediate=await personRow(E.personId);expect(immediate).toMatchObject({phone:'0199999999',personalEmail:'self@home.test'});
    for(const key of ['permanentAddressLine1','permanentPostcode','permanentCity','permanentState','permanentCountry','address','addressLine1','postcode','city','state','country'] as const)expect(immediate[key]).toEqual(beforePerson[key]);
    expect(await listEmergencyContacts(hr,{personId:E.personId})).toEqual(beforeContacts);
    expect(await owner.db.select({status:schema.profileChangeRequest.status}).from(schema.profileChangeRequest).where(eq(schema.profileChangeRequest.id,result.requestId!)).orderBy(asc(schema.profileChangeRequest.id))).toEqual([{status:'pending'}]);
    await decideProfileChange(hr,{requestId:result.requestId!,decision:'approved'});
    const approved=await personRow(E.personId);expect(approved).toMatchObject({phone:'0199999999',personalEmail:'self@home.test',permanentAddressLine1:'9 Jalan Sembilan',permanentPostcode:'43000',permanentCity:'Kajang',permanentState:'Selangor',permanentCountry:'Malaysia'});
    for(const key of ['address','addressLine1','postcode','city','state','country'] as const)expect(approved[key]).toEqual(beforePerson[key]);
    const contacts=await listEmergencyContacts(hr,{personId:E.personId});expect(contacts.map(row=>row.id).sort()).toEqual(beforeContacts.map(row=>row.id).sort());expect(contacts.find(row=>row.id===primary.id)).toMatchObject({fullName:'My Kin',relationship:'Parent',mobilePhone:'012-1111111',homePhone:'0188888888',address:'9 Jalan Sembilan',priority:'primary'});expect(contacts.find(row=>row.id===other.id)).toEqual(beforeContacts.find(row=>row.id===other.id));
    expect(await owner.db.select({status:schema.profileChangeRequest.status}).from(schema.profileChangeRequest).where(eq(schema.profileChangeRequest.id,result.requestId!)).orderBy(asc(schema.profileChangeRequest.id))).toEqual([{status:'approved'}]);
  });
});
