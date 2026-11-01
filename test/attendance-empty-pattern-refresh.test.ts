/** Empty automatic formula refresh must not perform a physical no-op Attendance write. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {checkIn,refreshOvertimePatternDayTx} from '../packs/attendance/service';
import {lockAttendanceLeaveDependenciesTx} from '../core/attendance';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it.each([false,true])('avoids empty marker writes but still removes an existing stale key (existing key: %s)',async existingKey=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'attendance','active');const ctx=await entitledCtx(b),date=todayInKualaLumpur();
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional empty pattern subject',primaryEmail:randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 await checkIn(ctx,{employmentId:hired.employmentId,date,time:'08:00'});
 const [day]=await owner.db.select().from(s.attendance).where(eq(s.attendance.employmentId,hired.employmentId));expect(day).toBeDefined();
 if(existingKey)await owner.client`update attendance set calc_trace=coalesce(calc_trace,'{}'::jsonb)||'{"overtimePattern":null}'::jsonb where id=${day.id}::uuid`;
 await owner.client.unsafe(`create function public.test_empty_pattern_write() returns trigger language plpgsql as $body$ begin if old.id='${day.id}'::uuid and not coalesce(old.calc_trace ? 'overtimePattern',false) then raise exception 'Unexpected physical empty overtime marker write';end if;return new;end $body$;create trigger test_empty_pattern_write before update of calc_trace on attendance for each row execute function public.test_empty_pattern_write()`);
 try{
  await expect(withTenant(ctx,async tx=>{
   await lockAttendanceLeaveDependenciesTx(tx,ctx,[hired.employmentId]);
   await tx.execute(sql`select id from attendance where id=${day.id}::uuid for update`);
   return refreshOvertimePatternDayTx(tx,ctx,{employmentId:hired.employmentId,date,reason:'Fictional empty refresh'});
  })).resolves.toBeNull();
 }finally{await owner.client.unsafe('drop trigger test_empty_pattern_write on attendance;drop function public.test_empty_pattern_write()');}
 const [after]=await owner.db.select().from(s.attendance).where(eq(s.attendance.id,day.id));
 expect(after.calcTrace).toEqual(day.calcTrace);expect(after.checkInAt).toBe(day.checkInAt);expect(after.checkOutAt).toBe(day.checkOutAt);
});
