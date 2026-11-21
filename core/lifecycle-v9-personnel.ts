/** Personnel owns these values and writers; lifecycle stores reviewed proposals and source snapshots. */
import 'server-only';
import {v9PersonnelProfileKeys,v9PersonnelStatutoryKeys,v9PersonnelWritableKeys} from '../lib/lifecycle-v9-personnel-keys';
import { and, eq, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { person, employment } from '../db/schema';
import { primaryEmergencyContactSql } from './emergency-contacts';
import { bankStatutorySubjectTx, readBankStatutoryStateTx, applyBankStatutoryPatchTx, buildBankStatutoryPatch } from './bank-statutory-import';
import { updatePersonProfilePartial, type PersonProfileFields } from './org';
import { setPersonComplianceFields } from './profile';
import { GENDERS, MARITAL_STATUSES } from '../lib/person-vocabulary';
import { todayInKualaLumpur } from '../lib/hr-date';
import { V9Error } from '../lib/lifecycle-v9-model';
import { lockLeaveDependencyConfigurationTx } from './leave-dependency-lock';
import { lockProfileValueWritesTx } from './access-configuration-lock';

const profileKeys: Record<string, keyof PersonProfileFields | 'phone'> = v9PersonnelProfileKeys;
const statutoryKeys: Record<string, string> = v9PersonnelStatutoryKeys;
export { v9PersonnelWritableKeys } from '../lib/lifecycle-v9-personnel-keys';
export async function lockV9PersonnelWritesTx(tx: Tx, ctx: SessionContext): Promise<void> {
  await tx.execute(sql`select app.access_configuration_write_lock()`);
  await lockLeaveDependencyConfigurationTx(tx, ctx.tenantId);
  await lockProfileValueWritesTx(tx, ctx.tenantId);
}
const title = (value: string | null) => value ? value[0].toUpperCase() + value.slice(1) : '';
async function subjectTx(tx: Tx, ctx: SessionContext, employmentId: string) {
  const [subject] = await tx.select({ id: employment.id, personId: employment.personId }).from(employment).where(and(eq(employment.id, employmentId), eq(employment.tenantId, ctx.tenantId), sql`app.is_admin_for(${employment.companyId}) OR (${!ctx.userId} AND (current_user='ai_hr_owner' OR EXISTS(select 1 from pg_roles where rolname=current_user and rolsuper)))`));
  if (!subject) throw new V9Error('Personnel record not available.', 'forbidden');
  return subject;
}
export async function readV9PersonnelTx(tx: Tx, ctx: SessionContext, employmentId: string): Promise<Record<string, string>> {
  const subject = await subjectTx(tx, ctx, employmentId);
  const day = todayInKualaLumpur();
  const supervisorUserId = sql<string | null>`(select case when count(distinct u.id)=1 then min(u.id::text) else null end
    from reporting_line r join employment manager on manager.id=r.manager_employment_id and manager.tenant_id=r.tenant_id
    join app_user u on u.person_id=manager.person_id and u.tenant_id=manager.tenant_id and u.archived_at is null and not app.login_blocked(u.id)
    where r.tenant_id=${ctx.tenantId}::uuid and r.subordinate_employment_id=${subject.id}::uuid and r.line_type='administrative'
      and r.superseded_at is null and r.valid_from<=${day}::date and (r.valid_to is null or r.valid_to>${day}::date))`;
  const [row] = await tx.select({ p: person, supervisorUserId, emName: primaryEmergencyContactSql('full_name'), emRel: primaryEmergencyContactSql('relationship'), emPhone: primaryEmergencyContactSql('mobile_phone') }).from(person).where(and(eq(person.id, subject.personId), eq(person.tenantId, ctx.tenantId)));
  if (!row) throw new V9Error('Personnel record not available.');
  const p = row.p;
  const address = p.address || [
    p.permanentAddressLine1, p.permanentAddressLine2, p.permanentAddressLine3,
    p.permanentPostcode, p.permanentCity, p.permanentState, p.permanentCountry,
  ].filter(Boolean).join(', ');
  const values: Record<string, string> = { name: p.fullName, email: p.primaryEmail, supervisorUserId: row.supervisorUserId ?? '', mobile: p.phone ?? '', homePhone: p.homePhone ?? '', personalEmail: p.personalEmail ?? '', address, race: p.race ?? '', religion: p.religion ?? '', nationality: p.nationality ?? '', gender: title(p.gender), marital: title(p.maritalStatus), emName: row.emName ?? '', emRel: row.emRel ?? '', emPhone: row.emPhone ?? '' };
  const statutory = await bankStatutorySubjectTx(tx, subject.id);
  if (statutory) {
    const state = await readBankStatutoryStateTx(tx, ctx, statutory);
    for (const [key, ownerKey] of Object.entries(statutoryKeys)) values[key] = state.state[ownerKey] ?? '';
    values.icNo = state.row?.icNumber ?? ''; values.passportNo = state.row?.passportNumber ?? '';
  }
  return values;
}
export async function pushV9PersonnelTx(tx: Tx, ctx: SessionContext, input: { employmentId: string; field: string; before: string; after: string }): Promise<'pushed' | 'conflict'> {
  const subject = await subjectTx(tx, ctx, input.employmentId);
  if (!v9PersonnelWritableKeys.includes(input.field)) throw new V9Error('This field needs a mapping review in Personnel Management before it can be applied.');
  await tx.execute(sql`select id from person where id=${subject.personId}::uuid and tenant_id=${ctx.tenantId}::uuid for update`);
  const values = await readV9PersonnelTx(tx, ctx, input.employmentId);
  if ((values[input.field] ?? '') !== input.before) return 'conflict';
  const profileKey = profileKeys[input.field];
  if (profileKey) await updatePersonProfilePartial(ctx, { personId: subject.personId, via: 'Lifecycle V9 reviewed form', [profileKey]: input.after || null }, tx);
  else if (input.field === 'gender' || input.field === 'marital') {
    const value = input.after.toLowerCase();
    if (value && !(input.field === 'gender' ? GENDERS : MARITAL_STATUSES).some(option => option === value)) throw new V9Error('Choose a Personnel-supported value before applying this change.');
    await setPersonComplianceFields(ctx, { employmentId: subject.id, [input.field === 'gender' ? 'gender' : 'maritalStatus']: value || null }, tx);
  } else {
    const statutory = await bankStatutorySubjectTx(tx, subject.id); if (!statutory) throw new V9Error('Country statutory record is unavailable.');
    const state = await readBankStatutoryStateTx(tx, ctx, statutory, { lock: true }), ownerKey = statutoryKeys[input.field];
    const patch = buildBankStatutoryPatch(key => key === ownerKey ? input.after : undefined, statutory, state.state);
    if (patch.errors.length) throw new V9Error(patch.errors.join(' '));
    await applyBankStatutoryPatchTx(tx, ctx, statutory, patch.patch);
  }
  return 'pushed';
}
