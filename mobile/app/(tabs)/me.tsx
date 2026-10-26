import { useTenantDesign } from '../../lib/design';
/**
 * Me — who I am, which employment I am acting as (the picker, when there is more than one), my released
 * payslips, and sign out.
 */
import { Pressable } from 'react-native';
import { router } from 'expo-router';
import { companyCopy, useCompanyConnection } from '../../lib/company-connection';
import { DesignText as Text } from '../../lib/design';
import { useApi } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { Button, Card, LoadState, Muted, Row, Screen, SectionLabel, Title, colors, fmtMoney } from '../../lib/ui';

export default function Me() {
  const company=useCompanyConnection();
  const { palette } = useTenantDesign();
  const { signOut, employmentId, setEmploymentId } = useSession();
  const me = useApi('me', {}, signOut);
  const payslips = useApi('payslips', {}, signOut);
  const employments = me.data?.employments ?? [];
  const active = employmentId ?? employments[0]?.employmentId ?? null;

  return (
    <Screen refreshing={me.loading && me.data != null} onRefresh={() => (me.reload(), payslips.reload())}>
      <Title>{me.data?.person.name ?? t('tabMe')}</Title>
      {me.data?.person.email && <Muted>{me.data.person.email}</Muted>}
      <LoadState loading={me.loading} hasData={me.data!=null} error={me.error} onRetry={me.reload} />

      {employments.length > 0 && <SectionLabel>{t('employments')}</SectionLabel>}
      {employments.map((e) => (
        <Pressable
          key={e.employmentId}
          disabled={employments.length < 2}
          onPress={() => setEmploymentId(e.employmentId)}
          accessibilityRole={employments.length > 1 ? 'radio' : undefined}
          accessibilityState={{ selected: e.employmentId === active }}
        >
          <Card>
            <Text style={{ fontSize: 16, fontWeight: e.employmentId === active ? '700' : '400', color: palette.text }}>
              {e.company}
            </Text>
            {(e.position || e.department) && <Muted>{[e.position, e.department].filter(Boolean).join(' · ')}</Muted>}
          </Card>
        </Pressable>
      ))}

      <SectionLabel>{t('payslips')}</SectionLabel>
      <LoadState loading={payslips.loading} hasData={payslips.data!=null} error={payslips.error} onRetry={payslips.reload} />
      {payslips.data && !payslips.data.enabled && <Muted>{t('payrollOff')}</Muted>}
      {payslips.data?.enabled && payslips.data.items.length === 0 && <Muted>{t('noPayslips')}</Muted>}
      {payslips.data?.items.map((p) => (
        <Card key={p.id}>
          <Row label={p.payPeriod} value={fmtMoney(p.net)} strong />
          <Row label={t('grossPay')} value={fmtMoney(p.gross)} />
          <Row label={t('deductions')} value={fmtMoney(p.deductions)} />
        </Card>
      ))}

      <Button title={t('pendingTitle')} onPress={()=>router.push('/pending-submissions')} kind="quiet"/>
      <Button title={t('signOut')} onPress={() => router.push({pathname:'/pending-submissions',params:{intent:'logout'}})} kind="quiet" />
      {company&&<Button title={companyCopy().change} onPress={()=>router.push({pathname:'/pending-submissions',params:{intent:'company'}})} kind="quiet"/>}
    </Screen>
  );
}
