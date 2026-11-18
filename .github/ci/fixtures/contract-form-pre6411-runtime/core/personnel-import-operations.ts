/** Import calls the same operational field owners as Personnel, in its explicit enclosing transaction. */
import type {SessionContext,Tx} from '../db/client';
import {setEmploymentCardId} from './attendance-card';
import {setEmploymentPaymentMethod} from './org';
import {setAttendancePhotoSetting} from '../packs/attendance/service';
import type {PersonnelOperationalPatch} from '../lib/personnel-operational-import';
export async function applyPersonnelOperationalValuesTx(tx:Tx,ctx:SessionContext,employmentId:string,values:PersonnelOperationalPatch) {
 if(values.cardId!==undefined)await setEmploymentCardId(ctx,{employmentId,cardId:values.cardId},tx);
 if(values.attendancePhotoSetting!==undefined)await setAttendancePhotoSetting(ctx,{employmentId,setting:values.attendancePhotoSetting},tx);
 if(values.paymentMethod!==undefined)await setEmploymentPaymentMethod(ctx,{employmentId,paymentMethod:values.paymentMethod},tx);
}
