import { ClockPanel } from '../../lib/clock-panel';
import { Screen,Title } from '../../lib/ui';
import { t } from '../../lib/i18n';
export default function Clock(){return <Screen><Title>{t('tabClock')}</Title><ClockPanel/></Screen>;}
