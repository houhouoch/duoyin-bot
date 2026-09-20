const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const BASE=__dirname,ROOT=path.join(BASE,'collaboration');
const read=(p,d)=>fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):d;
const agents=()=>read(path.join(BASE,'monitor-config.json'),{}).collaboration_agents||['codex','workbuddy'];
function save(p,d){fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});const tmp=p+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(d,null,2),{mode:0o600});fs.renameSync(tmp,p);}
function getSubject(source,noteId,commentId){
 const file=fs.realpathSync(source);
 if(!file.startsWith(BASE+path.sep))throw new Error('来源必须是共享项目内的真实采集JSON');
 const raw=fs.readFileSync(file,'utf8');if(Buffer.byteLength(raw)>10*1024*1024)throw new Error('来源文件过大');
 const data=JSON.parse(raw),n=(data.notes||[]).find(n=>n.note_id===noteId&&!n.error);
 if(!n)throw new Error('来源中没有该帖子');
 const c=commentId?(n.signals||n.comments||[]).find(c=>c.id===commentId):null;
 if(commentId&&!c)throw new Error('来源中没有该评论');
 const url=new URL(n.url);if(url.hostname!=='www.xiaohongshu.com'||url.protocol!=='https:'||!url.pathname.endsWith('/'+noteId))throw new Error('原帖链接与帖子编号不匹配');
 return {source:file,source_hash:crypto.createHash('sha256').update(raw).digest('hex'),note:n,comment:c,started_at:data.started_at};
}
function submit({agent,source,note_id,comment_id,decision,reason}){
 if(!['codex','workbuddy'].includes(agent))throw new Error('agent 必须是 codex 或 workbuddy');
 if(!agents().includes(agent))throw new Error('该Agent已退出当前巡检任务，不能提交新记录');
 if(!['merchant','candidate','review'].includes(decision))throw new Error('decision 必须是 merchant、candidate 或 review');
 if(typeof reason!=='string'||!reason.trim()||reason.length>2000)throw new Error('需要简明的复核说明');
 const s=getSubject(source,note_id,comment_id),subject=s.comment||s.note;
 if(decision==='merchant'&&!subject.author_id)throw new Error('登记同行必须有真实作者ID，不能仅凭同名昵称');
 const payload={agent,source:s.source,source_hash:s.source_hash,note_id,comment_id:comment_id||null,decision,reason:reason.trim()};
 const id=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 const p=path.join(ROOT,'inbox',agent,id+'.json');
 if(!fs.existsSync(p))save(p,{...payload,id,submitted_at:new Date().toISOString(),author:subject.author,author_id:subject.author_id,evidence:s.comment?s.comment.text:s.note.title+'\n'+(s.note.desc||'')});
 return {status:'submitted',agent,decision,id,path:p};
}
function acquire(){
 const lock=path.join(BASE,'four-hour.lock');
 try{fs.mkdirSync(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')return null;throw e;}
 save(path.join(lock,'owner.json'),{pid:process.pid,started_at:new Date().toISOString()});
 return ()=>{fs.unlinkSync(path.join(lock,'owner.json'));fs.rmdirSync(lock);};
}
function merge({owned=false}={}){
 if(owned){const meta=read(path.join(BASE,'four-hour.lock','owner.json'),{});if(meta.pid!==process.ppid)throw new Error('只有持有巡检锁的父进程才能调用内部合并');}
 const release=owned?()=>{}:acquire();if(!release)return {status:'deferred',reason:'巡检或合并正在运行，提交已保留'};
 try{
  const registryPath=path.join(BASE,'merchant-registry.json'),watchPath=path.join(BASE,'watchlist.json'),ledgerPath=path.join(ROOT,'merge-ledger.json');
  const registry=read(registryPath,{version:1,authors:{}}),watch=read(watchPath,{notes:{},outbox:{}}),history=read(path.join(BASE,'leads-history.json'),{sent:{}}),ledger=read(ledgerPath,{items:{}});
  const {merchant,insufficientComment,fields}=require('./lead-fields.cjs');
  const files=['codex','workbuddy'].filter(agent=>agents().includes(agent)).flatMap(agent=>{const d=path.join(ROOT,'inbox',agent);return fs.existsSync(d)?fs.readdirSync(d).filter(n=>n.endsWith('.json')).map(n=>path.join(d,n)):[];});
  const pending=files.map(file=>({file,item:read(file,{})})).filter(x=>!ledger.items[x.item.id]).sort((a,b)=>a.item.submitted_at.localeCompare(b.item.submitted_at));
  let accepted=0,rejected=0;
  // 同行登记先合并，确保同一批中的客户候选也会应用新发现的同行排除。
  pending.sort((a,b)=>Number(b.item.decision==='merchant')-Number(a.item.decision==='merchant'));
  for(const {item} of pending){
   try{
    if(!['codex','workbuddy'].includes(item.agent)||!['merchant','candidate','review'].includes(item.decision))throw new Error('提交格式无效');
    if(!agents().includes(item.agent))throw new Error('该Agent已退出当前任务');
    const s=getSubject(item.source,item.note_id,item.comment_id),n=s.note,c=s.comment,subject=c||n;
    if(s.source_hash!==item.source_hash)throw new Error('来源文件已改变，请基于当前证据重新提交');
    if(item.decision==='merchant'){
     if(!subject.author_id)throw new Error('缺少作者ID');
     const a=registry.authors[subject.author_id]||{author_id:subject.author_id,name:subject.author,first_reported_at:item.submitted_at,evidence:[]};
     if(!a.evidence.some(e=>e.submission_id===item.id))a.evidence.push({submission_id:item.id,agent:item.agent,reason:item.reason,source:item.source,note_id:n.note_id,comment_id:c?.id||null,text:c?c.text:n.title+'\n'+(n.desc||''),reported_at:item.submitted_at});
     registry.authors[subject.author_id]=a;save(registryPath,registry);
    }else if(item.decision==='candidate'){
     const text=c?c.text:n.title+'\n'+(n.desc||''),time=c?c.published_at_ms:n.published_at_ms;
     const knownMerchant=registry.authors[subject.author_id]||merchant(subject.author,subject.author_id,text);
     if(knownMerchant||c&&insufficientComment(text))throw new Error('同行或缺乏求租依据，未入通知队列');
     if(c?!/^demand-/.test(c.kind):!n.is_demand_post||n.resolved)throw new Error('原始采集未支持该求租分类，需先复核');
     const {config}=require('./lead-fields.cjs'),start=Math.floor((Date.now()+8*3600000)/86400000)*86400000-8*3600000-(config.freshness_calendar_days-1)*86400000;
     if(!Number.isFinite(time)||time<start||time>Date.now())throw new Error('超出近期窗口或发布时间未知');
     const key=c?'comment:'+n.note_id+':'+c.id:'note:'+n.note_id;
     if(!history.sent[key])watch.outbox[key] ||= {key,type:c?'comment':'note',note_id:n.note_id,title:n.title,author:n.author,author_id:n.author_id,url:n.url,published_at_ms:n.published_at_ms,desc:n.desc,comment:c||undefined,...fields(text),first_discovered_at:s.started_at||item.submitted_at,old_post_comment:n.published_at_ms<start,classification:'协作复核候选，待人工确认',contributor:item.agent,contribution_source:item.source};
     save(watchPath,watch);
    }
    ledger.items[item.id]={status:'accepted',agent:item.agent,decision:item.decision,reason:item.reason,source:item.source,note_id:item.note_id,comment_id:item.comment_id,merged_at:new Date().toISOString()};accepted++;
   }catch(e){ledger.items[item.id]={status:'rejected',agent:item.agent,decision:item.decision,error:e.message,merged_at:new Date().toISOString()};rejected++;}
   save(ledgerPath,ledger);
  }
  return {status:'merged',accepted,rejected,merchant_authors:Object.keys(registry.authors).length};
 }finally{release();}
}
module.exports={submit,merge};
if(require.main===module){
 try{const args=process.argv.slice(2),arg=k=>{const i=args.indexOf('--'+k);return i<0?undefined:args[i+1];};
  const result=args[0]==='submit'?submit({agent:arg('agent'),source:arg('source'),note_id:arg('note'),comment_id:arg('comment'),decision:arg('decision'),reason:arg('reason')}):args[0]==='merge'?merge({owned:args.includes('--owned')}):(()=>{throw new Error('使用 submit 或 merge，详见 AGENTS.md');})();
  console.log(JSON.stringify(result));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
