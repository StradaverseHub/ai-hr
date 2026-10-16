import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { listRegisteredDevices } from '@/core/attendance-device';
import { Card } from '@/components/ui';
import { revokeDeviceAction } from './device-actions';

export async function RegisteredDevicesCard({s,companies}:{s:SessionContext;companies:readonly {id:string;name:string}[]}) {
  const t=await getTranslations('admin.attendancePolicy');
  const devices=await listRegisteredDevices(s,companies.map(c=>c.id));
  const multiCompany=companies.length>1,companyName=new Map(companies.map(c=>[c.id,c.name]));
  const fmtDate=(d:Date|null)=>d?d.toISOString().slice(0,10):'—';
  return <Card className="overflow-hidden">
      <section id="registered-devices" className="scroll-mt-6 border-t border-border">
        <div className="px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">{t('devicesTitle')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('devicesIntro')}</p>
        </div>
        {devices.length === 0 ? (
          <p className="px-4 pb-6 pt-2 text-center text-sm text-muted-foreground">{t('devicesEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-y border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">{t('devColEmployee')}</th>
                  <th className="px-4 py-2 font-medium">{t('devColDevice')}</th>
                  {multiCompany && <th className="px-4 py-2 font-medium">{t('devColCompany')}</th>}
                  <th className="px-4 py-2 font-medium">{t('devColRegistered')}</th>
                  <th className="px-4 py-2 font-medium">{t('devColLastUsed')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('devColAction')}</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id} className="border-b border-border/60">
                    <td className="px-4 py-2 font-medium text-foreground">
                      {d.employee}
                      {d.employeeCode && <span className="ml-1.5 text-xs text-muted-foreground">{d.employeeCode}</span>}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{d.label}</td>
                    {multiCompany && (
                      <td className="px-4 py-2 text-muted-foreground">{companyName.get(d.companyId) ?? '—'}</td>
                    )}
                    <td className="px-4 py-2 tabular-nums text-muted-foreground">{fmtDate(d.registeredAt)}</td>
                    <td className="px-4 py-2 tabular-nums text-muted-foreground">{fmtDate(d.lastUsedAt)}</td>
                    <td className="px-4 py-2">
                      <form action={revokeDeviceAction} className="flex justify-end">
                        <input type="hidden" name="deviceId" value={d.id} />
                        <button className="text-destructive hover:underline">{t('devRevoke')}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
  </Card>;
}
