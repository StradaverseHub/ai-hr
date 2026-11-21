import assert from 'node:assert/strict';
import test from 'node:test';
import {createRouteHandlerInventory,successfulHandlerReceipts} from '../../scripts/performance/browser-route-handler-coverage.mjs';

test('uses compiled static and dynamic handler templates and omits rendered pages',()=>{
 const inventory=createRouteHandlerInventory({
  '/(secure)/api/payslips/route':'/api/payslips',
  '/api/payslips/[id]/route':'/api/payslips/[id]',
  '/api/payslips/[...path]/route':'/api/payslips/[...path]',
  '/admin/personnel/[id]/page':'/admin/personnel/[id]',
 },{dynamicRoutes:[
  {page:'/api/payslips/[id]',regex:'^/api/payslips/[^/]+$'},
  {page:'/api/payslips/[...path]',regex:'^/api/payslips/.+$'},
  {page:'/admin/personnel/[id]',regex:'^/admin/personnel/[^/]+$'},
 ]});
 assert.equal(inventory.registered.length,3);
 assert.equal(inventory.match('/api/payslips/','GET'),'/api/payslips');
 assert.equal(inventory.match('/api/payslips/private-record','POST'),'/api/payslips/[id]');
 assert.equal(inventory.match('/api/payslips/year/private-record','GET'),'/api/payslips/[...path]');
 assert.equal(inventory.match('/admin/personnel/private-record','POST'),null);
 assert.equal(inventory.match('/api/payslips','TRACE'),null);
});

test('does not count headers alone or expose unapproved request details',()=>{
 const accepted={template:'/api/tasks/[id]',method:'GET',status:200,completionMs:321,privateUrl:'omit'};
 assert.deepEqual(successfulHandlerReceipts([
  accepted,{...accepted,status:403},{...accepted,completionMs:undefined},{...accepted,status:307},
 ]),[{template:'/api/tasks/[id]',method:'GET',status:200,completionMs:321}]);
});
