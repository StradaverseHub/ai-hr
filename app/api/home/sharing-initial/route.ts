import {getSession} from '@/lib/session';
import {getLocale,getTranslations} from 'next-intl/server';
import {isLocale} from '@/i18n/config';
import {OwnHomeConfigurationRead} from '@/core/employee-home-configuration';
import {readEmployeeHomeGreeting} from '@/core/employee-home-greeting';
import {readEmployeeHomeSummary} from '@/core/employee-home-summary';
import {OwnHomeTaskSourceRead,readEmployeeHomeTasks} from '@/core/employee-home-tasks';
import {validateEmployeeHomeSummary} from '@/lib/employee-home-summary';
import {
 DEFAULT_HOME_SHARING_CARDS,HOME_SHARING_MAX_FRAME_BYTES,isHomeSharingCard,HOME_SHARING_STREAM,type HomeSharingCard,type HomeSharingFrame,
} from '@/lib/employee-home-sharing-cohort';
import {celebrationsResponse,noticesResponse,sharingError,sharingHeaders,teamResponse,timeOffResponse} from '../sharing-responses';
import {greetingProjection,tasksProjection} from '../personal-projections';

/** One fresh web session and independent live reads for the requested Home cards. */
export async function GET(request:Request){
 try{
  const session=await getSession();
  const query=new URL(request.url).searchParams;
  const employmentId=query.get('employmentId');
  const selected=query.getAll('card');
  if(!employmentId||query.getAll('employmentId').length!==1||[...query.keys()].some(key=>key!=='employmentId'&&key!=='card')
    || (selected.length>0&&(selected.length<2||new Set(selected).size!==selected.length||!selected.every(isHomeSharingCard)))){
   return Response.json({error:'invalid'},{status:400,headers:sharingHeaders});
  }
  const cards:readonly HomeSharingCard[]=selected.length?selected.filter(isHomeSharingCard):DEFAULT_HOME_SHARING_CARDS;
  const configurationRead=new OwnHomeConfigurationRead(session,employmentId);
  const taskSourceRead=cards.includes('summary')&&cards.includes('tasks')?new OwnHomeTaskSourceRead(session,employmentId):undefined;
  const readLocale=async()=>{
   const value=await getLocale();
   if(!isLocale(value))throw Error('Home locale unavailable');
   return value;
  };
  let language:ReturnType<typeof readLocale>|undefined;
  const locale=()=>language??=readLocale();
  const readLifetime=new AbortController();
  const signal=readLifetime.signal;
  const readers:Record<HomeSharingCard,()=>Promise<unknown>>={
   team:()=>teamResponse(session,employmentId,{},signal),
   celebrations:()=>celebrationsResponse(session,employmentId,{},signal),
   notices:()=>noticesResponse(session,employmentId,signal),
   timeOff:()=>timeOffResponse(session,employmentId,signal),
   greeting:async()=>greetingProjection(await readEmployeeHomeGreeting(session,employmentId,await locale(),undefined,configurationRead)),
   summary:async()=>{
    const [language,t]=await Promise.all([locale(),getTranslations('employeeHome.calendar')]);
    const value=await readEmployeeHomeSummary(session,employmentId,language,t('replacement'),configurationRead,taskSourceRead);
    return validateEmployeeHomeSummary(value,employmentId);
   },
   tasks:async()=>tasksProjection(await readEmployeeHomeTasks(session,employmentId,1,configurationRead,taskSourceRead)),
  };
  const encoder=new TextEncoder();
  let detach=()=>{};
  const body=new ReadableStream<Uint8Array>({
   start(controller){
    let open=true;
    const stop=()=>{
     if(!open)return;
     open=false;
     request.signal.removeEventListener('abort',disconnect);
     controller.close();
    };
    const disconnect=()=>{readLifetime.abort();stop();};
    detach=()=>{readLifetime.abort();open=false;request.signal.removeEventListener('abort',disconnect);};
    if(request.signal.aborted){disconnect();return;}
    request.signal.addEventListener('abort',disconnect,{once:true});
    const reads=cards.map(async card=>{
     let encoded:Uint8Array;
     try{
      const value=await readers[card]();
      const frame:HomeSharingFrame={version:1,card,status:200,value};
      encoded=encoder.encode(JSON.stringify(frame)+'\n');
      if(encoded.byteLength>HOME_SHARING_MAX_FRAME_BYTES)throw new Error('Home sharing frame too large');
     }catch(error){
      const {status}=sharingError(error);
      const frame:HomeSharingFrame={version:1,card,status};
      encoded=encoder.encode(JSON.stringify(frame)+'\n');
     }
     if(open)controller.enqueue(encoded);
    });
    // Disconnect stops eligible readers at their next admission check and drops pending values.
    void Promise.allSettled(reads).then(stop);
   },
   cancel(){detach();},
  });
  return new Response(body,{headers:{...sharingHeaders,'Content-Type':HOME_SHARING_STREAM,'X-Accel-Buffering':'no'}});
 }catch(error){
  const {code,status}=sharingError(error);
  return Response.json({error:code},{status,headers:sharingHeaders});
 }
}
