import { ClockPanel } from '../../lib/clock-panel';
import { Screen,Title } from '../../lib/ui';
import { t } from '../../lib/i18n';
export default function Clock(){return <Screen atmospheric><Title>{t('tabClock')}</Title><ClockPanel/></Screen>;}
