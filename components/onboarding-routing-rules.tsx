'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Field, inputCls } from '@/components/ui';
import { useOnboardingCopy } from '@/lib/onboarding-copy';
import type { OnboardingConfig } from '@/packs/lifecycle/service';

/** 259c6162 — the four routing match fields, in the order the resolver documents them. */
export const ROUTING_FIELDS = [
    { key: 'businessGroup', label: 'Business group' },
    { key: 'company', label: 'Company' },
    { key: 'department', label: 'Department' },
    { key: 'title', label: 'Job title' },
] as const;
type Option = { id: string; name: string };
export type RoutingUsage = { workflowId: string; stepId: string; label: string };

/** Every approval step that uses a routing rule, as "workflow · step". Steps are the only routing consumers. */
export function routingUsages(config: Pick<OnboardingConfig, 'workflows'>, routingId: string): RoutingUsage[] {
    return config.workflows.flatMap(w => w.steps.filter(s => s.type === 'routing' && s.target === routingId).map(s => ({ workflowId: w.id, stepId: s.id, label: w.name + ' · ' + s.label })));
}
/** Routing rules with at least one row pointing at the group, with the number of such rows. */
export function routingsUsingGroup(config: Pick<OnboardingConfig, 'routings'>, groupId: string) {
    return config.routings.map(r => ({ id: r.id, name: r.name, rows: r.rows.filter(row => row.group === groupId).length })).filter(r => r.rows > 0);
}
/** Re-points every step that used `routingId` to `replacement` and removes the routing: one change, one save. */
export function deleteRoutingWithReplacement(config: OnboardingConfig, routingId: string, replacement: string) {
    for (const w of config.workflows)
        for (const s of w.steps)
            if (s.type === 'routing' && s.target === routingId)
                s.target = replacement;
    config.routings = config.routings.filter(r => r.id !== routingId);
}

export function OnboardingRoutingRules({ config, options, change, groupSelect }: {
    config: OnboardingConfig;
    options: Record<(typeof ROUTING_FIELDS)[number]['key'], Option[]>;
    change: (fn: (c: OnboardingConfig) => void) => unknown;
    groupSelect: (value: string, onChange: (id: string) => void) => ReactNode;
}) {
    const copy = useOnboardingCopy();
    const [deleting, setDeleting] = useState<{ id: string; replacement: string } | null>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    useEffect(() => { if (deleting) dialogRef.current?.focus(); }, [deleting?.id]); // eslint-disable-line react-hooks/exhaustive-deps
    const defaultGroup = config.groups.find(g => g.id === 'tech-bp')?.id ?? '';
    const startDelete = (id: string) => {
        if (routingUsages(config, id).length) { setDeleting({ id, replacement: '' }); return; }
        if (window.confirm(copy('Remove this definition? Existing work and history are retained.')))
            change(c => { c.routings = c.routings.filter(r => r.id !== id); });
    };
    const target = deleting ? config.routings.find(r => r.id === deleting.id) : undefined;
    const usages = target ? routingUsages(config, target.id) : [];
    const others = target ? config.routings.filter(r => r.id !== target.id) : [];
    return <section id="routing-rules" className="onb-panel space-y-4" aria-labelledby="routing-rules-heading">
        <div className="space-y-1"><h2 id="routing-rules-heading">{copy('Routing rules')}</h2><p className="onb-muted">{copy('A routing rule picks the assignment group for an approval step from the new joiner’s Business group, company, department and job title. The row with the most filled-in fields wins, and the higher row wins a tie. A row with every field on Any is the default.')}</p></div>
        {config.routings.map(r => {
            const used = routingUsages(config, r.id);
            return <section key={r.id} className="space-y-3 rounded-md border border-border p-3" aria-label={r.name}>
                <Field label={copy('Routing rule name')}><input className={inputCls} value={r.name} onChange={e => change(c => { c.routings.find(x => x.id === r.id)!.name = e.target.value; })}/></Field>
                <p className="onb-muted">{used.length ? <>{copy('Used in:')} {used.map(u => u.label).join(', ')}</> : copy('Not used by any approval step.')}</p>
                {r.rows.map(row => <div key={row.id} className="grid gap-2 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-5">
                    {ROUTING_FIELDS.map(({ key, label }) => <Field key={key} label={copy(label)}><select className={inputCls} value={row.rules[key]?.[0] ?? ''} onChange={e => change(c => { c.routings.find(x => x.id === r.id)!.rows.find(x => x.id === row.id)!.rules[key] = e.target.value ? [e.target.value] : []; })}><option value="">{copy('Any')}</option>{options[key].map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>)}
                    <Field label={copy('Assignment group')}>{groupSelect(row.group, id => change(c => { c.routings.find(x => x.id === r.id)!.rows.find(x => x.id === row.id)!.group = id; }))}</Field>
                    <Button variant="ghost" size="sm" onClick={() => change(c => { const routing = c.routings.find(x => x.id === r.id)!; routing.rows = routing.rows.filter(x => x.id !== row.id); })}>{copy('Remove routing row')}</Button>
                </div>)}
                <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => change(c => { c.routings.find(x => x.id === r.id)!.rows.push({ id: crypto.randomUUID(), rules: {}, group: defaultGroup }); })}>{copy('Add routing row')}</Button><Button size="sm" variant="ghost" onClick={() => startDelete(r.id)}>{copy('Delete routing rule')}</Button></div>
            </section>;
        })}
        {target && deleting && <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="false" aria-labelledby="routing-delete-title" className="space-y-3 rounded-md border border-destructive/40 p-4" onKeyDown={e => { if (e.key === 'Escape') setDeleting(null); }}>
            <h3 id="routing-delete-title">{copy('Delete routing rule {name}', { name: target.name })}</h3>
            <p className="text-sm">{copy('This routing rule is used in:')}</p>
            <ul className="list-disc pl-5 text-sm">{usages.map(u => <li key={u.workflowId + ':' + u.stepId}>{u.label}</li>)}</ul>
            {others.length ? <Field label={copy('Move these approval steps to')}><select className={inputCls} value={deleting.replacement} onChange={e => setDeleting({ ...deleting, replacement: e.target.value })}><option value="">{copy('Choose a routing rule')}</option>{others.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>
                : <p className="text-sm text-amber-800 dark:text-amber-200">{copy('Create another routing rule first. A routing rule that approval steps use can only be deleted when they move to a replacement.')}</p>}
            <p className="onb-muted">{copy('Approvals already waiting keep their approver. The replacement applies to new requests and to retried approval routing.')}</p>
            <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!deleting.replacement} onClick={() => { const { id, replacement } = deleting; change(c => deleteRoutingWithReplacement(c, id, replacement)); setDeleting(null); }}>{copy('Delete and move steps')}</Button><Button size="sm" variant="outline" onClick={() => setDeleting(null)}>{copy('Cancel')}</Button></div>
        </div>}
        <Button variant="outline" onClick={() => change(c => { c.routings.push({ id: crypto.randomUUID(), name: 'New routing rule', rows: [{ id: crypto.randomUUID(), rules: {}, group: defaultGroup }] }); })}>{copy('Create routing rule')}</Button>
    </section>;
}
