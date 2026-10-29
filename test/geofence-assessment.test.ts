import {describe,expect,it} from 'vitest';
import {assessGeofence,type GeofenceSite} from '../lib/geofence-assessment';
const site=(id:string,lat:number,radiusM:number|null):GeofenceSite=>({id,lat,lng:0,radiusM});
const distance=(lat:number,_lng:number,siteLat:number)=>Math.abs(lat-siteLat);
const check=(lat:number,accuracy:number,sites=[site('own',0,50)],maximum:number|null=null)=>assessGeofence({lat,lng:0,accuracy},sites,maximum,distance);
describe('reported uncertainty containment',()=>{
  it('requires the complete uncertainty circle inside the site including the exact boundary',()=>{
    expect(check(0,50).outcome).toBe('pass');expect(check(25,25).outcome).toBe('pass');
    expect(check(25,25.01).outcome).toBe('outside_site');expect(check(0,5000).outcome).toBe('outside_site');
    expect(check(51,0).outcome).toBe('outside_site');expect(check(0,0).outcome).toBe('pass');
  });
  it('chooses the nearest passing site even when a nearer site cannot contain the uncertainty',()=>{
    const result=check(0,20,[site('near',5,10),site('passing',30,50),site('far',40,100)]);
    expect(result).toMatchObject({outcome:'pass',siteId:'passing',distanceM:30,radiusM:50,accuracyM:20});
  });
  it('applies only an explicit company uncertainty maximum and never enlarges a fence',()=>{
    expect(check(0,11,undefined,10).outcome).toBe('poor_accuracy');expect(check(0,10,undefined,10).outcome).toBe('pass');
    expect(check(0,51,undefined,100).outcome).toBe('outside_site');expect(check(0,11).outcome).toBe('pass');
  });
  it('fails closed for missing, negative, nonfinite and out of range coordinates',()=>{
    expect(assessGeofence({lat:0,lng:0},[],null,distance).outcome).toBe('location_required');
    for(const accuracy of [-1,NaN,Infinity])expect(check(0,accuracy).outcome).toBe('invalid_location');
    for(const lat of [91,-91,NaN])expect(check(lat,1).outcome).toBe('invalid_location');
    expect(assessGeofence({lat:0,lng:181,accuracy:1},[],null,distance).outcome).toBe('invalid_location');
  });
  it('refuses no assigned site and absent radius without manufacturing a match',()=>{
    expect(check(0,1,[]).outcome).toBe('no_assigned_site');
    expect(check(0,0,[site('unset',0,null)])).toMatchObject({outcome:'outside_site',siteId:'unset',radiusM:null});
  });
});
