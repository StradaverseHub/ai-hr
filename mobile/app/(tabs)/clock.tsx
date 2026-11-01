import { QuickActions } from '../../lib/home-hero';
import { ClockPanel } from '../../lib/clock-panel';
import { Screen,Title } from '../../lib/ui';
import { t } from '../../lib/i18n';
export default function Clock(){return <Screen atmospheric><Title>{t('tabClock')}</Title><ClockPanel afterControls={<QuickActions actions={[{key:'attendance',icon:'attendance',label:'qaAttendance',href:'/attendance'},{key:'overtime',icon:'overtime',label:'qaOtPlan',href:'/attendance/ot-plan'},{key:'calendar',icon:'teamCalendar',label:'qaTeamCalendar',href:'/team-calendar'}]}/>}/></Screen>;}
