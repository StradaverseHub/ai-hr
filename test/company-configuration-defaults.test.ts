import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { createCompany } from '../core/admin';
import { companyStatutoryMy } from '../db/schema';
import { packFor } from '../localization/registry';
import { hrdfLevy } from '../localization/my/payroll';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
it('persists the 1% HRDF band for a newly created MY company and allows a later authorised change',async()=>{
 const ctx=adminCtx(b),created=await createCompany(ctx,{legalName:'New MY company',country:'MY'});
 const [saved]=await owner.db.select().from(companyStatutoryMy).where(eq(companyStatutoryMy.companyId,created.id));
 expect(saved.hrdfStatus).toBe('mandatory');
 expect(hrdfLevy(1000,saved.hrdfStatus)).toBe(10);
 const pack=packFor('MY')!;
 expect((await pack.companyStatutory.get(ctx,created.id))?.hrdfStatus).toBe('mandatory');
 await pack.companyStatutory.set(ctx,{companyId:created.id,hrdfStatus:'optional'});
 await pack.companyStatutory.set(ctx,{companyId:created.id,epfEmployerNo:'NEW-EPF'});
 expect(await pack.companyStatutory.get(ctx,created.id)).toMatchObject({hrdfStatus:'optional',epfEmployerNo:'NEW-EPF'});
});
it('never applies the creation default to an existing MY company during a later partial configuration save',async()=>{
 const ctx=adminCtx(b),pack=packFor('MY')!;
 await pack.companyStatutory.set(ctx,{companyId:b.companyId,hrdfStatus:'not_registered'});
 await createCompany(ctx,{legalName:'Another MY company'});
 await pack.companyStatutory.set(ctx,{companyId:b.companyId,ssmRegistrationNo:'SSM-KEPT'});
 expect(await pack.companyStatutory.get(ctx,b.companyId)).toMatchObject({hrdfStatus:'not_registered',ssmRegistrationNo:'SSM-KEPT'});
});
it('does not create a MY statutory row for a new non-MY non-statutory company',async()=>{
 const created=await createCompany(adminCtx(b),{legalName:'Non-MY company',country:'TH',nonStatutory:true});
 expect(await owner.db.select().from(companyStatutoryMy).where(eq(companyStatutoryMy.companyId,created.id))).toHaveLength(0);
});
