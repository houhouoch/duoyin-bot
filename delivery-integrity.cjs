const {fingerprint}=require('./concise-message.cjs');
function assertSameKeys(expected,actual){
 if(new Set(expected).size!==expected.length||new Set(actual).size!==actual.length||expected.length!==actual.length||expected.some(k=>!actual.includes(k)))throw Error('发送数量核对失败：线索遗漏、重复或错配，未确认整批完成');
}
function prepare(pending,groups,{alertScope=''}={}){
 assertSameKeys(pending.map(x=>x.key),groups.flatMap(g=>g.keys));
 const leadGroups=groups.filter(g=>g.keys.length);let part=0;
 return groups.map(g=>{
  const rows=(g.content.match(/^- (?:正文|主评论|楼中楼|更正|状态更新)｜/gm)||[]).length;
  if(rows!==g.keys.length)throw Error('发送数量核对失败：正文条数与线索编号不一致');
  let content=g.content;
  if(g.keys.length){
   part++;
   content=content.replace(/^(### [^\n]*)/,`$1｜分组 ${part}/${leadGroups.length}`);
   if(part===leadGroups.length)content+='\n本批发送完毕\n';
  }
  if(Buffer.byteLength(content)>20480)throw Error('消息长度超过20480字节，未发送');
  return {...g,content,hash:fingerprint(content,alertScope?['alert:'+alertScope]:g.keys)};
 });
}
function verifyAccepted(planned,batches,history){
 for(const p of planned){
  const b=batches[p.hash];
  if(b?.status!=='accepted')throw Error('发送回执核对失败：仍有消息未确认成功');
  assertSameKeys(p.keys,b.keys);
  if(p.keys.some(k=>!history.sent?.[k]))throw Error('发送回执核对失败：去重记录尚未保存');
 }
 return {expected:planned.reduce((n,p)=>n+p.keys.length,0),accepted:planned.reduce((n,p)=>n+batches[p.hash].keys.length,0),batches:planned.length};
}
function completion(scan,review,pending,delivery){
 const incomplete=scan.complete===false||Boolean(scan.warnings?.length)||Boolean(scan.searches?.some(s=>s.error))||review?.status==='partial'||review?.status==='failed'||Boolean(review?.deferred)||pending>0;
 return {status:incomplete?'partial':'completed',needs_alert:incomplete,delivery:delivery?.status||'not_verified'};
}
module.exports={assertSameKeys,prepare,verifyAccepted,completion};
