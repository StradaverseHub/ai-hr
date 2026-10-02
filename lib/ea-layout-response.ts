import { getTranslations } from 'next-intl/server';
import { EaLayoutFitError } from './ea-pdf';
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Called only after the existing EA authorization read succeeds. No partial PDF is returned. */
export async function eaLayoutFailure(error: EaLayoutFitError, locale: string, employee = ''): Promise<Response> {
  const t = await getTranslations({locale, namespace:'payroll.ea'});
  const title = t('layoutFitTitle');
  const sectionKeys: Record<string,string> = {header:'title', 'employee details':'sectionAEmployeeParticulars', 'employment income':'sectionBEmploymentIncome', 'pension and annuity':'sectionCPensionOther', deductions:'sectionDTotalDeductions', 'contributions and exemptions':'sectionEContributions', 'employer and authorised officer':'layoutFitEmployerSection'};
  const section = sectionKeys[error.section] ? t(sectionKeys[error.section]) : t('title');
  const message = t('layoutFitMessage');
  return new Response(`<!doctype html><html lang="${escape(locale)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui,sans-serif;margin:0;padding:24px}main{max-width:640px;margin:48px auto}h1{font-size:24px}p{overflow-wrap:anywhere}</style><main><h1>${escape(title)}</h1>${employee?`<p>${escape(employee)}</p>`:''}<p>${escape(message)}</p><p>${escape(t('layoutFitSection'))}: ${escape(section)}</p></main></html>`, {status:422,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store'}});
}
