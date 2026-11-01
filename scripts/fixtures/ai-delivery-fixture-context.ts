/** Shared fictional fixture composition contract. This interface is not authority, admission,
 * module activation, a database target proof or evidence that any business fact exists. The guarded
 * parent entry must create and verify the actual actors before calling any populate helper. */
import type {createDb,SessionContext} from '../../db/client';
/** Relative fixture dates share one chronology. Close only a month before BOTH past attendance
 * dates, including at month/year boundaries; native closed-payroll protections remain authoritative. */
export function aiDeliveryFixtureCalendar(today:string){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(today)||new Date(today+'T12:00:00Z').toISOString().slice(0,10)!==today)throw Error('A valid declared fixture day is required.');
 const before=(days:number)=>{const date=new Date(today+'T12:00:00Z');date.setUTCDate(date.getUTCDate()-days);return date.toISOString().slice(0,10);};
 const correctionDate=before(2),weekday=new Date(today+'T12:00:00Z').getUTCDay(),workedDate=before(weekday||7);
 const earliest=correctionDate<workedDate?correctionDate:workedDate,release=new Date(earliest.slice(0,7)+'-01T12:00:00Z');
 release.setUTCMonth(release.getUTCMonth()-1);
 return{correctionDate,workedDate,releasedPeriod:release.toISOString().slice(0,7)};
}
export type AiDeliveryFixtureActor={userId:string;personId:string;employmentId:string;ctx:SessionContext};
export type AiDeliveryFixtureContext={
 owner:ReturnType<typeof createDb>;tenantId:string;companyId:string;departmentId:string;
 /** Actual current Kuala Lumpur date and yyyy-MM period. Parent hires predate prior two months. */
 today:string;period:string;bootstrapCtx:SessionContext;
 actors:{operator:AiDeliveryFixtureActor;self:AiDeliveryFixtureActor;reviewers:readonly[AiDeliveryFixtureActor,AiDeliveryFixtureActor];peer:AiDeliveryFixtureActor;manager:AiDeliveryFixtureActor};
};
