import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {withSharedReadSnapshot} from '@/db/client';
import {requestReadScope} from '@/lib/request-read-scope';
import {readEmployeeHomeGreetingIdentity} from '@/core/employee-home';
import {viewerIdentity} from '@/lib/viewer';
import {greetingFor,greetingName} from '@/lib/today/audience';

// The greeting every Today page draws (Employee, Manager and Admin Today). The earlier Today page this file held, with
// the old dashboard under "More", was retired with that dashboard (owner decision, 12 Nov 2026).
/** The viewer's given name: the salary-free Home identity for someone with an own employment, otherwise the
 * name the top bar already shows. Never blocks the greeting: no name, or a failed read, keeps "Good morning". */
export async function GreetingWithName({session,employmentId,period}:{session:SessionContext;employmentId?:string;period:ReturnType<typeof greetingFor>}){
 const t=await getTranslations('today');
 const name=await withSharedReadSnapshot(session,()=>readEmployeeHomeGreetingIdentity(session,employmentId),undefined,requestReadScope()).then(identity=>identity.name)
  .catch(()=>viewerIdentity(session).then(viewer=>viewer.name)).catch(()=>null);
 const first=greetingName(name);
 return first?t(`${period}Name`,{name:first}):t(period);
}
