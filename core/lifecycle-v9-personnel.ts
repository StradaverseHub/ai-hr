/** Personnel owns these values and writers; lifecycle stores reviewed proposals and source snapshots. */
import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { person, employment } from '../db/schema';
import { primaryEmergencyContactSql } from './emergency-contacts';
import { bankStatutorySubjectTx, readBankStatutoryStateTx, applyBankStatutoryPatchTx, buildBankStatutoryPatch } from './bank-statutory-import';
import { updatePersonProfilePartial, type PersonProfileFields } from './org';
import { setPersonComplianceFields } from './profile';
import { GENDERS, MARITAL_STATUSES } from '../lib/person-vocabulary';
import { V9Error } from '../lib/lifecycle-v9-model';
import { lockLeaveDependencyConfigurationTx } from './leave-dependency-lock';
import { lockProfileValueWritesTx } from './access-configuration-lock';

const profileKeys: Record<string, keyof PersonProfileFields | 'phone'> = { mobile: 'phone', homePhone: 'homePhone', personalEmail: 'personalEmail', race: 'race', religion: 'religion', nationality: 'nationality', emName: 'emergencyContactName', emRel: 'emergencyContactRelationship', emPhone: 'emergencyContactPhone' };
const statutoryKeys: Record<string, string> = { bankName: 'bank_name', bankAcc: 'bank_account_no', epfNo: 'epf_number', taxNo: 'tax_number' };
export const v9PersonnelWritableKeys = [...Object.keys(profileKeys), ...Object.keys(statutoryKeys), 'gender', 'marital'];
export async function lockV9PersonnelWritesTx(tx: Tx, ctx: SessionContext): Promise<void> {
  await tx.execute(sql`select app.access_workforce_write_lock()`);
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
  const [row] = await tx.select({ p: person, emName: primaryEmergencyContactSql('full_name'), emRel: primaryEmergencyContactSql('relationship'), emPhone: primaryEmergencyContactSql('mobile_phone') }).from(person).where(and(eq(person.id, subject.personId), eq(person.tenantId, ctx.tenantId)));
  if (!row) throw new V9Error('Personnel record not available.');
  const p = row.p, values: Record<string, string> = { name: p.fullName, email: p.primaryEmail, mobile: p.phone ?? '', homePhone: p.homePhone ?? '', personalEmail: p.personalEmail ?? '', address: p.address ?? '', race: p.race ?? '', religion: p.religion ?? '', nationality: p.nationality ?? '', gender: title(p.gender), marital: title(p.maritalStatus), emName: row.emName ?? '', emRel: row.emRel ?? '', emPhone: row.emPhone ?? '' };
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
