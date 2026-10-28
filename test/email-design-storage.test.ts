/** Native database authority and immutable history. Run only after the allocated migration is journaled. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import * as schema from '../db/schema';
import {listEmailDesigns,saveEmailDesign,emailDesignHistory,uploadEmailAsset} from '../core/email-design/service';
import {defaultEmailDocument} from '../lib/email-design/model';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();admin=await entitledCtx(b);});afterAll(closeAll);
describe('email design native ownership',()=>{
 it('records immutable versions and restores by appending, never rewriting an earlier version',async()=>{
  const first={...defaultEmailDocument('invitation'),subject:'Fictional subject one'},second={...first,subject:'Fictional subject two'};
  expect(await saveEmailDesign(admin,'invitation','en',first,0)).toBe(1);
  expect(await saveEmailDesign(admin,'invitation','en',second,1)).toBe(2);
  const history=await emailDesignHistory(admin,'invitation','en');expect(history.map(row=>row.revision)).toEqual([2,1]);expect(history[1].document).toEqual(first);
  expect(await saveEmailDesign(admin,'invitation','en',history[1].document,2)).toBe(3);
  expect((await listEmailDesigns(admin))[0]).toMatchObject({revision:3,document:first,updatedBy:admin.userId});
  await expect(owner.db.execute(sql`update email_design_version set document=null where tenant_id=${b.tenantId}::uuid`)).rejects.toThrow();
  await expect(saveEmailDesign(admin,'invitation','en',second,1)).rejects.toThrow();
  expect((await emailDesignHistory(admin,'invitation','en')).map(row=>row.revision)).toEqual([3,2,1]);
 });
 it('keeps tenants separate, refuses ordinary users and denies direct execution of the private delivery reader',async()=>{
  await saveEmailDesign(admin,'invitation','en',defaultEmailDocument('invitation'),0);
  const foreign=await seedBase(),foreignAdmin=await entitledCtx(foreign);expect(await listEmailDesigns(foreignAdmin)).toEqual([]);
  const [user]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'fictional_email_'+randomUUID()}).returning({id:schema.appUser.id});
  await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'employee',companyId:b.companyId});
  const employee={...admin,userId:user.id,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
  await expect(listEmailDesigns(employee)).rejects.toThrow();await expect(saveEmailDesign(employee,'invitation','en',null,1)).rejects.toThrow();
  await expect(withTenant(employee,tx=>tx.execute(sql`select app.email_design_delivery(${foreign.tenantId}::uuid,'invitation','en')`))).rejects.toThrow();
  expect(await withTenant(foreignAdmin,tx=>tx.execute(sql`select * from email_design where tenant_id=${b.tenantId}::uuid`))).toEqual([]);
 });
 it('restoring default does not copy another language’s customized wording',async()=>{
  await saveEmailDesign(admin,'invitation','en',{...defaultEmailDocument('invitation'),subject:'Fictional English design'},0);
  await saveEmailDesign(admin,'invitation','ms',defaultEmailDocument('invitation'),0);
  await saveEmailDesign(admin,'invitation','ms',null,1);
  const rows=await listEmailDesigns(admin);expect(rows.find(row=>row.locale==='en')?.document?.subject).toBe('Fictional English design');expect(rows.find(row=>row.locale==='ms')?.document).toBeNull();
 });
 it('stores validated image bytes behind an opaque token while table access stays tenant-scoped',async()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=','base64'),token=await uploadEmailAsset(admin,'image/png',png);
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  const rows=await withTenant(admin,tx=>tx.execute<{mime:string;bytes:Buffer}>(sql`select * from app.email_asset_read(${token})`));expect(rows).toHaveLength(1);expect(rows[0].mime).toBe('image/png');expect(Buffer.from(rows[0].bytes)).toEqual(png);
 });
});
