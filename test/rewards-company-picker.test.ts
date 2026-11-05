import {describe,it,expect} from 'vitest';
import {rewardCompanyBusinessGroup} from '../packs/rewards/company-picker';
describe('Rewards company hierarchy identity',()=>{
 it('uses the root People Management ancestor instead of a leaf parent or name match',()=>{
  const tree=[{id:'root',name:'Business Group',parentId:null},{id:'middle',name:'Intermediate legal entity',parentId:'root'},{id:'leaf',name:'Independent legal name',parentId:'middle'},{id:'solo',name:'Business Group',parentId:null}];
  expect(rewardCompanyBusinessGroup('leaf',tree)).toEqual({groupId:'root',groupName:'Business Group'});expect(rewardCompanyBusinessGroup('root',tree)).toEqual({groupId:'root',groupName:'Business Group'});expect(rewardCompanyBusinessGroup('solo',tree)).toBeNull();
 });
 it('does not invent a group for a cycle or out-of-scope ancestor',()=>{
  expect(rewardCompanyBusinessGroup('a',[{id:'a',name:'A',parentId:'b'},{id:'b',name:'B',parentId:'a'}])).toBeNull();
  expect(rewardCompanyBusinessGroup('a',[{id:'a',name:'A',parentId:'missing'}])).toBeNull();
 });
});
