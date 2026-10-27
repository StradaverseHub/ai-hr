import {Redirect} from 'expo-router';
import {useSession} from '../lib/session';
import {IntegrityKeys} from '../lib/integrity-keys';
export default function IntegrityKeysPage(){
  return useSession().status==='signedIn'?<IntegrityKeys/>:<Redirect href="/sign-in"/>;
}
