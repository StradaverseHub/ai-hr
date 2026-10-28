'use client';
import { useState, useRef,useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { emailKinds, emailDocument, defaultEmailDocument, emailPlaceholders, type EmailBlock, type EmailDocument, type EmailKind, type EmailLocale } from '@/lib/email-design/model';
import { renderEmailDesign } from '@/lib/email-design/render';
import {sampleEmailData} from '@/lib/email-design/sample-data';
import type {EmailSystemContent} from '@/lib/email-design/render';
import type { EmailDesignRow } from '@/core/email-design/service';
import { saveEmailDesignAction, loadEmailDesignHistoryAction, uploadEmailDesignAssetAction, sendEmailDesignTestAction } from './actions';
const blockTypes = ['header', 'banner', 'text', 'image', 'button', 'columns', 'divider', 'spacer', 'social', 'footer'] as const;
function newBlock(type: typeof blockTypes[number]): EmailBlock {
    const base = { id: crypto.randomUUID(), style: {} };
    switch (type) {
        case 'header': return { ...base, type, label: '{company_name}' };
        case 'banner':
        case 'image': return { ...base, type, src: 'https://example.com/image.png', alt: '' };
        case 'text': return { ...base, type, heading: '', runs: [{ text: '' }] };
        case 'button': return { ...base, type, label: 'Open', href: 'https://example.com/' };
        case 'columns': return { ...base, type, columns: [{ heading: '', text: '' }, { heading: '', text: '' }] };
        case 'divider': return { ...base, type };
        case 'spacer': return { ...base, type, height: 24 };
        case 'social': return { ...base, type, links: [{ label: 'Website', href: 'https://example.com/' }] };
        case 'footer': return { ...base, type, text: '' };
    }
}
function SortableBlock({ block, index, selected, onSelect, onMove, onRemove, labels }: {
    block: EmailBlock;
    index: number;
    selected: boolean;
    onSelect: () => void;
    onMove: (offset: number) => void;
    onRemove: () => void;
    labels: {
        name: string;
        up: string;
        down: string;
        remove: string;
        drag: string;
        system: string;
    };
}) {
    const sort = useSortable({ id: block.id });
    return <div ref={sort.setNodeRef} style={{ transform: CSS.Transform.toString(sort.transform), transition: sort.transition }} className={`rounded-md border p-3 ${selected ? 'border-primary bg-primary/5' : 'bg-card'}`}>
  <div className="flex items-center gap-2"><button type="button" {...sort.attributes} {...sort.listeners} aria-label={labels.drag} className="cursor-grab rounded p-2 touch-none">⠿</button><button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left text-sm font-medium">{index + 1}. {labels.name}</button>{block.type === 'system' && <span className="text-xs">🔒 {labels.system}</span>}</div>
  <div className="mt-2 flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => onMove(-1)}>{labels.up}</Button><Button type="button" variant="outline" onClick={() => onMove(1)}>{labels.down}</Button>{block.type !== 'system' && <Button type="button" variant="outline" onClick={onRemove}>{labels.remove}</Button>}</div>
 </div>;
}
export function EmailDesigner({ designs,sampleSystems }: {
    designs: EmailDesignRow[];
    sampleSystems:Record<EmailKind,Record<EmailLocale,EmailSystemContent>>;
}) {
    const t = useTranslations('emailDesign');
    const [kind, setKind] = useState<EmailKind>('invitation'), [locale, setLocale] = useState<EmailLocale>('en');
    const [rows, setRows] = useState(designs), [doc, setDoc] = useState<EmailDocument>(() => designs.find(row => row.kind === 'invitation' && row.locale === 'en')?.document ?? defaultEmailDocument('invitation'));
    const [selected, setSelected] = useState(doc.blocks[0]?.id), [mobile, setMobile] = useState(false), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [message, setMessage] = useState('');
    const [restoringDefault,setRestoringDefault]=useState(false);
    const [history, setHistory] = useState<Awaited<ReturnType<typeof loadEmailDesignHistoryAction>>>([]), [copyFrom, setCopyFrom] = useState('');
    useEffect(()=>{if(!dirty)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
    const gate = useRef(false), current = rows.find(row => row.kind === kind && row.locale === locale), block = doc.blocks.find(value => value.id === selected);
    const edit = (next: EmailDocument) => { setRestoringDefault(false);setDoc(next); setDirty(true); setMessage(''); };
    const update = (next: EmailBlock) => edit({ ...doc, blocks: doc.blocks.map(value => value.id === next.id ? next : value) });
    const switchDesign = (nextKind: EmailKind, nextLocale: EmailLocale) => {
        if (dirty && !window.confirm(t('discard')))
            return;
        const value = rows.find(row => row.kind === nextKind && row.locale === nextLocale)?.document ?? defaultEmailDocument(nextKind);
        setKind(nextKind);
        setLocale(nextLocale);
        setDoc(value);
        setSelected(value.blocks[0]?.id);
        setHistory([]);
        setDirty(false);setRestoringDefault(false);
        setMessage('');
    };
    async function perform(work: () => Promise<void>) { if (gate.current)
        return; gate.current = true; setBusy(true); setMessage(''); try {
        await work();
    }
    catch {
        setMessage(t('failed'));
    }
    finally {
        gate.current = false;
        setBusy(false);
    } }
    async function save(reset = false) {
        await perform(async () => {
            const restoreSystem=reset||restoringDefault;
            const parsed = restoreSystem ? null : emailDocument.parse(doc), revision = await saveEmailDesignAction(kind, locale, parsed, current?.revision ?? 0);
            setRows(previous => [...previous.filter(row => row.kind !== kind || row.locale !== locale), { kind, locale, revision, document: parsed, updatedAt: new Date().toISOString(), updatedBy: '' }]);
            if (restoreSystem) {
                const value = defaultEmailDocument(kind);
                setDoc(value);
                setSelected(value.blocks[0].id);
            }
            setDirty(false);setRestoringDefault(false);
            setHistory([]);
            setMessage(t('saved'));
        });
    }
    function move(id: string, offset: number) { if(gate.current)return;const from = doc.blocks.findIndex(value => value.id === id), to = from + offset; if (to >= 0 && to < doc.blocks.length)
        edit({ ...doc, blocks: arrayMove(doc.blocks, from, to) }); }
    function dropped(event: DragEndEvent) { if (gate.current || !event.over || event.active.id === event.over.id)
        return; edit({ ...doc, blocks: arrayMove(doc.blocks, doc.blocks.findIndex(value => value.id === event.active.id), doc.blocks.findIndex(value => value.id === event.over!.id)) }); }
    let preview = '';
    try {
        preview = renderEmailDesign(doc, kind, locale, sampleSystems[kind][locale], sampleEmailData).html;
    }
    catch {
        preview = '';
    }
    const common = (key: 'background' | 'color' | 'font' | 'size' | 'align' | 'padding', value: string | number) => { if (block)
        update({ ...block, style: { ...block.style, [key]: value } } as EmailBlock); };
    const textField = (label: string, value: string, onChange: (value: string) => void, multiline = false) => <Field label={label}>{multiline ? <textarea value={value} onChange={event => onChange(event.target.value)} className={inputCls} rows={4}/> : <input value={value} onChange={event => onChange(event.target.value)} className={inputCls}/>}</Field>;
    return <fieldset disabled={busy} className="space-y-5">
  <div className="grid gap-4 md:grid-cols-3"><Field label={t('email')}><select className={inputCls} value={kind} onChange={event => switchDesign(event.target.value as EmailKind, locale)}>{emailKinds.map(value => <option key={value} value={value}>{t(`kinds.${value.replace('.', '_')}`)}</option>)}</select></Field><Field label={t('language')}><select className={inputCls} value={locale} onChange={event => switchDesign(kind, event.target.value as EmailLocale)}>{['en', 'ms', 'zh', 'vi', 'ta', 'th'].map(value => <option key={value} value={value}>{t(`languages.${value}`)}</option>)}</select></Field><div className="self-end text-sm text-muted-foreground">{t(current?.document ? 'custom' : 'default')} · {t('revision', { revision: current?.revision ?? 0 })}</div></div>
  <details className="rounded-xl border p-4"><summary className="cursor-pointer font-semibold">{t('list')}</summary><div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">{t('email')}</th><th className="p-2">{t('when')}</th><th className="p-2">{t('recipients')}</th><th className="p-2">{t('style')}</th></tr></thead><tbody>{emailKinds.map(value => { const category = value === 'invitation' || value === 'recovery' ? 'account' : value === 'employee_master_report' ? 'report' : 'workflow'; return <tr key={value} className="border-t"><td className="p-2"><button type="button" className="text-primary underline" onClick={() => switchDesign(value, locale)}>{t(`kinds.${value.replace('.', '_')}`)}</button></td><td className="p-2">{t(`${category}When`)}</td><td className="p-2">{t(`${category}To`)}</td><td className="p-2">{t(rows.some(row => row.kind === value && row.locale === locale && row.document) ? 'custom' : 'default')}</td></tr>; })}</tbody></table></div></details>
  <p className="text-sm text-muted-foreground">{t('deliveryHelp')}</p>
  <div className="flex flex-wrap items-center gap-3"><Button type="button" disabled={busy || !preview} onClick={() => save()}>{busy ? t('working') : t('save')}</Button><Button type="button" variant="outline" disabled={busy || !preview} onClick={() => perform(async () => { await sendEmailDesignTestAction(kind, locale, doc); setMessage(t('testSent')); })}>{t('sendTest')}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => { if (window.confirm(t('restoreConfirm')))
        void save(true); }}>{t('restoreDefault')}</Button><Button type="button" variant="outline" onClick={() => setMobile(value => !value)}>{t(mobile ? 'desktop' : 'mobile')}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => perform(async () => setHistory(await loadEmailDesignHistoryAction(kind, locale)))}>{t('history')}</Button>{dirty && <span className="text-sm text-amber-700">{t('unsaved')}</span>}</div>
  {message && <p role="status" className="rounded-md border p-3 text-sm">{message}</p>}
  {!preview && <p role="alert" className="text-sm text-destructive">{t('invalid')}</p>}
  {history.length > 0 && <Card className="p-4"><h2 className="font-semibold">{t('history')}</h2><ul className="divide-y">{history.map(row => <li key={row.revision} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"><span>{t('revision', { revision: row.revision })} · {row.createdAt} · {row.createdBy}</span><Button type="button" variant="outline" onClick={() => { const value = row.document ?? defaultEmailDocument(kind); edit(value);setRestoringDefault(row.document===null); setSelected(value.blocks[0].id); }}>{t('restoreVersion')}</Button></li>)}</ul></Card>}
  <div className="grid items-start gap-5 xl:grid-cols-[240px_minmax(320px,1fr)_300px]">
   <Card className="space-y-3 p-4"><h2 className="font-semibold">{t('blocks')}</h2><p className="text-xs text-muted-foreground">{t('reorderHelp')}</p><fieldset disabled={busy} className="grid gap-2">{blockTypes.map(type => <Button key={type} type="button" variant="outline" onClick={() => { const value = newBlock(type); edit({ ...doc, blocks: [...doc.blocks, value] }); setSelected(value.id); }}>{t(`blocksNames.${type}`)}</Button>)}</fieldset><Field label={t('reuse')}><select className={inputCls} value={copyFrom} onChange={event => setCopyFrom(event.target.value)}><option value="">{t('choose')}</option>{rows.filter(row => row.document).map(row => <option key={row.kind + row.locale} value={row.kind + ':' + row.locale}>{t(`kinds.${row.kind.replace('.', '_')}`)} · {t(`languages.${row.locale}`)}</option>)}</select></Field><Button type="button" variant="outline" disabled={!copyFrom || busy} onClick={() => { const source = rows.find(row => row.kind + ':' + row.locale === copyFrom)?.document; if (source) {
        const value = { ...source, kind, blocks: source.blocks.map(block => ({ ...block, id: crypto.randomUUID() })) };
        edit(value);
        setSelected(value.blocks[0].id);
    } }}>{t('useLayout')}</Button></Card>
   <div className="space-y-4"><div className="rounded-xl bg-muted p-3 sm:p-6"><iframe title={t('preview')} sandbox="" srcDoc={preview} className="mx-auto h-[650px] max-w-full rounded border bg-white" style={{ width: mobile ? 360 : '100%' }}/></div><DndContext collisionDetection={closestCenter} onDragEnd={dropped}><SortableContext items={doc.blocks.map(block => block.id)} strategy={verticalListSortingStrategy}><div className="grid gap-2">{doc.blocks.map((value, index) => <SortableBlock key={value.id} block={value} index={index} selected={value.id === selected} onSelect={() => setSelected(value.id)} onMove={offset => move(value.id, offset)} onRemove={() => edit({ ...doc, blocks: doc.blocks.filter(block => block.id !== value.id) })} labels={{ name: t(`blocksNames.${value.type}`), up: t('up'), down: t('down'), remove: t('remove'), drag: t('drag'), system: t('protected') }}/>)}</div></SortableContext></DndContext></div>
   <Card className="space-y-4 p-4"><h2 className="font-semibold">{t('style')}</h2>{textField(t('subject'), doc.subject, value => edit({ ...doc, subject: value }))}<Field label={t('canvasColor')}><input type="color" value={doc.background} onChange={event => edit({ ...doc, background: event.target.value })}/></Field>
    {block && <><h3 className="text-sm font-medium">{t(`blocksNames.${block.type}`)}</h3><div className="grid grid-cols-2 gap-3"><Field label={t('background')}><input type="color" value={block.style.background ?? '#ffffff'} onChange={event => common('background', event.target.value)}/></Field><Field label={t('textColor')}><input type="color" value={block.style.color ?? '#202020'} onChange={event => common('color', event.target.value)}/></Field></div>
    {block.type === 'system' ? <p className="text-sm text-muted-foreground">{t('protectedHelp')}</p> : <><Field label={t('font')}><select className={inputCls} value={block.style.font ?? 'Arial'} onChange={event => common('font', event.target.value)}>{['Arial', 'Georgia', 'Verdana', 'Tahoma', 'Trebuchet MS'].map(font => <option key={font}>{font}</option>)}</select></Field><Field label={t('size')}><input className={inputCls} type="number" min={10} max={48} value={block.style.size ?? 16} onChange={event => common('size', Number(event.target.value))}/></Field><Field label={t('alignment')}><select className={inputCls} value={block.style.align ?? 'left'} onChange={event => common('align', event.target.value)}>{['left', 'center', 'right'].map(value => <option key={value} value={value}>{t(value)}</option>)}</select></Field><Field label={t('spacing')}><input className={inputCls} type="number" min={0} max={64} value={block.style.padding ?? 20} onChange={event => common('padding', Number(event.target.value))}/></Field></>}
    {block.type === 'header' && textField(t('text'), block.label, value => update({ ...block, label: value }))}
    {block.type === 'text' && <>{textField(t('heading'), block.heading, value => update({ ...block, heading: value }))}{block.runs.map((run, index) => <div key={index} className="space-y-2 border-t pt-2">{textField(t('text'), run.text, value => update({ ...block, runs: block.runs.map((item, i) => i === index ? { ...item, text: value } : item) }), true)}<label className="mr-3 text-sm"><input type="checkbox" checked={!!run.bold} onChange={event => update({ ...block, runs: block.runs.map((item, i) => i === index ? { ...item, bold: event.target.checked } : item) })}/> {t('bold')}</label><label className="text-sm"><input type="checkbox" checked={!!run.italic} onChange={event => update({ ...block, runs: block.runs.map((item, i) => i === index ? { ...item, italic: event.target.checked } : item) })}/> {t('italic')}</label>{textField(t('link'), run.href ?? '', value => update({ ...block, runs: block.runs.map((item, i) => i === index ? { ...item, href: value || undefined } : item) }))}</div>)}<Button type="button" variant="outline" onClick={() => update({ ...block, runs: [...block.runs, { text: '' }] })}>{t('addText')}</Button></>}
    {(block.type === 'image' || block.type === 'banner' || block.type === 'header') && <>{textField(t('imageUrl'), block.src ?? '', value => update({ ...block, src: value || undefined } as EmailBlock))}{block.type !== 'header' && textField(t('alt'), block.alt, value => update({ ...block, alt: value }))}<form action={form => perform(async () => { const src = await uploadEmailDesignAssetAction(form); update({ ...block, src } as EmailBlock); })}><Field label={t('upload')}><input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp" required className="max-w-full text-sm"/></Field><Button type="submit" variant="outline" disabled={busy}>{t('upload')}</Button></form><p className="text-xs text-muted-foreground">{t('assetHelp')}</p></>}
    {block.type === 'button' && <>{textField(t('text'), block.label, value => update({ ...block, label: value }))}{textField(t('link'), block.href, value => update({ ...block, href: value }))}</>}
    {block.type === 'footer' && textField(t('text'), block.text, value => update({ ...block, text: value }), true)}
    {block.type === 'spacer' && <Field label={t('height')}><input className={inputCls} type="number" min={4} max={100} value={block.height} onChange={event => update({ ...block, height: Number(event.target.value) })}/></Field>}
    {block.type === 'columns' && block.columns.map((col, index) => <div key={index} className="space-y-2 border-t pt-3">{textField(t('heading'), col.heading, value => update({ ...block, columns: block.columns.map((item, i) => i === index ? { ...item, heading: value } : item) as typeof block.columns }))}{textField(t('text'), col.text, value => update({ ...block, columns: block.columns.map((item, i) => i === index ? { ...item, text: value } : item) as typeof block.columns }), true)}</div>)}
    {block.type === 'social' && <>{block.links.map((link, index) => <div key={index}>{textField(t('text'), link.label, value => update({ ...block, links: block.links.map((item, i) => i === index ? { ...item, label: value } : item) }))}{textField(t('link'), link.href, value => update({ ...block, links: block.links.map((item, i) => i === index ? { ...item, href: value } : item) }))}</div>)}<Button type="button" variant="outline" onClick={() => update({ ...block, links: [...block.links, { label: 'Website', href: 'https://example.com/' }] })}>{t('addLink')}</Button></>}
    </>}
    <h3 className="text-sm font-semibold">{t('details')}</h3><p className="break-words text-sm">{emailPlaceholders(kind).map(key => `{${key}}`).join(' · ')}</p>
   </Card>
  </div>
 </fieldset>;
}
