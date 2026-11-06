import {getSession} from '@/lib/session';
import {
 DEFAULT_HOME_SHARING_CARDS,HOME_SHARING_MAX_FRAME_BYTES,isHomeSharingCard,HOME_SHARING_STREAM,type HomeSharingFrame,
} from '@/lib/employee-home-sharing-cohort';
import {celebrationsResponse,noticesResponse,sharingError,sharingHeaders,teamResponse,timeOffResponse} from '../sharing-responses';

const readers={team:teamResponse,celebrations:celebrationsResponse,notices:noticesResponse,timeOff:timeOffResponse};

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
  const cards=selected.length?selected.filter(isHomeSharingCard):DEFAULT_HOME_SHARING_CARDS;
  const encoder=new TextEncoder();
  let detach=()=>{};
  const body=new ReadableStream<Uint8Array>({
   start(controller){
    let open=true;
    const stop=()=>{
     if(!open)return;
     open=false;
     request.signal.removeEventListener('abort',stop);
     controller.close();
    };
    detach=()=>{open=false;request.signal.removeEventListener('abort',stop);};
    if(request.signal.aborted){stop();return;}
    request.signal.addEventListener('abort',stop,{once:true});
    const reads=cards.map(async card=>{
     let encoded:Uint8Array;
     try{
      const value=await readers[card](session,employmentId);
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
    // A disconnected response drops pending values. Current native owners do not accept AbortSignal.
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
