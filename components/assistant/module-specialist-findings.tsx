/** Render only inside the current-caller canonical view owner's authenticated boundary. */
import {getTranslations} from 'next-intl/server';
import type {SpecialistAssessment} from '../../lib/ai/module-specialists';
export async function ModuleSpecialistFindings({assessment}:{assessment:SpecialistAssessment}){
 const t=await getTranslations('assistant.workspace.specialists'),finding=await getTranslations('assistant.workspace.specialistFindings');
 return <aside className="space-y-2 rounded-lg border bg-muted/20 p-4" aria-label={t('findingsTitle')}>
  <h3 className="text-sm font-medium">{t('findingsTitle')}</h3>
  <p className="text-xs text-muted-foreground">{t('findingsScope')}</p>
  <ul className="list-disc space-y-2 pl-5 text-sm">{assessment.findings.map(code=><li key={code}>{finding(code)}</li>)}</ul>
 </aside>;
}
