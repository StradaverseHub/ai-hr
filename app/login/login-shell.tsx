'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Pause, Play } from 'lucide-react';
import type { LoginPresentation } from '@/lib/login-presentation';
import { LoginTour } from './login-tour';

export function LoginShell({ children, presentation }: { children: ReactNode; presentation?: LoginPresentation }) {
  const t = useTranslations('loginPresentation');
  const common = useTranslations('common');
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [showAnimation, setShowAnimation] = useState(false);
  useEffect(() => {
    setMediaFailed(false);
    setPlaying(false);
    setShowAnimation(false);
  }, [presentation?.mediaUrl]);
  const media = presentation?.mediaUrl && !mediaFailed;
  return <main className="login-shell">
    <aside className="login-welcome" aria-label={common('appName')}>
      <a href="/login" className="login-brand"><span aria-hidden className="login-brand-mark">AI</span>{common('appName')}</a>
      <div className="login-welcome-content">
        <h2>{t('headline')}</h2>
        <p>{t('description')}</p>
        {media ? <div className="login-media">
          {presentation.mediaType === 'video' ? <>
            <video ref={video} src={presentation.mediaUrl} muted playsInline loop controls preload="metadata"
              aria-label={presentation.alt || t('mediaAlt')} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onError={() => setMediaFailed(true)}/>
            <button type="button" className="login-media-toggle" onClick={async () => {
              if (playing) video.current?.pause();
              else { try { await video.current?.play(); } catch { setMediaFailed(true); } }
            }}>{playing ? <Pause size={16}/> : <Play size={16}/>} {t(playing ? 'pauseMedia' : 'playMedia')}</button>
          </> : presentation.mediaType === 'gif' && !showAnimation ?
            <button type="button" className="login-animation-start" onClick={() => setShowAnimation(true)}><Play size={24}/>{t('playAnimation')}</button>
          : <>
            {/* Admin-configured public media may be animated; optimization would freeze GIFs. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img referrerPolicy="no-referrer" src={presentation.mediaUrl} alt={presentation.alt || t('mediaAlt')} onError={() => setMediaFailed(true)}/>
            {presentation.mediaType === 'gif' && <button type="button" className="login-media-toggle" onClick={() => setShowAnimation(false)}><Pause size={16}/>{t('pauseMedia')}</button>}
          </>}
        </div> : <LoginTour/>}
      </div>
      <p className="login-welcome-foot">{t('footer')}</p>
    </aside>
    <div className="login-form-panel">
      <a href="/login" className="login-mobile-brand">{common('appName')}</a>
      <div className="login-form-content">{children}</div>
    </div>
  </main>;
}
