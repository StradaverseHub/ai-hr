/** Reported uncertainty is an estimate; this decision does not authenticate a location provider. */
export type GeofenceSite={id:string;lat:number;lng:number;radiusM:number|null};
export type GeofenceAssessment={
  outcome:'pass'|'location_required'|'invalid_location'|'poor_accuracy'|'no_assigned_site'|'outside_site';
  siteId:string|null;distanceM:number|null;radiusM:number|null;accuracyM:number|null;maximumAccuracyM:number|null;
};
export function assessGeofence(
  point:{lat?:number;lng?:number;accuracy?:number},sites:GeofenceSite[],maximumAccuracyM:number|null,
  distance:(lat:number,lng:number,siteLat:number,siteLng:number)=>number,
):GeofenceAssessment{
  const base={siteId:null,distanceM:null,radiusM:null,accuracyM:point.accuracy??null,maximumAccuracyM};
  if(point.lat==null||point.lng==null||point.accuracy==null)return {...base,outcome:'location_required'};
  if(![point.lat,point.lng,point.accuracy].every(Number.isFinite)||Math.abs(point.lat)>90||Math.abs(point.lng)>180||point.accuracy<0)
    return {...base,accuracyM:null,outcome:'invalid_location'};
  if(maximumAccuracyM!==null&&(!Number.isFinite(maximumAccuracyM)||maximumAccuracyM<=0||point.accuracy>maximumAccuracyM))
    return {...base,outcome:'poor_accuracy'};
  let nearest:GeofenceAssessment|null=null,match:GeofenceAssessment|null=null;
  for(const site of sites){
    const measured=distance(point.lat,point.lng,site.lat,site.lng);
    if(!Number.isFinite(measured)||measured<0)continue;
    const candidate={...base,siteId:site.id,distanceM:measured,radiusM:site.radiusM,outcome:'outside_site' as const};
    if(!nearest||measured<nearest.distanceM!)nearest=candidate;
    if(site.radiusM==null||!Number.isFinite(site.radiusM)||site.radiusM<0||measured+point.accuracy>site.radiusM)continue;
    if(!match||measured<match.distanceM!)match={...candidate,outcome:'pass'};
  }
  return match??nearest??{...base,outcome:'no_assigned_site'};
}
