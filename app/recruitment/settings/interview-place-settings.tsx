import { getLocale, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Field, Input, btnGhost, btnPrimary } from '@/components/ui';
import {
  ADDRESS_NAME_MAX, ADDRESS_REGION_MAX, ADDRESS_TEXT_MAX, ADDRESSES_MAX, MAP_LINK_MAX, ROOM_CAPACITY_MAX, ROOM_NAME_MAX, ROOMS_PER_ADDRESS_MAX,
  interviewPlaceSettings, type AddressRow,
} from '@/packs/recruitment/service';
import { deleteInterviewAddressAction, deleteInterviewRoomAction, saveInterviewAddressFormAction, saveInterviewRoomFormAction } from '../actions';
import { ActionForm, FieldProblem } from '../action-form';
import { Pill, klDateTime, textareaCls } from '../shared';

/**
 * Settings › Addresses and rooms (slice 18, administrators): the company's interview addresses (with an optional https map link) and
 * the meeting rooms at each. Scheduling an on-site interview picks an address and optionally an enabled room; a room is never booked
 * for two interviews at overlapping times (the database refuses it), and cancelling an interview frees its room. Rooms are AI HR's
 * own list: there is no meeting-room or calendar integration (D-058). An address or room an interview names is kept (disable the room).
 */
export async function InterviewPlaceSettingsSection({ s, companyId }: { s: SessionContext; companyId: string }) {
  const [t, locale, settings] = await Promise.all([getTranslations('recruitment.setup'), getLocale(), interviewPlaceSettings(s, companyId)]);
  const problem = { required: t('fieldRequired'), invalid: t('fieldInvalid') };
  const addressFields = (a: AddressRow | null) => (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('places.name')} required requiredAriaLabel={t('fieldRequired')}>
        <Input name="name" defaultValue={a?.name ?? ''} maxLength={ADDRESS_NAME_MAX} required />
        <FieldProblem name="name" {...problem} />
      </Field>
      <Field label={t('places.region')} required requiredAriaLabel={t('fieldRequired')}>
        <Input name="region" defaultValue={a?.region ?? ''} maxLength={ADDRESS_REGION_MAX} required />
        <FieldProblem name="region" {...problem} />
      </Field>
      <Field label={t('places.address')} required requiredAriaLabel={t('fieldRequired')} className="sm:col-span-2">
        <textarea name="address" rows={2} maxLength={ADDRESS_TEXT_MAX} defaultValue={a?.address ?? ''} required className={textareaCls} />
        <FieldProblem name="address" {...problem} />
      </Field>
      <Field label={t('places.mapUrl')} className="sm:col-span-2">
        <Input name="mapUrl" type="url" inputMode="url" pattern="https://.*" placeholder="https://" defaultValue={a?.mapUrl ?? ''} maxLength={MAP_LINK_MAX} />
        <FieldProblem name="mapUrl" required={t('fieldRequired')} invalid={t('places.mapUrlInvalid')} />
        <span className="text-xs text-muted-foreground">{t('places.mapUrlHint')}</span>
      </Field>
    </div>
  );
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('places.note')}</p>
      {settings.addresses.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('places.empty')}</p>
      ) : (
        <ul className="space-y-4">
          {settings.addresses.map((a) => (
            <li key={a.id} className="space-y-3 rounded-xl border border-border bg-card p-4">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2">
                  <span><span className="font-medium">{a.name}</span> <span className="text-sm text-muted-foreground">· {a.region}</span></span>
                  <span className="text-xs text-muted-foreground">{t('places.roomCount', { count: a.rooms.length })} · {t('changedAt', { at: klDateTime(locale, a.updatedAt) })}</span>
                </summary>
                <ActionForm action={saveInterviewAddressFormAction} className="mt-3 space-y-3">
                  <input type="hidden" name="addressId" value={a.id} /><input type="hidden" name="companyId" value={companyId} />
                  {addressFields(a)}
                  <button type="submit" className={btnPrimary}>{t('save')}</button>
                </ActionForm>
              </details>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{a.address}</p>
              {a.mapUrl && <a href={a.mapUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline">{t('places.openMap')}</a>}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">{t('places.roomsTitle')}</h3>
                {a.rooms.length === 0 && <p className="text-xs text-muted-foreground">{t('places.noRooms')}</p>}
                <ul className="space-y-2">
                  {a.rooms.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-2">
                      <ActionForm action={saveInterviewRoomFormAction} className="flex flex-1 flex-wrap items-end gap-2">
                        <input type="hidden" name="roomId" value={r.id} /><input type="hidden" name="companyId" value={companyId} />
                        <Field label={t('places.roomName')} className="min-w-40 flex-1">
                          <Input name="name" defaultValue={r.name} maxLength={ROOM_NAME_MAX} required />
                          <FieldProblem name="name" {...problem} />
                        </Field>
                        <Field label={t('places.capacity', { max: ROOM_CAPACITY_MAX })} className="w-32">
                          <Input name="capacity" type="number" inputMode="numeric" min={1} max={ROOM_CAPACITY_MAX} step={1} defaultValue={r.capacity} required />
                          <FieldProblem name="capacity" {...problem} />
                        </Field>
                        <label className="flex items-center gap-1.5 pb-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={r.enabled} className="accent-primary" />{t('places.enabled')}</label>
                        <button type="submit" className={btnGhost}>{t('save')}</button>
                      </ActionForm>
                      {!r.enabled && <Pill>{t('places.disabled')}</Pill>}
                      {r.inUse ? <span className="pb-2 text-xs text-muted-foreground">{t('places.roomInUse')}</span> : (
                        <form action={deleteInterviewRoomAction}>
                          <input type="hidden" name="roomId" value={r.id} /><input type="hidden" name="companyId" value={companyId} />
                          <button type="submit" className={btnGhost} aria-label={t('deleteNamed', { name: r.name })}>{t('delete')}</button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
                {a.rooms.length < ROOMS_PER_ADDRESS_MAX && (
                  <ActionForm action={saveInterviewRoomFormAction} className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-border p-2">
                    <input type="hidden" name="addressId" value={a.id} /><input type="hidden" name="companyId" value={companyId} />
                    <Field label={t('places.roomName')} required requiredAriaLabel={t('fieldRequired')} className="min-w-40 flex-1">
                      <Input name="name" maxLength={ROOM_NAME_MAX} required />
                      <FieldProblem name="name" {...problem} />
                    </Field>
                    <Field label={t('places.capacity', { max: ROOM_CAPACITY_MAX })} required requiredAriaLabel={t('fieldRequired')} className="w-32">
                      <Input name="capacity" type="number" inputMode="numeric" min={1} max={ROOM_CAPACITY_MAX} step={1} required />
                      <FieldProblem name="capacity" {...problem} />
                    </Field>
                    <label className="flex items-center gap-1.5 pb-2 text-sm"><input type="checkbox" name="enabled" defaultChecked className="accent-primary" />{t('places.enabled')}</label>
                    <button type="submit" className={btnPrimary}>{t('places.addRoom')}</button>
                  </ActionForm>
                )}
              </div>
              {a.inUse ? <p className="text-xs text-muted-foreground">{t('places.addressInUse')}</p> : (
                <form action={deleteInterviewAddressAction}>
                  <input type="hidden" name="addressId" value={a.id} /><input type="hidden" name="companyId" value={companyId} />
                  <button type="submit" className={btnGhost} aria-label={t('deleteNamed', { name: a.name })}>{t('places.deleteAddress')}</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {settings.addresses.length < ADDRESSES_MAX && (
        <ActionForm action={saveInterviewAddressFormAction} className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('places.newTitle')}</h2>
          <input type="hidden" name="companyId" value={companyId} />
          {addressFields(null)}
          <button type="submit" className={btnPrimary}>{t('add')}</button>
        </ActionForm>
      )}
    </div>
  );
}
