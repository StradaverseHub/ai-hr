/**
 * Inbox — the in-app notifications (GET /api/mobile/v1/notifications). This is where a push will deep-link
 * to: the push itself carries no content (ADR-0088 §3).
 */
import { StyleSheet, Text, View } from 'react-native';
import { useApi } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { Card, LoadState, Muted, Screen, Title, colors } from '../../lib/ui';

export default function Inbox() {
  const { signOut } = useSession();
  const inbox = useApi('notifications', {}, signOut);
  return (
    <Screen refreshing={inbox.loading && inbox.data != null} onRefresh={inbox.reload}>
      <Title>{t('tabInbox')}</Title>
      <LoadState loading={inbox.loading && !inbox.data} error={inbox.error} onRetry={inbox.reload} />
      {inbox.data && !inbox.data.enabled && <Muted>{t('notificationsOff')}</Muted>}
      {inbox.data?.enabled && inbox.data.items.length === 0 && <Muted>{t('inboxEmpty')}</Muted>}
      {inbox.data?.items.map((n) => (
        <Card key={n.id}>
          <View style={styles.head}>
            {n.readAt == null && <View style={styles.dot} accessibilityLabel="unread" />}
            <Text style={[styles.title, n.readAt == null && styles.unread]}>{n.title}</Text>
          </View>
          <Text style={styles.body}>{n.body}</Text>
          <Muted>{new Date(n.createdAt).toLocaleString()}</Muted>
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  title: { fontSize: 16, color: colors.text, flexShrink: 1 },
  unread: { fontWeight: '700' },
  body: { fontSize: 15, color: colors.text },
});
