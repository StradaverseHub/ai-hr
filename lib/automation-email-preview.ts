/** Fictional editor examples only. Actual recipients and live case fields are resolved by the module owner. */
import type {AutomationModuleCatalogue} from './automation/catalogue';
import {renderEmailBody} from './email-body/render';
import {automationEmailBodyDoc,fillAutomationMergeFields,type AutomationEmailTemplate} from './automation/email';
import {todayInKualaLumpur} from './hr-date';
export type AutomationEmailSample='complete'|'noDecision';
export function automationEmailSampleValues(catalogue:AutomationModuleCatalogue,sample:AutomationEmailSample):Record<string,string>{
 const values:Record<string,string>=Object.fromEntries(catalogue.mergeFields.map(field=>[field.key,'Example '+field.label.toLocaleLowerCase()]));
 Object.assign(values,{'employee.name':'Alex Tan','employee.id':'EXAMPLE-001','employee.jobTitle':'Operations Executive','org.company':'Example Company','org.businessGroup':'Example Group','org.department':'Operations','people.lineManager':'Morgan Lee','contract.start':'2026-01-01','contract.end':'2026-12-31','contract.number':'2','contract.newStart':'2027-01-01','contract.newEnd':'2027-12-31','contract.term':'12','contract.salary':'5200.00','contract.reason':'Renewal agreed for the next contract period','case.link':'#example-case',today:todayInKualaLumpur()});
 if(sample==='noDecision')for(const field of catalogue.mergeFields)if(field.group==='Decision'||field.group==='Letter')delete values[field.key];
 return values;
}
export function automationEmailPreview(template:AutomationEmailTemplate,catalogue:AutomationModuleCatalogue,sample:AutomationEmailSample){
 const values=automationEmailSampleValues(catalogue,sample),labels=new Map(catalogue.mergeFields.map(field=>[field.key,field.label]));
 const body=renderEmailBody(automationEmailBodyDoc(template),{values,readableMissing:true,missingLabel:key=>labels.get(key)});
 return {...body,subject:fillAutomationMergeFields(template.subject,values)};
}
