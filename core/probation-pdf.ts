import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import type {LetterInline,ResolvedLetterBlock} from '../lib/letter-model';
import {renderLetterPdf} from '../lib/letter-pdf';
import {scoreProbationForm} from '../lib/probation-form';
import type {ProbationCaseView,ProbationPartView} from './probation';
const text=(value:string):LetterInline[]=>[{type:'text',text:value}];
const table=(rows:string[][]):ResolvedLetterBlock=>({type:'table',rows:rows.map(row=>row.map(text))});
const paragraph=(value:string):ResolvedLetterBlock=>({type:'paragraph',content:text(value)});
const heading=(value:string):ResolvedLetterBlock=>({type:'heading',level:2,content:text(value)});
/** Frozen submitted content, both rater columns and authenticated signing evidence. No current HR read. */
export async function renderProbationPartPdf(view:ProbationCaseView,part:ProbationPartView):Promise<Buffer>{
 const facts=part.submittedFacts??view.record.facts,period=part.submittedPeriod??view.record,blocks:ResolvedLetterBlock[]=[heading(view.form.name),paragraph('Confidential — probation evaluation'),table([['Employee','Employee ID','Job title','Job grade'],[facts.employeeName,facts.employeeCode??'',facts.title??'',period.gradeAtStart]]),table([['Business unit','Division / department','Date joined','Probation period'],[facts.businessUnit??'',[facts.division,facts.department].filter(Boolean).join(' / '),period.startOn,period.startOn+' – '+period.endOn]]),heading(`Part ${part.type} · ${part.type===1?'Week 1 Success Plan':part.type===2?'Mid-Probation Review':'Final Confirmation Review'}`)];
 if(part.type===1){
  blocks.push(heading('A. Key Accountabilities and KPIs'),table([['No.','Key accountability','KPI / success measure','Target','Target date'],...part.kpis.map((k,i)=>[String(i+1),k.accountability,k.measure,k.target,k.targetDate])]),heading('B. Planned Support for Employee'),table([['Support','Details / owner / timing'],['On-the-job training / coaching',part.support.coaching],['SOPs, policies, guidelines or system access',part.support.access],['Regular check-ins / feedback arrangements',part.support.checkins],['Other support required',part.support.other]]),heading('C. Meeting Acknowledgement'),paragraph(part.employeeComments));
 }else{
  if(part.acknowledgedKpis?.length)blocks.push(heading('Acknowledged Week 1 KPIs'),table([['Accountability','KPI / success measure','Target','Target date'],...part.acknowledgedKpis.map(k=>[k.accountability,k.measure,k.target,k.targetDate])]));
  blocks.push(table([['Review date','Conducted by'],[part.reviewOn,part.conductedBy??'']]),paragraph('Rating scale: '+view.form.ratingLabels.map((label,i)=>`${i+1} — ${label}`).join('; ')));
  for(const[section,label]of [['role',part.type===2?'A. Performance Progress Review':'A. Role Performance Assessment'],['principles','B. Leadership Principles']]as const){
   blocks.push(heading(label),table([['Criterion / weight','Employee rating / weighted','Employee evidence','Line Manager rating / weighted','Line Manager evidence'],...view.form.criteria.filter(c=>c.section===section).map(c=>{const a=part.employee[c.id],b=part.manager[c.id];return[`${c.title} (${c.weight}%)`,a?.rating==null?'Unrated':`${a.rating} / ${(a.rating*c.weight/100).toFixed(2)}`,a?.evidence??'',b?.rating==null?'Unrated':`${b.rating} / ${(b.rating*c.weight/100).toFixed(2)}`,b?.evidence??''];})]));
  }
  const employee=scoreProbationForm(view.form,part.employee),manager=scoreProbationForm(view.form,part.manager),score=(value:ReturnType<typeof scoreProbationForm>)=>value?[(value.sectionA/100).toFixed(2),(value.sectionB/100).toFixed(2),(value.hundredths/100).toFixed(2),String(value.band)]:['Pending','Pending','Pending','Pending'];
  blocks.push(heading(part.type===2?'C. Overall Mid-Point Assessment and Recommendation':'C. Overall Result and Recommendation'),table([['Rater','Section A / 2.50','Section B / 2.50','Total / 5.00','Band'],['Employee',...score(employee)],['Line Manager',...score(manager)]]));
  if(part.type===2)blocks.push(heading('D. Coaching Summary and Development Plan'),paragraph('Top strengths demonstrated: '+part.strengths),paragraph('Priority development areas: '+part.development),paragraph('Employee comments: '+part.employeeComments),heading('E. Mid-Probation Status'),paragraph(part.midpointStatus??''),paragraph('Manager’s Overall Comments: '+part.managerComments));
  else blocks.push(paragraph('Outcome: '+(part.outcome??'')),paragraph('Extension months: '+(part.extensionMonths??'Not applicable')),paragraph('Recommendation and Justification: '+part.justification),heading('D. Employee Comments and Acknowledgement'),paragraph(part.employeeComments));
 }
 const signing=part.signing?.document,current=signing?.actions.filter(a=>a.contentRevision===signing.contentRevision&&a.contentHash===signing.contentHash)??[];
 const roleLabel=(action:(typeof current)[number])=>[
  action.role,
  ...(action.coveredStepIds??[]).map(id=>signing?.route.steps.find(step=>step.id===id)?.role).filter(Boolean),
 ].join(' + ');
 blocks.push(heading('Authenticated signature record'),paragraph('Acknowledgement confirms discussion and receipt of feedback. It does not imply agreement.'),paragraph('Content fingerprint: '+(signing?.contentHash??'')),table([['Role','Verified person','Action','Time','Represented holder / comment'],...current.map(a=>[roleLabel(a),a.actorName,a.action,a.at,[a.representedId,a.comment].filter(Boolean).join(' · ')])]),heading('Appendix A · Manager Rating Guide'),paragraph('Rate observable behaviour and demonstrated results, not personality or personal preference. Use examples from the full probation period. Apply the same standard to comparable roles and discuss unclear cases with Group People. A rating of 1 or 2 requires clear evidence, prior feedback and documented development support. Explain material risks and required action.'));
 for(const criterion of view.form.criteria.filter(c=>c.section==='principles'))blocks.push(heading(criterion.title),paragraph(criterion.standard),{type:'list',ordered:true,items:criterion.behaviours.map(text)},paragraph('Evidence prompts: '+criterion.prompt));
 const base=await renderLetterPdf({document:{version:1,language:'en',blocks},title:`Probation · ${facts.employeeName} · Part ${part.type}`,reference:`${view.record.id} · part ${part.id} · revision ${part.contentRevision}`,signature:{name:'',caption:'Authenticated signature evidence is listed in the document.',timestamp:''},maxPages:200});
 const drawn=current.filter(a=>a.signature?.method==='drawn');if(!drawn.length)return Buffer.from(base.bytes);
 const pdf=await PDFDocument.load(base.bytes),font=await pdf.embedFont(StandardFonts.Helvetica);
 for(const action of drawn){const page=pdf.addPage([595,842]),stamp=await pdf.embedPng(Buffer.from(action.signature!.value.split(',')[1],'base64'));const scale=Math.min(420/stamp.width,160/stamp.height);page.drawText(`${roleLabel(action)} signature · ${action.at}`,{x:50,y:770,font,size:10,color:rgb(.1,.1,.1)});page.drawImage(stamp,{x:50,y:570,width:stamp.width*scale,height:stamp.height*scale});page.drawText(`Content revision ${action.contentRevision}`,{x:50,y:540,font,size:10});}
 return Buffer.from(await pdf.save());
}
