const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function scheduleAudit(history,now=Date.now()){
 const start=now-86400000,slots=[];
 const first=Math.ceil((start+28800000)/14400000)*14400000-28800000;
 for(let time=first;time<now-1800000;time+=14400000){
  const matching=history.filter(r=>Math.abs(Date.parse(r.started_at)-time)<1800000&&!['deliver-pending-only','refresh-document'].includes(r.mode));
  slots.push({scheduled_at:new Date(time).toISOString(),status:matching.length?'recorded':'missing'});
 }
 return {checked_at:new Date(now).toISOString(),slots,missing:slots.filter(x=>x.status==='missing').map(x=>x.scheduled_at)};
}
function preflight(cli,delivery,target){
 const version=cli(['--version']).match(/(\d+)\.(\d+)\.(\d+)/);if(!version||Number(version[1])<1||(version[1]==='1'&&Number(version[2])<2)||(version[1]==='1'&&version[2]==='2'&&Number(version[3])<1))throw Error('企业微信CLI版本不符合要求');
 if(cli(['auth','show','--status']).trim()!=='authorized')throw Error('企业微信机器人授权未通过');
 let sessions;try{sessions=JSON.parse(cli(['message','aibot','sessions','list']));}catch{throw Error('企业微信消息权限或会话查询失败');}
 if(sessions.sessions?.filter(s=>s.chat_name===target&&s.chat_type==='group').length!==1)throw Error('企业微信目标群未唯一匹配');
 const recent=Object.values(delivery.daily_documents||{}).filter(x=>x.docid).at(-1);
 if(recent){
  let r;try{r=JSON.parse(cli(['smartpage','pages','get','--json',JSON.stringify({docid:recent.docid})]));}catch{throw Error('企业微信文档读取权限检查失败');}
  if(r.error||r.errcode!==0)throw Error('企业微信文档读取权限检查失败');
 }
 return {checked_at:new Date().toISOString(),message_session:'ready',document_read:recent?'ready':'no_existing_document',document_write:'verified_only_when_written'};
}
function updateQueryStats(watch,scan){
 watch.query_stats||={};
 for(const search of scan.searches||[]){
  const s=watch.query_stats[search.keyword]||={attempts:0,successes:0,elapsed_ms:0,details_read:0,demand_candidates:0};
  const events=(scan.requests||[]).filter(x=>x.endpoint==='search'&&x.keyword===search.keyword);
  s.attempts++;s.successes+=search.error?0:1;s.elapsed_ms+=events.reduce((n,x)=>n+x.elapsed_ms,0);s.last_attempted_at=scan.started_at;
  const ids=new Set((search.feeds||[]).map(x=>x.id)),notes=(scan.notes||[]).filter(n=>!n.error&&ids.has(n.note_id));
  s.details_read+=notes.length;s.demand_candidates+=notes.reduce((n,x)=>n+(x.new_demand_candidates||0),0);
 }
}
function detailTimeout(job,watch,settings={}){
 const health=watch.detail_health?.[job.id];
 if(job.demand||watch.notes?.[job.id]?.is_demand_post)return 120000;
 return health?.failures>=1||job.merchant?settings.low_priority_detail_timeout_ms||60000:settings.detail_timeout_ms||90000;
}
function detailResult(watch,id,event,settings={},now=Date.now()){
 watch.detail_health||={};const h=watch.detail_health[id]||={failures:0};
 h.last_attempted_at=new Date(now).toISOString();h.last_elapsed_ms=event.elapsed_ms;
 if(event.status==='success'){h.failures=0;delete h.next_attempt_at;}
 else{h.failures++;if(h.failures>=2)h.next_attempt_at=new Date(now+(settings.failure_cooldown_hours||2)*3600000).toISOString();}
}
function record(base,run,scan={},review={},receipt={}){
 const watch=JSON.parse(fs.readFileSync(path.join(base,'watchlist.json'),'utf8'));
 const file=path.join(base,'four-hour-delivery.json');const ledger=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};ledger.operational_notes||={};
 const id=crypto.createHash('sha256').update(run.started_at+'|'+(run.stage==='failed'?'failed':'finished')).digest('hex');
 ledger.operational_notes[id]||={id,started_at:run.started_at,status:'pending',created_at:new Date().toISOString(),run_status:run.status,round_started_at:scan.started_at||run.started_at,scan_path:run.scan_path||null,run_mode:run.mode||null,queries:(scan.searches||[]).map(s=>({keyword:s.keyword,error:Boolean(s.error)})),error:run.error||null,searches_completed:scan.searches?.length||0,searches_planned:scan.search_plan?.length||0,searches_unexecuted:scan.searches_unexecuted||[],unread_candidates_pending:scan.unread_candidates_pending,detail_failures:scan.notes?.filter(n=>n.error).length||0,warnings:scan.warnings||[],review_pending:review.deferred||0,manual_review_pending:review.manual_review_candidates||0,accepted:receipt.accepted||0,delivery_confirmed_at:receipt.status==='accepted_by_wecom'&&receipt.accepted>0?receipt.checked_at:null,schedule_missing:run.schedule_audit?.missing||[],manual_candidates:Object.values(watch.outbox||{}).filter(x=>x.ai_review_error&&!require('./lead-fields.cjs').peerExcluded(x,watch)).slice(0,100)};
 const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(ledger,null,2),{mode:0o600});fs.renameSync(tmp,file);return ledger;
}
module.exports={scheduleAudit,preflight,updateQueryStats,detailTimeout,detailResult,record};
