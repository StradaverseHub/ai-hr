import { captureNativeClock, ClockIntegrityRequiredError, ClockPolicyUnavailableError, ownClockToday, deviceGateRequired, ClockConflictError, CorrectedClockConflictError, ClockLocationError, AttendancePhotoRequiredError, OutsideGeofenceError, GeolocationRequiredError,GeofenceQualityError, DeviceNotRegisteredError } from '@/packs/attendance/service';
import { isModuleEnabled } from '@/core/entitlements';
import { ClockResponse, ClockResult, ClockCommand } from '@/lib/mobile-api/contract';
import { mobileRoute, MobileBadRequest, MobileServiceUnavailable } from '@/lib/mobile-api/handler';
import { mobileEmployment } from '@/lib/mobile-api/request';
import { ClockPhotoError } from '@/lib/attendance-photo';
import { mobileForm } from '@/lib/mobile-api/body';
export const GET = mobileRoute(ClockResponse,async(s,req)=>{
  const employmentId=await mobileEmployment(s,req);
  const enabled=isModuleEnabled(s,'attendance');
  if(!enabled||!employmentId)return {enabled,employmentId,state:null};
  const [state,deviceRequired]=await Promise.all([ownClockToday(s,undefined,employmentId),deviceGateRequired(s,employmentId)]);
  return {enabled,employmentId,state:{...state,deviceRequired,captures:state.captures.map(c=>({...c,date:state.date}))}};
});
export const POST = mobileRoute(ClockResult,async(s,req):Promise<ClockResult>=>{
  const employmentId=await mobileEmployment(s,req);
  if(!employmentId)throw new MobileBadRequest('No own employment');
  const data=await mobileForm(req,['command','photo'],3*1024*1024);
  let command:ReturnType<typeof ClockCommand.parse>;
  try{command=ClockCommand.parse(JSON.parse(String(data.get('command'))));}catch{throw new MobileBadRequest('Invalid command');}
  const file=data.get('photo');
  if(file!=null&&!(file instanceof File))throw new MobileBadRequest('Invalid photo');
  try{
    const receipt=await captureNativeClock(s,{...command,employmentId,...(file instanceof File ? {photo:Buffer.from(await file.arrayBuffer()),mime:file.type}: {})});
    return {outcome:'accepted' as const,receipt};
  }catch(e){
    if(e instanceof ClockPolicyUnavailableError)throw new MobileServiceUnavailable();
    if(e instanceof ClockIntegrityRequiredError)return {outcome:'refused',code:'integrity_required'};
    if(e instanceof GeofenceQualityError)return {outcome:'refused',code:'location_required',locationReason:e.assessment.outcome==='poor_accuracy'?'poor_accuracy':e.assessment.outcome==='invalid_location'?'invalid_location':'location_required'};
    const code=e instanceof CorrectedClockConflictError?'corrected_day':e instanceof ClockConflictError?'clock_conflict':e instanceof AttendancePhotoRequiredError?'photo_required':e instanceof OutsideGeofenceError?'outside_geofence':e instanceof ClockLocationError||e instanceof GeolocationRequiredError?'location_required':e instanceof DeviceNotRegisteredError?'device_required':null;
    if(code)return {outcome:'refused' as const,code,...(e instanceof OutsideGeofenceError&&e.info.reason?{locationReason:e.info.reason}:{})};
    if(e instanceof ClockPhotoError)return {outcome:'refused' as const,code:'photo_invalid' as const};
    throw e;
  }
});
