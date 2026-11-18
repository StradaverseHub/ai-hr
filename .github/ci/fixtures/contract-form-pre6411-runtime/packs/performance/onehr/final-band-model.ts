import { pmBands,type PMBand } from './model';

export type GroupMode='after'|'replace'|'blend';
export type BandSuggestion={band:PMBand|null;tie:[PMBand,PMBand]|null;why:'bg_only'|'group_only'|'group'|'agree'|'halfway'|'blend'};
export const finalBandExplanation:Record<BandSuggestion['why'],string>={bg_only:'only the BG call is available',group_only:'the Group call, with no BG call',group:'the Group call',agree:'both calls agree',halfway:'halfway between the two calls',blend:'the weighted blend of the two calls'};
/** Source calib_suggest: blend ordinal ranks, never scores or money; an exact half is a human choice. */
export function suggestFinalBand(bg:PMBand|null,group:PMBand|null,mode:GroupMode,bgWeight=50):BandSuggestion {
 if(!group)return {band:bg,tie:null,why:'bg_only'};
 if(!bg||mode!=='blend')return {band:group,tie:null,why:bg?'group':'group_only'};
 if(bg===group)return {band:bg,tie:null,why:'agree'};
 const weighted=pmBands.indexOf(bg)*bgWeight+pmBands.indexOf(group)*(100-bgWeight),lo=Math.floor(weighted/100);
 if(weighted%100===50)return {band:null,tie:[pmBands[lo],pmBands[lo+1]],why:'halfway'};
 return {band:pmBands[Math.floor((weighted+50)/100)],tie:null,why:'blend'};
}
