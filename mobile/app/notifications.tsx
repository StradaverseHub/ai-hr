/** Me → This phone → Notifications: the full push control (mobile/lib/push.tsx PushPrompt) with its explanation. */
import { t } from '../lib/i18n';
import { PushPrompt } from '../lib/push';
import { Screen, Title } from '../lib/ui';
export default function NotificationsSettings() {
  return <Screen back><Title>{t('notificationsRow')}</Title><PushPrompt /></Screen>;
}
