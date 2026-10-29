import {useLocalSearchParams} from 'expo-router';
import {PendingSubmissions} from '../lib/pending-submissions';
export default function PendingSubmissionsPage(){
  const {intent}=useLocalSearchParams<{intent?:string}>();
  return <PendingSubmissions intent={intent==='logout'||intent==='company'?intent:'review'}/>;
}
