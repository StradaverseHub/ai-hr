'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { LegacyCaseMapping } from '@/lib/system-testing/updates';
import { btnPrimary,inputCls } from '@/components/ui';
export function TestingLegacyMappingForm({ rows,initial }: { rows: { semanticId: string; title: string; candidates: { caseId: string; caseNo: number; title: string; versionId: string; versionHash: string }[] }[]; initial: LegacyCaseMapping[] }) {
  const t=useTranslations('systemTestingWorkspace'),[mappings,setMappings]=useState(initial);
  if (!rows.length)return null;
  return <form method="get" className="space-y-3 rounded-md border p-4"><input type="hidden" name="tab" value="updates"/><input type="hidden" name="legacyMappings" value={JSON.stringify(mappings)}/><h3 className="font-medium">{t('legacyMapping')}</h3><p className="text-sm text-muted-foreground">{t('legacyMappingNote')}</p>{rows.map(row=><label key={row.semanticId} className="block"><span className="mb-1 block text-sm">{row.title}</span><select className={inputCls} value={mappings.find(m=>m.semanticId===row.semanticId)?.caseId??''} onChange={e=>{const selected=row.candidates.find(c=>c.caseId===e.target.value);setMappings(m=>[...m.filter(x=>x.semanticId!==row.semanticId),...(selected?[{ semanticId:row.semanticId,caseId:selected.caseId,expectedVersionId:selected.versionId,expectedVersionHash:selected.versionHash }]:[])]);}}><option value="">{t('choose')}</option>{row.candidates.map(c=><option key={c.caseId} value={c.caseId}>TC-{String(c.caseNo).padStart(4,'0')} · {c.title}</option>)}</select></label>)}<button className={btnPrimary}>{t('previewMappings')}</button></form>;
}
