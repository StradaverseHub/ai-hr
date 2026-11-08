/** Public traversal of the ORIGINAL Program nodes and their attached JSDoc.
 * No tag caches, service-token graph, AST writes, reparsing or parent fixups. */
import assert from 'node:assert/strict';
export function walkNativeApplicationSyntax(ts,file,observe,check=()=>{}){
 const seen=new WeakSet();
 function visit(node){
  check();if(seen.has(node))return;seen.add(node);observe(node);
  // Parser attachments are wholly inside the host's leading-trivia span.
  // Explicit file avoids parent lookup on unchanged, unparented native nodes.
  // EOF.getChildren also exposes its real trailing/EOF-only JSDoc attachments.
  if(node.pos>=0&&node.end<=file.text.length){
   const start=node.getStart(file);assert(Number.isInteger(start)&&start>=node.pos&&start<=node.end,'Native leading-trivia range');
   if(file.text.slice(node.pos,start).includes('/**')){
    for(const child of node.getChildren(file)){check();if(ts.isJSDoc(child))visit(child);}
   }
  }
  // getChildren's service tokens/SyntaxLists are deliberately NOT traversed.
  ts.forEachChild(node,visit);
 }
 visit(file);
}
