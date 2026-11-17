import {routingRowSpecificity,type Routing} from './routing';
/** Preserve the winning explicit default and specificity/tie order; unreachable duplicate defaults are not copied into a new edit. */
export function routingForBuilder(routing:Routing,defaultGroup:string):Routing{
 const first=routing.rows.find(row=>routingRowSpecificity(row)===0);
 return {...routing,rows:[...routing.rows.filter(row=>routingRowSpecificity(row)>0),first??{match:{},assignTo:{kind:'group',groupId:defaultGroup}}]};
}
export function routingDefaultProblems(routing:Routing):string[]{return routing.rows.length&&routing.rows.filter(row=>routingRowSpecificity(row)===0).length===1&&routingRowSpecificity(routing.rows.at(-1)!)===0?[]:['Keep one explicit default row last.'];}
