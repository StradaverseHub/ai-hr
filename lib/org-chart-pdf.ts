import {PDFDocument,StandardFonts,rgb,degrees,pushGraphicsState,popGraphicsState,rectangle,clip,endPath} from 'pdf-lib';
import {bestFaceFor,embedPayslipFaces,payslipFaceScripts} from './payslip-pdf-fonts';
import {layoutOrgChart,type OrgChartEmployee,type OrgChartEdge} from './org-chart-model';
export type OrgChartPdfInput={employees:OrgChartEmployee[];edges:OrgChartEdge[];title:string;company:string;filters:string;generated:string;generatedBy:string;confidential:string|null;horizontal:boolean;paper:'A4'|'A3';orientation:'portrait'|'landscape';pagination:'fit'|'pages';logo?:{content:Buffer;mimeType:string}|null;labels:{reports:string;topLevel:string;outside:string;vacant:string;unassigned:string;page:string}};
export async function renderOrgChartPdf(p:OrgChartPdfInput){
 const doc=await PDFDocument.create();doc.setTitle(p.title);doc.setProducer('AI HR');
 const font=await doc.embedFont(StandardFonts.Helvetica),bold=await doc.embedFont(StandardFonts.HelveticaBold);
 const strings=[p.title,p.company,p.filters,p.generatedBy,...Object.values(p.labels),...p.employees.flatMap(e=>[e.name,e.role??'',e.department??'',e.employeeCode??'',e.managerName??''])];
 const faces=await embedPayslipFaces(doc,payslipFaceScripts(strings));
 const face=(text:string,strong=false)=>{const custom=bestFaceFor(text,faces);return custom?(strong?custom.bold:custom.regular):(strong?bold:font);};
 const wrap=(text:string,width:number,size:number,strong=false)=>{const lines:string[]=[];let current='';for(const char of text){if(char==='\n'||face(current+char,strong).widthOfTextAtSize(current+char,size)>width){lines.push(current);current=char==='\n'?'':char;}else current+=char;}if(current||!lines.length)lines.push(current);return lines;};
 const content=new Map(p.employees.map(e=>[e.employmentId,[`${e.employeeCode?e.employeeCode+' · ':''}${e.name}`,e.role??'',e.department??'',p.labels.reports.replace('0',String(e.directReportCount??p.edges.filter(edge=>edge.type==='administrative'&&edge.manager===e.employmentId).length)),e.topLevel?p.labels.topLevel:e.managerState==='outside'?p.labels.outside+': '+e.managerName:e.managerState==='inactive'?p.labels.vacant:e.managerState==='missing'||e.managerState==='invalid'?p.labels.unassigned:''].filter(Boolean)]));
 const maxLines=Math.max(1,...[...content.values()].map(lines=>lines.flatMap((line,i)=>wrap(line,180,9,i===0)).length));
 const layout=layoutOrgChart(p.employees,p.edges,p.horizontal,Math.max(90,maxLines*12+20));
 const dims=p.paper==='A3'?[841.89,1190.55]:[595.28,841.89];const width=p.orientation==='landscape'?dims[1]:dims[0],height=p.orientation==='landscape'?dims[0]:dims[1];
 const margin=30;const headerLines=wrap(p.filters,width-2*margin,8),companyLines=wrap(p.company,width-2*margin-(p.logo?75:0),10),generatedLines=wrap(`${p.generated} · ${p.generatedBy}`,width-2*margin,8);const top=46+companyLines.length*12+generatedLines.length*11+headerLines.length*11+12;const usableW=width-2*margin,usableH=height-top-35;
 if(usableH<Math.max(90,maxLines*12+20))throw new Error('The selected organisation header leaves no printable chart area');
 const scale=p.pagination==='fit'?Math.min(1,usableW/layout.width,usableH/layout.height):1;
 const strideW=Math.max(1,usableW-210),strideH=Math.max(1,usableH-Math.max(90,maxLines*12+20)-10);
 const cols=p.pagination==='fit'?1:Math.max(1,Math.ceil((layout.width-usableW)/strideW)+1),rows=p.pagination==='fit'?1:Math.max(1,Math.ceil((layout.height-usableH)/strideH)+1);
 let logo;try{if(p.logo)logo=/png/i.test(p.logo.mimeType)?await doc.embedPng(p.logo.content):/jpe?g/i.test(p.logo.mimeType)?await doc.embedJpg(p.logo.content):undefined;}catch{/* Invalid branding never discards an otherwise valid chart. */}
 for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
  const page=doc.addPage([width,height]);const draw=(text:string,x:number,y:number,size=9,strong=false)=>page.drawText(text,{x,y,size,font:face(text,strong),color:rgb(.13,.18,.26)});
  draw(p.title,margin,height-30,16,true);companyLines.forEach((line,i)=>draw(line,margin,height-46-i*12,10));
  generatedLines.forEach((line,i)=>draw(line,margin,height-46-companyLines.length*12-i*11,8));
  headerLines.forEach((line,i)=>draw(line,margin,height-46-companyLines.length*12-generatedLines.length*11-i*11,8));
  if(logo){const box=logo.scaleToFit(65,35);page.drawImage(logo,{x:width-margin-box.width,y:height-52,width:box.width,height:box.height});}
  if(p.confidential)page.drawText(p.confidential,{x:width*.18,y:height*.4,size:40,font:face(p.confidential,true),color:rgb(.5,.5,.5),opacity:.06,rotate:degrees(25)});
  page.pushOperators(pushGraphicsState(),rectangle(margin,35,usableW,usableH),clip(),endPath());
  const x=(n:number)=>margin+n*scale-col*strideW;const y=(n:number)=>height-top-n*scale+row*strideH;
  for(const edge of p.edges){const a=layout.positions.get(edge.manager),b=layout.positions.get(edge.subordinate);if(!a||!b)continue;
   const start=p.horizontal?{x:x(a.x+a.width),y:y(a.y+a.height/2)}:{x:x(a.x+a.width/2),y:y(a.y+a.height)};
   const end=p.horizontal?{x:x(b.x),y:y(b.y+b.height/2)}:{x:x(b.x+b.width/2),y:y(b.y)};
   page.drawLine({start,end,thickness:Math.max(.4,scale),color:edge.type==='administrative'?rgb(.3,.4,.65):rgb(.5,.5,.5),...(edge.type==='administrative'?{}:{dashArray:[3,3]})});
  }
  for(const e of p.employees){const pos=layout.positions.get(e.employmentId);if(!pos)continue;
   // Overlapping tiles ensure every card appears whole on at least one numbered page. Never split
   // a person's name/role across the paper boundary; connector continuations remain clipped.
   if(p.pagination==='pages'&&(pos.x<col*strideW||pos.x+pos.width>col*strideW+usableW||pos.y<row*strideH||pos.y+pos.height>row*strideH+usableH))continue;
   page.drawRectangle({x:x(pos.x),y:y(pos.y+pos.height),width:pos.width*scale,height:pos.height*scale,borderColor:rgb(.72,.76,.82),borderWidth:Math.max(.3,scale*.7),color:rgb(.98,.99,1)});
   let lineNo=0;for(const [i,line]of(content.get(e.employmentId)??[]).entries())for(const part of wrap(line,180,9,i===0)){draw(part,x(pos.x+10),y(pos.y+17+lineNo*12),9*scale,i===0);lineNo++;}
  }
  page.pushOperators(popGraphicsState());draw(`${p.labels.page} ${row*cols+col+1} / ${rows*cols}`,margin,18,8);
 }
 return doc.save();
}
