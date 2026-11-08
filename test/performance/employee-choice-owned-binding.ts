/** Pure exact disposable-worker binding; no driver/application imports. */
import {workerDb} from '../db-names';
export function employeeChoiceOwnedUrl(raw:string,role:'postgres'|'ai_hr_app',name:string,kind:'work'|'cleanup'|'native-control'='work',env:NodeJS.ProcessEnv=process.env){
 const url=new URL(raw),pool=env.VITEST_POOL_ID??env.VITEST_WORKER_ID;
 if(!['work','cleanup','native-control'].includes(kind)||!['postgres:','postgresql:'].includes(url.protocol)||url.port!=='5433'||!pool||!(/^[1-9][0-9]*$/).test(pool)||url.hostname!=='127.0.0.1'||url.pathname!=='/'+workerDb(pool)||url.username!==role||url.password||url.search||url.hash)throw Error('Exact owned employee benchmark worker required');
 url.searchParams.set('connect_timeout','3');url.searchParams.set('statement_timeout',kind==='work'?'20000':'1000');url.searchParams.set('lock_timeout','300');url.searchParams.set('application_name',name);
 return url.href;
}
