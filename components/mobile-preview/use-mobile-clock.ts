'use client';

import { useEffect, useRef, useState } from 'react';

type Direction = 'in' | 'out';
type Phase = 'idle' | 'checking' | 'optional' | 'camera' | 'photo' | 'saving' | 'error' | 'uncertain' | 'success';
type Point = { lat: number; lng: number; accuracy: number };
export type ClockReceipt = { id: string; direction: Direction; recordedAt: string; date: string };
type Command = { direction: Direction; body: FormData };
type Context = { attendancePhotoSetting: 'required' | 'optional' | 'not_required'; locationValid: boolean };

const locate = () => new Promise<Point>((resolve, reject) => {
  if (!navigator.geolocation) { reject(new Error('locationRequired')); return; }
  navigator.geolocation.getCurrentPosition(p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
    () => reject(new Error('locationRequired')), { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
});

/** Presentation adapter for the existing Web Clocking contract. The server owns identity, time and policy. */
export function useMobileClock(onRecorded: () => void) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [direction, setDirection] = useState<Direction>('in');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<ClockReceipt | null>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const command = useRef<Command | null>(null);
  const epoch = useRef(0), mounted = useRef(true), locked = useRef(false);
  const recorded = useRef(onRecorded); recorded.current = onRecorded;
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const stop = () => { stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; };
  const current = (version: number) => mounted.current && epoch.current === version;
  useEffect(() => {
    mounted.current = true;
    const hide = () => {
      if (document.visibilityState === 'hidden' && !command.current && ['camera', 'photo', 'optional', 'checking'].includes(phaseRef.current)) {
        epoch.current++; locked.current = false; stop(); setPhoto(null); setError('interrupted'); setPhase('error');
      }
    };
    document.addEventListener('visibilitychange', hide);
    return () => { mounted.current = false; epoch.current++; stop(); document.removeEventListener('visibilitychange', hide); };
  }, []);
  useEffect(() => {
    if (phase !== 'camera' || !video.current || !stream.current) return;
    const version = epoch.current; video.current.srcObject = stream.current;
    void video.current.play().catch(() => { if (current(version)) { stop(); setError('cameraFailed'); setPhase('error'); } });
  }, [phase]);
  useEffect(() => {
    if (!photo) { setPhotoUrl(null); return; }
    const url = URL.createObjectURL(photo); setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  async function context(point?: Point): Promise<Context> {
    const query = point ? '?' + new URLSearchParams(Object.entries(point).map(([key, value]) => [key, String(value)])) : '';
    const response = await fetch('/api/attendance/today' + query, { cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 401 ? 'authentication' : 'syncFailed');
    const value = await response.json();
    if (!['required', 'optional', 'not_required'].includes(value.attendancePhotoSetting) || typeof value.locationValid !== 'boolean') throw new Error('syncFailed');
    return value;
  }
  async function send(value: Command, version: number) {
    setPhase('saving');
    try {
      const response = await fetch('/api/attendance/clock', { method: 'POST', body: value.body });
      if (!current(version)) return;
      if (!response.ok && response.status >= 400 && response.status < 500) {
        // A definitive refusal can start a fresh capture. Network/5xx/invalid receipts keep this exact intent.
        const result = await response.json().catch(() => ({}));
        if (!current(version)) return;
        command.current = null;
        setError(response.status === 401 ? 'authentication' : ['outsideGeofence', 'locationRequired', 'photoRequired', 'photoInvalid', 'conflict', 'correctedDay'].includes(result.error) ? result.error : 'retryFailed');
        setPhoto(null); setPhase('error'); return;
      }
      if (!response.ok) throw new Error('uncertain');
      const result = await response.json(), r = result.receipt;
      if (!current(version)) return;
      if (!r || typeof r.id !== 'string' || !r.id || r.direction !== value.direction || typeof r.recordedAt !== 'string' || !Number.isFinite(Date.parse(r.recordedAt)) || typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw new Error('uncertain');
      command.current = null; setPhoto(null); setReceipt({ id: r.id, direction: r.direction, recordedAt: r.recordedAt, date: r.date }); setError(''); setPhase('success');
      try { recorded.current(); } catch { setError('syncFailed'); }
    } catch {
      if (current(version)) { setError('uncertain'); setPhase('uncertain'); }
    }
  }
  async function submit(next: Direction, image: Blob | null, version: number) {
    try {
      setPhase('checking');
      const point = await locate();
      if (!current(version)) return;
      const policy = await context(point);
      if (!current(version)) return;
      if (!policy.locationValid) throw new Error('outsideGeofence');
      if (policy.attendancePhotoSetting === 'required' && !image) throw new Error('photoRequired');
      const body = new FormData();
      for (const [key, val] of Object.entries({ action: next, requestId: crypto.randomUUID(), ...point })) body.set(key, String(val));
      if (image) body.set('photo', image, 'attendance.jpg');
      command.current = { direction: next, body };
      await send(command.current, version);
    } catch (failure) {
      if (current(version)) { setError((failure as Error).message); setPhase('error'); }
    }
  }
  async function openCamera(version: number) {
    setPhase('checking');
    try {
      const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      if (!current(version)) { next.getTracks().forEach(track => track.stop()); return; }
      stream.current = next; setPhoto(null); setPhase('camera');
    } catch { if (current(version)) { setError('cameraFailed'); setPhase('error'); } }
  }
  async function start(next: Direction) {
    if (locked.current || command.current) return;
    const version = ++epoch.current; locked.current = true;
    stop(); setDirection(next); setReceipt(null); setError(''); setPhoto(null); setPhase('checking');
    try {
      const policy = await context();
      if (!current(version)) return;
      if (policy.attendancePhotoSetting === 'required') await openCamera(version);
      else if (policy.attendancePhotoSetting === 'optional') setPhase('optional');
      else await submit(next, null, version);
    } catch (failure) { if (current(version)) { setError((failure as Error).message); setPhase('error'); } }
    finally { if (current(version)) locked.current = false; }
  }
  async function camera() {
    if (locked.current || command.current) return;
    const version = epoch.current;
    locked.current = true; stop(); setError(''); await openCamera(version); if (current(version)) locked.current = false;
  }
  function capture() {
    const source = video.current;
    if (!source?.videoWidth || !source.videoHeight) { stop(); setError('cameraFailed'); setPhase('error'); return; }
    const version = epoch.current, canvas = document.createElement('canvas'), scale = Math.min(1, 640 / source.videoWidth);
    canvas.width = Math.round(source.videoWidth * scale); canvas.height = Math.round(source.videoHeight * scale);
    const drawing = canvas.getContext('2d');
    if (!drawing) { stop(); setError('cameraFailed'); setPhase('error'); return; }
    drawing.drawImage(source, 0, 0, canvas.width, canvas.height); stop(); setPhase('checking');
    canvas.toBlob(blob => {
      if (!current(version)) return;
      if (!blob) { setError('cameraFailed'); setPhase('error'); return; }
      setPhoto(blob); setPhase('photo');
    }, 'image/jpeg', .8);
  }
  async function confirmPhoto(skip = false) {
    if (locked.current || command.current || (!skip && !photo)) return;
    const version = epoch.current;
    locked.current = true; stop(); setError('');
    await submit(direction, skip ? null : photo, version); if (current(version)) locked.current = false;
  }
  async function retry() {
    if (locked.current) return;
    if (!command.current) { await start(direction); return; }
    const version = epoch.current;
    locked.current = true; setError(''); await send(command.current, version); if (current(version)) locked.current = false;
  }
  function dismiss() {
    if (locked.current || command.current) return;
    epoch.current++; stop(); setPhoto(null); setReceipt(null); setError(''); setPhase('idle');
  }
  return { phase, direction, error, receipt, photoUrl, video, start, camera, capture, confirmPhoto, retry, dismiss,
    busy: phase === 'checking' || phase === 'saving', unresolved: phase === 'uncertain', active: phase !== 'idle' };
}
