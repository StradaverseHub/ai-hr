/** Direct Workforce commands for related registers. Own-profile/approved proposal owners remain
 * separate: their canonical register services do not accept a caller-controlled bypass flag. */
import {eq} from 'drizzle-orm';
import {withTenant, type SessionContext, type Tx} from '../db/client';
import {employeeDependent, employeeQualification, personEmergencyContact} from '../db/schema';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {assertWorkforceEmploymentTx, assertWorkforcePersonTx, WorkforceAccessError} from './workforce-access';
import * as family from './dependents';
import * as qualifications from './qualifications';
import * as contacts from './emergency-contacts';

type Register = 'dependent' | 'qualification' | 'emergency';
async function existingSubject(tx: Tx, kind: Register, id: string) {
  if (kind === 'qualification') {
    const [row] = await tx.select({id: employeeQualification.employmentId}).from(employeeQualification).where(eq(employeeQualification.id, id)).limit(1);
    return row?.id;
  }
  if (kind === 'dependent') {
    const [row] = await tx.select({id: employeeDependent.personId}).from(employeeDependent).where(eq(employeeDependent.id, id)).limit(1);
    return row?.id;
  }
  const [row] = await tx.select({id: personEmergencyContact.personId}).from(personEmergencyContact).where(eq(personEmergencyContact.id, id)).limit(1);
  return row?.id;
}
async function maintain<T>(ctx: SessionContext, kind: Register, target: {id: string; existing: boolean}, write: (tx: Tx) => Promise<T>, outerTx?: Tx) {
  const run = async (tx: Tx) => {
    await lockAccessConfigurationTx(tx, ctx.tenantId);
    // A record id from a form/import never selects a different subject from the stored relationship.
    const subject = target.existing ? await existingSubject(tx, kind, target.id) : target.id;
    if (!subject) throw new WorkforceAccessError();
    if (kind === 'qualification') await assertWorkforceEmploymentTx(tx, ctx, subject, 'maintain');
    else await assertWorkforcePersonTx(tx, ctx, subject, 'maintain');
    return write(tx);
  };
  return outerTx ? run(outerTx) : withTenant(ctx, run);
}

export function addDependent(ctx: SessionContext, p: Parameters<typeof family.addDependent>[1], outerTx?: Tx) {
  return maintain(ctx, 'dependent', {id: p.personId, existing: false}, tx => family.addDependent(ctx, p, tx), outerTx);
}
export function updateDependent(ctx: SessionContext, p: Parameters<typeof family.updateDependent>[1], outerTx?: Tx) {
  return maintain(ctx, 'dependent', {id: p.id, existing: true}, tx => family.updateDependent(ctx, p, tx), outerTx);
}
export function archiveDependent(ctx: SessionContext, p: Parameters<typeof family.archiveDependent>[1], outerTx?: Tx) {
  return maintain(ctx, 'dependent', {id: p.id, existing: true}, tx => family.archiveDependent(ctx, p, tx), outerTx);
}
export function addQualification(ctx: SessionContext, p: Parameters<typeof qualifications.addQualification>[1], outerTx?: Tx) {
  return maintain(ctx, 'qualification', {id: p.employmentId, existing: false}, tx => qualifications.addQualification(ctx, p, tx), outerTx);
}
export function updateQualification(ctx: SessionContext, p: Parameters<typeof qualifications.updateQualification>[1], outerTx?: Tx) {
  return maintain(ctx, 'qualification', {id: p.id, existing: true}, tx => qualifications.updateQualification(ctx, p, tx), outerTx);
}
export function archiveQualification(ctx: SessionContext, p: Parameters<typeof qualifications.archiveQualification>[1], outerTx?: Tx) {
  return maintain(ctx, 'qualification', {id: p.id, existing: true}, tx => qualifications.archiveQualification(ctx, p, tx), outerTx);
}
export function addEmergencyContact(ctx: SessionContext, p: Parameters<typeof contacts.addEmergencyContact>[1], outerTx?: Tx) {
  return maintain(ctx, 'emergency', {id: p.personId, existing: false}, tx => contacts.addEmergencyContact(ctx, p, tx), outerTx);
}
export function updateEmergencyContact(ctx: SessionContext, p: Parameters<typeof contacts.updateEmergencyContact>[1], outerTx?: Tx) {
  return maintain(ctx, 'emergency', {id: p.id, existing: true}, tx => contacts.updateEmergencyContact(ctx, p, tx), outerTx);
}
export function archiveEmergencyContact(ctx: SessionContext, p: Parameters<typeof contacts.archiveEmergencyContact>[1], outerTx?: Tx) {
  return maintain(ctx, 'emergency', {id: p.id, existing: true}, tx => contacts.archiveEmergencyContact(ctx, p, tx), outerTx);
}
