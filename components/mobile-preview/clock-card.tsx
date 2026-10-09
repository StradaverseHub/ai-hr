'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowRight, Building2, Camera, Check, CircleCheck, History, LoaderCircle } from 'lucide-react';
import type { MobilePreviewData } from './types';
import type { useMobileClock } from './use-mobile-clock';
import { SlideConfirm } from './slide-confirm';
import styles from './mobile-preview.module.css';

type ClockData = Extract<MobilePreviewData['clock'], { status: 'ready' }>['data'];
export function ClockCard({ clock: c, company, layout, capture, onHistory, showBothActions }: {
  clock: ClockData; company: string; layout: 'flow' | 'punch' | 'rail'; capture: ReturnType<typeof useMobileClock>;
  onHistory: () => void; showBothActions: boolean;
}) {
  const t = useTranslations('mobilePreview'), g = useTranslations('mobilePreview.gesture'), a = useTranslations('attendance.clock');
  const locale = useLocale();
  const [review, setReview] = useState<'in' | 'out' | null>(null);
  const lastIn = c.events.filter(e => e.direction === 'in').at(-1), lastOut = c.events.filter(e => e.direction === 'out').at(-1);
  const dismiss = () => { capture.dismiss(); setReview(null); };
  const proof = <div className={`${styles.proof} ${!c.clockedIn || review ? styles.proofPair : ''}`}>
    {c.clockedIn && !review ? <><strong>{lastIn?.time ?? '—'}</strong><span><CircleCheck size={17} />{t('live.recorded')}</span></> : <>
      <div><span>{t('live.in')}</span><strong>{lastIn?.time ?? '—'}</strong></div>
      <div><span>{t('live.out')}</span><strong>{lastOut?.time ?? '—'}</strong></div>
    </>}
  </div>;
  const failure = ['uncertain', 'interrupted', 'authentication'].includes(capture.error) ? g(capture.error)
    : ['outsideGeofence', 'locationRequired', 'photoRequired', 'photoInvalid', 'conflict', 'correctedDay', 'cameraFailed', 'syncFailed'].includes(capture.error) ? a(capture.error) : g('failure');
  let controls;
  if (capture.phase === 'success' && capture.receipt) {
    const time = new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(capture.receipt.recordedAt));
    controls = <div className={styles.clockReceipt} role="status">
      <span className={styles.receiptSeal}><Check size={27} /></span>
      <p>{g('serverConfirmed')}</p><strong>{time}</strong>
      <p>{g(capture.receipt.direction === 'in' ? 'savedIn' : 'savedOut', { time })}</p>
      <button type="button" className={styles.finishAction} onClick={dismiss}>{g('backToWorkday')}<ArrowRight size={18} /></button>
    </div>;
  } else if (capture.busy) controls = <div className={styles.clockPending} role="status"><LoaderCircle size={26} className={styles.spinning} /><p>{g(capture.phase === 'saving' ? 'saving' : 'checking')}</p></div>;
  else if (capture.phase === 'error' || capture.phase === 'uncertain') controls = <div className={styles.clockFailure}>
    <p role="alert">{failure}</p>
    <button type="button" className={styles.finishAction} onClick={() => void capture.retry()}>{g(capture.unresolved ? 'retrySame' : 'tryAgain')}<ArrowRight size={18} /></button>
    {!capture.unresolved && <button type="button" className={styles.tapAlternative} onClick={dismiss}>{a('cancelPhoto')}</button>}
  </div>;
  else if (capture.phase === 'optional') controls = <div className={styles.capturePanel}>
    <Camera size={30} /><p>{a('photoOptionalPrompt')}</p>
    <button type="button" className={styles.finishAction} onClick={() => void capture.camera()}>{a('takePhoto')}<Camera size={18} /></button>
    <button type="button" className={styles.tapAlternative} onClick={() => void capture.confirmPhoto(true)}>{a('skipPhoto')}</button>
    <button type="button" className={styles.tapAlternative} onClick={dismiss}>{a('cancelPhoto')}</button>
  </div>;
  else if (capture.phase === 'camera') controls = <div className={styles.capturePanel}>
    <video ref={capture.video} autoPlay playsInline muted className={styles.captureImage} aria-label={a('liveFront')} />
    <p>{a('faceGuide')}</p><button type="button" className={styles.finishAction} onClick={capture.capture}>{a('takePhoto')}<Camera size={18} /></button>
    <button type="button" className={styles.tapAlternative} onClick={dismiss}>{a('cancelPhoto')}</button>
  </div>;
  else if (capture.phase === 'photo') controls = <div className={styles.capturePanel}>
    {capture.photoUrl && <img src={capture.photoUrl} alt={a('photoReview')} className={styles.captureImage} />}
    <SlideConfirm direction={capture.direction} onConfirm={() => void capture.confirmPhoto()} />
    <button type="button" className={styles.tapAlternative} onClick={() => void capture.camera()}>{a('retakePhoto')}</button>
    <button type="button" className={styles.tapAlternative} onClick={dismiss}>{a('cancelPhoto')}</button>
  </div>;
  else if (review) controls = <>
    <div className={styles.reviewProof}><span>{g('reviewedIn')}<strong>{lastIn?.time ?? '—'}</strong></span><span>{g('recordOnConfirm')}</span></div>
    <SlideConfirm direction={review} onConfirm={() => void capture.start(review)} />
    <button type="button" className={styles.tapAlternative} onClick={() => setReview(null)}>{g('keepWorking')}</button>
  </>;
  else if (c.clockedIn) controls = <>{proof}<button type="button" className={styles.finishAction} onClick={() => setReview('out')}>{g('finishAction')}<ArrowRight size={18} /></button></>;
  else controls = <>{c.events.length > 0 && proof}<SlideConfirm direction="in" onConfirm={() => void capture.start('in')} /></>;
  const title = capture.active ? t('live.workday') : review === 'out' ? g('finishDay') : review === 'in' ? t('live.startDay') : t(c.clockedIn ? 'live.clockedIn' : c.events.length ? 'live.dayRecorded' : 'live.startDay');
  return <section className={styles.workday} aria-label={t('live.workday')}>
    <div className={styles.workdayTop}><span>{new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(`${c.date}T12:00:00+08:00`))}</span><span>{c.shiftStart?.slice(0, 5) ?? '—'}–{c.shiftEnd?.slice(0, 5) ?? '—'}</span></div>
    <h3>{title}</h3>
    {!capture.active && layout === 'punch' && <div className={styles.punch}>
      <div><span>{t('live.in')}</span><strong>{lastIn?.time ?? '—'}</strong><small>{t(lastIn ? 'live.recorded' : 'live.noEvent')}</small></div>
      <div><span>{t('live.out')}</span><strong>{lastOut?.time ?? '—'}</strong><small>{t(lastOut ? 'live.recorded' : 'live.noEvent')}</small></div>
    </div>}
    {!capture.active && layout === 'rail' && <div className={styles.rail}><CircleCheck size={24} /><span>{lastIn?.time ?? '—'}</span><ArrowRight size={22} /></div>}
    {controls}
    {!capture.active && !review && showBothActions && <div className={styles.otherClockActions} aria-label={t('live.clock')}>
      <button type="button" onClick={() => setReview('in')}>{a('clockIn')}</button><button type="button" onClick={() => setReview('out')}>{a('clockOut')}</button>
    </div>}
    <div className={styles.clockSite}><Building2 size={15} /><span>{company}</span><button type="button" onClick={onHistory} aria-label={t('live.eventRecord')}><History size={18} /></button></div>
    {!capture.active && <p className={styles.workdayNote}>{g('locationNote')}</p>}
  </section>;
}
