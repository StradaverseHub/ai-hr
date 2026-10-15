import { z } from 'zod';
import { pmBands,potentialBands,type PMBand,type PotentialBand } from './model';
export const heldCalibrationSchema=z.object({lines:z.array(z.object({reviewId:z.uuid(),sessionRevision:z.number().int().positive(),axis:z.enum(['performance','potential']),band:z.string(),reason:z.string().max(4000)})).max(200),focus:z.uuid().nullable(),requestId:z.uuid().nullable(),navigation:z.boolean().optional()});
export type HeldCalibration=z.infer<typeof heldCalibrationSchema>;
export const emptyHeldCalibration:HeldCalibration={lines:[],focus:null,requestId:null};
type Target={id:string;name:string;performanceNote?:string;potentialNote?:string};
export type CalibrationCommand={reviewId:string;axis:'performance'|'potential';band:PMBand|PotentialBand;reason:string;submit:boolean};
const normalize=(text:string)=>text.trim().normalize('NFKC').toLocaleLowerCase();
/** Only a complete human instruction can request a move. A model response never enters this parser. */
export function calibrationCommand(text:string,targets:Target[],activeAxis:'performance'|'potential'|'both',tier:string):CalibrationCommand|null {
 const match=/^(set|save department) (performance|potential):\s*([\s\S]+)$/i.exec(text.trim());if(!match)return naturalCalibrationCommand(text,targets,activeAxis,tier);
 if(tier==='group'||tier==='final')throw Error('Use the review controls to record this tier’s decision. The conversation is read-only.');
 const axis=match[2].toLowerCase() as 'performance'|'potential';if(activeAxis!=='both'&&axis!==activeAxis)throw Error('Choose the active calibration axis.');
 const candidates=targets.filter(t=>normalize(match[3]).startsWith(`${normalize(t.name)}:`));
 if(candidates.length!==1)throw Error('Use one exact, unambiguous name from this cohort.');
 const target=candidates[0],tail=match[3].trim().slice(target.name.length+1).trim(),parts=/^([^:]+):\s*([\s\S]+)$/.exec(tail);
 if(!parts||!parts[2].trim())throw Error('Include the band and your own explanation: Set performance: Name: ME: reason.');
 const band=(axis==='performance'?pmBands:potentialBands).find(b=>normalize(b)===normalize(parts[1]));if(!band)throw Error('Choose a configured band for this axis.');
 const reason=z.string().trim().min(1).max(4000).parse(parts[2]);
 const submit=match[1].toLowerCase()==='save department';if(submit&&tier!=='hod')throw Error('A department save belongs to the department reviewer.');
 return {reviewId:target.id,axis,band,reason,submit};
}

/** Natural human instructions still carry their own person, band and reason; questions never write. */
function naturalCalibrationCommand(text:string,targets:Target[],activeAxis:'performance'|'potential'|'both',tier:string):CalibrationCommand|null {
 const match=/^(?:please\s+)?(?:move|mark|rate|set)\s+([\s\S]+)$/i.exec(text.trim());if(!match)return null;
 if(tier==='group'||tier==='final')throw Error('Use the review controls to record this tier’s decision. The conversation is read-only.');
 const candidates=targets.filter(t=>normalize(match[1]).startsWith(normalize(t.name)+' '));
 if(candidates.length!==1)throw Error('Use one exact, unambiguous name from this cohort.');
 const target=candidates[0],tail=match[1].trim().slice(target.name.length).trim();
 const move=/^(?:(?:for\s+)?(performance|potential)\s+)?(?:to|as|at)\s+(.+?)\s+(because\s+|with\s+(?:(?:my|the)\s+)?(?:reason|remark|note):\s*|with\s+(?:this|that|my|the|same|saved|approved|refined|new|current)\s+(?:remark|wording|note|draft|justification)\.?$)([\s\S]*)$/i.exec(tail);
 if(!move)throw Error('Name the band and include your own explanation, or say “with this remark” to keep your saved wording.');
 const aliases:Record<string,PMBand|PotentialBand>={'unacceptable':'UA','below expectation':'BE','meets expectation':'ME','above expectation':'AE','outstanding':'OU','low':'Low','mid':'Mid','high':'High'};
 const band=aliases[normalize(move[2])]??[...pmBands,...potentialBands].find(b=>normalize(b)===normalize(move[2]));
 if(!band)throw Error('Choose a configured band for this axis.');
 const axis=pmBands.some(b=>b===band)?'performance':'potential';
 if(activeAxis!=='both'&&axis!==activeAxis||move[1]&&normalize(move[1])!==axis)throw Error('Choose the active calibration axis.');
 const saved=/^with\s+(?:this|that|my|the|same|saved|approved|refined|new|current)\s+(?:remark|wording|note|draft|justification)\.?$/i.test(move[3]);
 const reason=z.string().trim().min(1,'Write your own explanation before changing the band.').max(4000).parse(saved?(axis==='performance'?target.performanceNote:target.potentialNote)??'':move[4]);
 return {reviewId:target.id,axis,band,reason,submit:false};
}
