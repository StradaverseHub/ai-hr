'use client';
import { useRef, useState, type PointerEvent } from 'react';
import type { Signature } from '@/lib/lifecycle-v9-model';
export type SignatureInputLabels={title:string;method:string;typed:string;drawn:string;fullName:string;canvas:string;clear:string;consent:string;submit:string};
const defaultLabels:SignatureInputLabels={title:'Your signature',method:'Signature method',typed:'Type signature',drawn:'Draw signature',fullName:'Type your full name',canvas:'Draw your signature',clear:'Clear signature',consent:'I confirm this is my signature and agree to sign this document.',submit:'Sign and submit'};
export function SignatureInput({ name = '', busy, submit, labels=defaultLabels,resetDrawnOnMethodChange=false }: { labels?:SignatureInputLabels;resetDrawnOnMethodChange?:boolean; name?: string; busy: boolean; submit: (signature: Pick<Signature, 'method' | 'value' | 'consent'>) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), drawing = useRef(false);
  const [method, setMethod] = useState<'typed' | 'drawn'>('typed'), [value, setValue] = useState(name), [ink, setInk] = useState(false), [consent, setConsent] = useState(false);
  function point(event: PointerEvent<HTMLCanvasElement>, begin = false) {
    const node = canvas.current, context = node?.getContext('2d'); if (!node || !context) return;
    const rect = node.getBoundingClientRect(), x = (event.clientX - rect.left) * node.width / rect.width, y = (event.clientY - rect.top) * node.height / rect.height;
    if (begin) { drawing.current = true; node.setPointerCapture(event.pointerId); context.beginPath(); context.moveTo(x, y); context.lineWidth = 2; context.lineCap = 'round'; context.strokeStyle = '#172032'; }
    else if (drawing.current) { context.lineTo(x, y); context.stroke(); setInk(true); }
  }
  return <section className="v9-panel v9-stack"><h2>{labels.title}</h2><div className="v9-actions" role="group" aria-label={labels.method}>{(['typed', 'drawn'] as const).map(option => <button key={option} type="button" className={'v9-button' + (method === option ? ' v9-button-primary' : '')} aria-pressed={method === option} disabled={busy} onClick={() => {if(resetDrawnOnMethodChange&&method!==option)setInk(false);setMethod(option);}}>{option === 'typed' ? labels.typed : labels.drawn}</button>)}</div>
    {method === 'typed' ? <label className="v9-field"><span>{labels.fullName}</span><input className="v9-input" maxLength={200} value={value} disabled={busy} onChange={e => setValue(e.target.value)}/></label> : <><canvas ref={canvas} width={600} height={180} aria-label={labels.canvas} onPointerDown={e => { if (!busy) point(e, true); }} onPointerMove={e => point(e)} onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }} style={{ width: '100%', maxWidth: 600, height: 180, touchAction: 'none', border: '1px solid #e5e9f0', borderRadius: 8, background: '#fff' }}/><button type="button" className="v9-button" disabled={busy} onClick={() => { canvas.current?.getContext('2d')?.clearRect(0, 0, 600, 180); setInk(false); }}>{labels.clear}</button></>}
    <label className="v9-actions"><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)}/>{labels.consent}</label>
    <button type="button" className="v9-button v9-button-primary" disabled={busy || !consent || (method === 'typed' ? !value.trim() : !ink)} onClick={() => { const signed = method === 'typed' ? value.trim() : canvas.current?.toDataURL('image/png'); if (signed) submit({ method, value: signed, consent: true }); }}>{labels.submit}</button>
  </section>;
}
