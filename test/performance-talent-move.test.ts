import { expect,it } from 'vitest';
import { talentMovement,talentMoveAxes,talentMoveTarget } from '../packs/performance/onehr/talent-move-model';
const empty={performance:null,potential:null,performancePinned:false,potentialPinned:false,originalPerformance:null,originalPotential:null};
it('keeps untouched axes live, retains first origins across repeated moves, and suppresses unknown and pinned origins',()=>{
 expect(talentMoveAxes({performance:'ME',potential:'High'},{performance:'ME',potential:'Low'})).toEqual({pm:false,pot:true});
 expect(talentMoveAxes({performance:'ME',potential:'High'},{performance:null,potential:'High'})).toEqual({pm:false,pot:false});
 expect(talentMovement({...empty,potential:'Low',originalPotential:'High'},{performance:'ME',potential:'Low'})).toEqual({moved:true,fromCategory:'Star'});
 expect(talentMovement({...empty,potential:'Mid',originalPotential:'High'},{performance:'AE',potential:'Mid'})).toEqual({moved:true,fromCategory:'Super Star'});
 expect(talentMovement({...empty,potential:'High',originalPotential:'High'},{performance:'AE',potential:'High'})).toEqual({moved:false,fromCategory:'Super Star'});
 expect(talentMovement({...empty,performance:'UA',performancePinned:true,potential:'Low',potentialPinned:true},{performance:'UA',potential:'Low'})).toEqual({moved:false,fromCategory:'PIP/Improvement'});
 expect(talentMovement({...empty,performance:'AE'},{performance:'AE',potential:'High'})).toEqual({moved:false,fromCategory:null});
 // The source shows a nine-box origin, which differs from the five-band talent decision category.
 expect(talentMovement({...empty,performance:'ME',originalPerformance:'UA'},{performance:'ME',potential:'High'})).toEqual({moved:true,fromCategory:'Solid Core'});
});
it('uses source nearest-band defaults between columns and preserves the exact band when changing only potential',()=>{
 expect(talentMoveTarget({performance:'OU',potential:'High'},'high|Low')).toEqual({performance:'OU',potential:'Low',choices:[]});
 expect(talentMoveTarget({performance:'ME',potential:'High'},'low|Mid')).toEqual({performance:'BE',potential:'Mid',choices:['UA','BE']});
 expect(talentMoveTarget({performance:'ME',potential:'High'},'high|Mid')).toEqual({performance:'AE',potential:'Mid',choices:['AE','OU']});
 expect(talentMoveTarget({performance:'ME',potential:'High'},'high|Mid','OU')?.performance).toBe('OU');
 expect(talentMoveTarget({performance:'UA',potential:'Low'},'mid|High')).toEqual({performance:'ME',potential:'High',choices:['ME']});
 expect(talentMoveTarget({performance:'ME',potential:'High'},'forged|High')).toBeNull();
});
