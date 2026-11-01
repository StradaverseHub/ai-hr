import {useLocalSearchParams} from 'expo-router';
import { QuickActions } from '../../lib/home-hero';
import { ClockPanel } from '../../lib/clock-panel';
import { Screen,Title } from '../../lib/ui';
import { t } from '../../lib/i18n';
export default function Clock(){const params=useLocalSearchParams<{widgetAction:string;widgetIntent:string;widgetEmployment:string}>();const initialAction=params.widgetAction==='in'||params.widgetAction==='out'?params.widgetAction:undefined;return <Screen atmospheric><Title>{t('tabClock')}</Title><ClockPanel initialAction={initialAction} widgetEmployment={typeof params.widgetEmployment==='string'?params.widgetEmployment:undefined} widgetIntent={typeof params.widgetIntent==='string'?params.widgetIntent:undefined} afterControls={<QuickActions actions={[{key:'attendance',icon:'attendance',label:'qaAttendance',href:'/attendance'},{key:'overtime',icon:'overtime',label:'qaOtPlan',href:'/attendance/ot-plan'},{key:'calendar',icon:'teamCalendar',label:'qaTeamCalendar',href:'/team-calendar'}]}/>}/></Screen>;}
