import {randomUUID,createHash} from 'node:crypto';
import {afterAll,beforeEach,it,expect} from 'vitest';
import {eq} from 'drizzle-orm';
import * as s from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {readLetterEmailPreferences,saveLetterEmailPreferences} from '../core/letter-email-preferences';
import {saveNotificationEmailPolicy,saveNotificationEmailPreferences} from '../core/notification-email';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext;
const identity={issuer:'https://identity.fixture.test/realms/letters',subject:'account-letter-recipient',email:'letters-account@fixture.test',emailVerified:true};
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'notifications','active');const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional account recipient',primaryEmail:identity.email}).returning();
 const userId=await createAppUser(b.tenantId,person.id,'employee');ctx={...await entitledCtx(b,['employee']),userId,personId:person.id};await owner.db.insert(s.appExternalIdentity).values({issuer:identity.issuer,subject:identity.subject,appUserId:userId});
});afterAll(closeAll);
async function event(){const [row]=await owner.db.insert(s.domainEvent).values({tenantId:b.tenantId,aggregateType:'fixture',aggregateId:randomUUID(),eventType:'fixture.consent-cutoff',actorType:'system'}).returning();return row;}
it('stores one verified account preference without inventing employment and keeps an exact opt-in cutoff',async()=>{
 expect(await owner.db.select().from(s.employment).where(eq(s.employment.personId,ctx.personId!))).toHaveLength(0);expect(await readLetterEmailPreferences(ctx)).toEqual({preference:null,current:false,enabledByPolicy:false});const previous=await event();
 await saveLetterEmailPreferences(ctx,{enabled:true,locale:'en'},identity);const first=(await readLetterEmailPreferences(ctx)).preference!;
 expect(first).toMatchObject({recipientEmploymentId:null,recipientUserId:ctx.userId,category:'letters',channel:'email',enabled:true,emailConsentUserId:ctx.userId,emailConsentIssuer:identity.issuer,emailConsentSubject:identity.subject,emailAfterSequence:previous.sequence,emailLocale:'en',emailConsentAddressHash:createHash('sha256').update(identity.email).digest('hex')});expect(first.emailConsentVerifiedAt).toBeInstanceOf(Date);
 await event();await saveLetterEmailPreferences(ctx,{enabled:true,locale:'ms'},identity);const retained=(await readLetterEmailPreferences(ctx)).preference!;expect(retained.emailAfterSequence).toBe(first.emailAfterSequence);expect(retained.emailConsentVerifiedAt).toEqual(first.emailConsentVerifiedAt);expect(retained.emailLocale).toBe('ms');
 await withTenant(ctx,tx=>tx.update(s.notificationPref).set({emailAfterSequence:0}).where(eq(s.notificationPref.id,first.id)));expect((await readLetterEmailPreferences(ctx)).preference!.emailAfterSequence).toBe(first.emailAfterSequence);
 await saveLetterEmailPreferences(ctx,{enabled:false,locale:'ms'},null);expect((await readLetterEmailPreferences(ctx)).preference).toMatchObject({enabled:false,emailConsentUserId:null,emailAfterSequence:null,emailConsentIssuer:null,emailConsentSubject:null,emailConsentAddressHash:null,emailConsentVerifiedAt:null});
 await expect(saveLetterEmailPreferences(ctx,{enabled:true,locale:'en'},null)).rejects.toMatchObject({code:'identityRequired'});await saveLetterEmailPreferences(ctx,{enabled:true,locale:'th'},identity);const renewed=(await readLetterEmailPreferences(ctx)).preference!;expect(renewed.emailAfterSequence).toBeGreaterThan(first.emailAfterSequence!);expect(await owner.db.select().from(s.notificationPref).where(eq(s.notificationPref.recipientUserId,ctx.userId!))).toHaveLength(1);
});
it('rejects mismatched identity proof and cannot read or create consent for another account',async()=>{
 for(const proof of [null,{...identity,emailVerified:false},{...identity,subject:'another-subject'},{...identity,email:'other-address@fixture.test'}])await expect(saveLetterEmailPreferences(ctx,{enabled:true,locale:'en'},proof)).rejects.toMatchObject({code:'identityRequired'});
 await saveLetterEmailPreferences(ctx,{enabled:true,locale:'en'},identity);
 const [otherPerson]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional other account',primaryEmail:'other-account@fixture.test'}).returning(),otherId=await createAppUser(b.tenantId,otherPerson.id,'employee'),other={...ctx,userId:otherId,personId:otherPerson.id};
 expect(await withTenant(other,tx=>tx.select().from(s.notificationPref).where(eq(s.notificationPref.recipientUserId,ctx.userId!)))).toHaveLength(0);
 await expect(withTenant(other,tx=>tx.insert(s.notificationPref).values({tenantId:b.tenantId,recipientUserId:ctx.userId!,category:'letters',channel:'email',enabled:true,emailConsentIssuer:identity.issuer,emailConsentSubject:identity.subject,emailConsentAddressHash:createHash('sha256').update(identity.email).digest('hex')}))).rejects.toThrow();
});
it('preserves withdrawal during provider failure but refuses stale bindings and gives rebinding a fresh cutoff',async()=>{
 await saveLetterEmailPreferences(ctx,{enabled:true,locale:'en'},identity);const first=(await readLetterEmailPreferences(ctx)).preference!;await saveLetterEmailPreferences(ctx,{enabled:true,locale:'zh'},null);expect((await readLetterEmailPreferences(ctx)).preference!.emailAfterSequence).toBe(first.emailAfterSequence);
 const email='changed-account@fixture.test';await owner.db.update(s.person).set({primaryEmail:email}).where(eq(s.person.id,ctx.personId!));await expect(saveLetterEmailPreferences(ctx,{enabled:true,locale:'en'},null)).rejects.toMatchObject({code:'identityRequired'});
 await saveLetterEmailPreferences(ctx,{enabled:true,locale:'en'},{...identity,email});expect((await readLetterEmailPreferences(ctx)).preference!.emailAfterSequence).toBeGreaterThan(first.emailAfterSequence!);
 await owner.db.update(s.appExternalIdentity).set({revokedAt:new Date()}).where(eq(s.appExternalIdentity.appUserId,ctx.userId!));await expect(saveLetterEmailPreferences(ctx,{enabled:true,locale:'en'},null)).rejects.toMatchObject({code:'identityRequired'});await saveLetterEmailPreferences(ctx,{enabled:false,locale:'en'},null);expect((await readLetterEmailPreferences(ctx)).preference!.enabled).toBe(false);
});
it('keeps tenant policy, module availability, and legacy employment preferences separate',async()=>{
 await saveNotificationEmailPolicy(await entitledCtx(b),['letters']);expect((await readLetterEmailPreferences(ctx)).enabledByPolicy).toBe(true);await expect(saveNotificationEmailPreferences(ctx,randomUUID(),['letters'],'en',identity)).rejects.toMatchObject({code:'invalid'});
 await saveLetterEmailPreferences(ctx,{enabled:false,locale:'en'},null);const events=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.eventType,'notification-email.letter-consent-changed'));expect(events).toHaveLength(1);expect(events[0].payload).toEqual({enabled:false,locale:'en'});
 await setModule(b.tenantId,'notifications',null);ctx={...ctx,entitlements:(await entitledCtx(b)).entitlements};await expect(readLetterEmailPreferences(ctx)).rejects.toMatchObject({code:'notAvailable'});await expect(saveLetterEmailPreferences(ctx,{enabled:true,locale:'en'},identity)).rejects.toMatchObject({code:'notAvailable'});
});
