import { requireModule } from '@/lib/authz';
import { onboardingMyAcknowledgement } from '@/packs/lifecycle/service';
import { DeviceAcknowledgement } from './form';
export default async function Page(){const s=await requireModule('lifecycle');return <DeviceAcknowledgement view={await onboardingMyAcknowledgement(s)}/>;}
