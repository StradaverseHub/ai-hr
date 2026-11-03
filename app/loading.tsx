import RouteLoading from '@/components/route-loading';
import {RootLoadingSwitch} from '@/components/today/loading-switch';
import {TodaySkeleton} from '@/components/today/today-skeleton';

/** `/` is Today (components/today/today-page.tsx): its own skeleton there, the shared shell everywhere else. */
export default function Loading(){
 return <RootLoadingSwitch today={<TodaySkeleton/>} fallback={<RouteLoading/>}/>;
}
