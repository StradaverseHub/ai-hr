'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Pause, Play, RotateCcw } from 'lucide-react';

/**
 * The sign-in page's default welcome: a scripted assistant conversation that plays like a short film and
 * can be driven by hand (owner request 2026-10-30, after the Chin Hin OneHR sign-in tour).
 *
 * Public and fictional. It is rendered before sign-in, so it reads no session, tenant or record: every line
 * is a translated string under `loginTour`, and nothing here calls the assistant. It shows only when the
 * installation has not configured its own welcome media (app/login/login-shell.tsx).
 *
 * Motion is the visitor's to stop: the Pause control halts every automatic step (WCAG 2.2.2), any click on a
 * topic or a reply hands control to the visitor, a hidden tab does not play on, and a reduced-motion
 * preference opens it already paused with no typing animation.
 */

type Turn = { open: string; choices: readonly [string, string] };
// Two turns per topic. Each turn's second question reads naturally after EITHER reply to the first.
const TOPICS = [
  { key: 'leave', turns: [{ open: 'open1', choices: ['pickA1', 'pickB1'] }, { open: 'open2', choices: ['pickA2', 'pickB2'] }] },
  { key: 'pay', turns: [{ open: 'open1', choices: ['pickA1', 'pickB1'] }, { open: 'open2', choices: ['pickA2', 'pickB2'] }] },
  { key: 'growth', turns: [{ open: 'open1', choices: ['pickA1', 'pickB1'] }, { open: 'open2', choices: ['pickA2', 'pickB2'] }] },
] as const satisfies readonly { key: string; turns: readonly Turn[] }[];

const TYPING_MS = 1100;
const AUTO_PICK_MS = 2400;
const NEXT_TOPIC_MS = 4000;

/** Each turn is three slots: the assistant's question, the visitor's pick, the assistant's reply. */
type Slot = { turn: number; part: 'open' | 'pick' | 'reply' };
const slotAt = (pos: number): Slot => ({ turn: Math.floor(pos / 3), part: (['open', 'pick', 'reply'] as const)[pos % 3] });

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    // Older engines (and jsdom) have no matchMedia: treat that as no stated preference.
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const change = () => setReduced(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return reduced;
}

export function LoginTour() {
  const t = useTranslations('loginTour');
  const reduced = usePrefersReducedMotion();
  const [topic, setTopic] = useState(0);
  // How many slots are on screen, and which reply the visitor (or the film) chose in each turn.
  const [shown, setShown] = useState(0);
  const [picks, setPicks] = useState<(0 | 1)[]>([]);
  const [typing, setTyping] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [hidden, setHidden] = useState(false);
  const log = useRef<HTMLOListElement>(null);

  // Reduced motion opens paused; the visitor can still press Play.
  useEffect(() => { if (reduced) setPlaying(false); }, [reduced]);
  useEffect(() => {
    const sync = () => setHidden(document.visibilityState === 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  const turns = TOPICS[topic].turns;
  const total = turns.length * 3;
  const next = shown < total ? slotAt(shown) : null;
  const finished = next === null;
  const running = playing && !hidden;

  // The assistant's own lines (a question, or the answer to a pick already made) arrive after a short
  // typing beat. They follow from a visitor's click too, so they do not wait on `playing`.
  useEffect(() => {
    if (!next || next.part === 'pick' || hidden) return;
    if (reduced) { setShown((n) => n + 1); return; }
    setTyping(true);
    const id = window.setTimeout(() => { setTyping(false); setShown((n) => n + 1); }, TYPING_MS);
    return () => { window.clearTimeout(id); setTyping(false); };
  }, [shown, topic, hidden, reduced]); // eslint-disable-line react-hooks/exhaustive-deps

  // Playing: the film chooses the first reply after a pause long enough to read the question.
  useEffect(() => {
    if (!next || next.part !== 'pick' || !running) return;
    const id = window.setTimeout(() => choose(0, false), AUTO_PICK_MS);
    return () => window.clearTimeout(id);
  }, [shown, topic, running]); // eslint-disable-line react-hooks/exhaustive-deps

  // Playing: a finished topic hands over to the next one, and the last back to the first.
  useEffect(() => {
    if (!finished || !running) return;
    const id = window.setTimeout(() => openTopic((topic + 1) % TOPICS.length, false), NEXT_TOPIC_MS);
    return () => window.clearTimeout(id);
  }, [finished, topic, running]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the newest line in view inside the card, never by scrolling the page itself.
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown, typing, topic]);

  function choose(choice: 0 | 1, byVisitor: boolean) {
    if (byVisitor) setPlaying(false);
    setPicks((p) => { const copy = [...p]; copy[slotAt(shown).turn] = choice; return copy; });
    setShown((n) => n + 1);
  }
  function openTopic(index: number, byVisitor: boolean) {
    if (byVisitor) setPlaying(false);
    setTopic(index);
    setShown(0);
    setPicks([]);
    setTyping(false);
  }

  const key = TOPICS[topic].key;
  const lines: { from: 'assistant' | 'visitor'; text: string }[] = [];
  for (let pos = 0; pos < shown; pos++) {
    const { turn, part } = slotAt(pos);
    const choice = turns[turn].choices[picks[turn] ?? 0];
    if (part === 'open') lines.push({ from: 'assistant', text: t(`${key}.${turns[turn].open}`) });
    else if (part === 'pick') lines.push({ from: 'visitor', text: t(`${key}.${choice}`) });
    else lines.push({ from: 'assistant', text: t(`${key}.${choice}Reply`) });
  }
  const waitingTurn = next?.part === 'pick' ? turns[next.turn] : null;

  return (
    <section className="login-tour" aria-label={t('label')} aria-roledescription={t('roleDescription')}>
      <header className="login-tour-head">
        <span aria-hidden className="login-tour-mark">AI</span>
        <span className="login-tour-title">{t('title')}</span>
        <button
          type="button"
          className="login-tour-play"
          onClick={() => setPlaying((p) => !p)}
          aria-label={t(playing ? 'pause' : 'play')}
          title={t(playing ? 'pause' : 'play')}
        >
          {playing ? <Pause aria-hidden size={14} /> : <Play aria-hidden size={14} />}
        </button>
      </header>
      <div className="login-tour-topics" role="group" aria-label={t('topicsLabel')}>
        {TOPICS.map((item, index) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={index === topic}
            onClick={() => openTopic(index, true)}
          >
            {t(`${item.key}.topic`)}
          </button>
        ))}
      </div>
      <ol ref={log} className="login-tour-log">
        {lines.map((line, index) => (
          <li key={`${topic}-${index}`} data-from={line.from}>
            {line.from === 'visitor' && <span className="sr-only">{t('you')}: </span>}
            {line.text}
          </li>
        ))}
        {typing && (
          <li data-from="assistant" data-typing aria-label={t('typing')}>
            <span aria-hidden /><span aria-hidden /><span aria-hidden />
          </li>
        )}
      </ol>
      <div className="login-tour-actions">
        {waitingTurn && waitingTurn.choices.map((choice, index) => (
          <button key={choice} type="button" onClick={() => choose(index as 0 | 1, true)}>
            {t(`${key}.${choice}`)}
          </button>
        ))}
        {finished && !running && (
          <button type="button" onClick={() => openTopic(topic, true)}>
            <RotateCcw aria-hidden size={14} />
            {t('again')}
          </button>
        )}
      </div>
    </section>
  );
}
