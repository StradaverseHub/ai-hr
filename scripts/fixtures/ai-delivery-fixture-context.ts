/** Shared fictional fixture composition contract. This interface is not authority, admission,
 * module activation, a database target proof or evidence that any business fact exists. The guarded
 * parent entry must create and verify the actual actors before calling any populate helper. */
import type {createDb,SessionContext} from '../../db/client';
export type AiDeliveryFixtureActor={userId:string;personId:string;employmentId:string;ctx:SessionContext};
export type AiDeliveryFixtureContext={
 owner:ReturnType<typeof createDb>;tenantId:string;companyId:string;departmentId:string;
 /** Actual current Kuala Lumpur date and yyyy-MM period. Parent hires predate prior two months. */
 today:string;period:string;bootstrapCtx:SessionContext;
 actors:{operator:AiDeliveryFixtureActor;self:AiDeliveryFixtureActor;reviewers:readonly[AiDeliveryFixtureActor,AiDeliveryFixtureActor];peer:AiDeliveryFixtureActor;manager:AiDeliveryFixtureActor};
};
