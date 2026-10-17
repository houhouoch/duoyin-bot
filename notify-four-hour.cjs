const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {config,merchant,fields,insufficientComment,sourceMerchant:classifySource,peerExcluded}=require('./lead-fields.cjs');
const {approved}=require('./deepseek-review.cjs');
const {validity}=require('./demand-validity.cjs');
const {start:windowStart}=require('./hot-pools.cjs');
const {render}=require('./concise-message.cjs');
const {deliveryPicks}=require('./rental-strategy.cjs');
const {prepare,verifyAccepted,assertSameKeys}=require('./delivery-integrity.cjs');
const base=__dirname;
const watchPath=path.join(base,'watchlist.json'),historyPath=path.join(base,'leads-history.json');
const deliveryPath=path.join(base,'four-hour-delivery.json');
const load=(p,def)=>fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):def;
const save=(p,data)=>{const tmp=p+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2),{mode:0o600});fs.renameSync(tmp,p);};
const env={...process.env,WECOM_CLI_CONFIG_DIR:process.env.WECOM_CLI_CONFIG_DIR||path.join(require('node:os').homedir(),'.hermes/profiles/wecom-case-assistant/wecom-cli')};
const cli=args=>execFileSync(process.env.WECOM_CLI_BIN||'wecom-cli',args,{env,encoding:'utf8',timeout:args[0]==='smartpage'?120000:30000,maxBuffer:2*1024*1024});
const dry=process.argv.includes('--dry-run');
const attachmentIndex=process.argv.indexOf('--attachment-manifest');
const attachmentManifest=attachmentIndex>=0?process.argv[attachmentIndex+1]:null;
if(attachmentIndex>=0&&!attachmentManifest)throw Error('缺少附件校验清单');
const scanIndex=process.argv.indexOf('--scan');
const scan=scanIndex>=0?load(process.argv[scanIndex+1],{}):{};
const alertIndex=process.argv.indexOf('--alert');
const alert=alertIndex>=0?process.argv[alertIndex+1]:null;
const alertRunIndex=process.argv.indexOf('--alert-run');
const alertRun=alertRunIndex>=0?process.argv[alertRunIndex+1]:null;
if(alertRunIndex>=0&&!alertRun)throw Error('缺少异常提醒轮次');
if(alert&&config.notification_policy?.operational_issues==='document_only'){console.log(JSON.stringify({status:'document_only',dry_run:dry,posts:0,comments:0,statuses:0,expected:0,messages:0,reason:'运行问题只归档文档，不单独发群'}));process.exit(0);}
const watch=load(watchPath,{notes:{},outbox:{}}),history=load(historyPath,{sent:{}}),delivery=load(deliveryPath,{batches:{},reports:{}});
watch.outbox ||= {};watch.suppressed ||= {};
const prior=load(path.join(base,'scan-latest.json'),{});
const observedNotes=new Map([...(prior.notes||[]),...(scan.notes||[])].map(n=>[n.note_id,n]));
const sourceMerchant=x=>classifySource(x,watch,observedNotes);
for(const n of prior.notes||[]){
 if(!(config.merchant_author_ids||[]).includes(n.author_id))continue;
 const key='correction:'+n.note_id;
 if(!history.sent?.[key])watch.outbox[key]={key,type:'correction',note_id:n.note_id,title:n.title,author:n.author,author_id:n.author_id,url:n.url,evidence:n.desc||n.title};
 if(watch.notes?.[n.note_id]){watch.notes[n.note_id].is_demand_post=false;watch.notes[n.note_id].manual_merchant=true;}
}
for(const [key,x] of Object.entries(watch.outbox)){
 if(x.type==='note'||x.type==='comment')Object.assign(x,fields(x.evidence||x.comment?.text||x.desc||''));
 const excludedPeer=peerExcluded(x,watch,observedNotes);
 const excluded=excludedPeer||(x.type==='comment'?merchant(x.comment.author,x.comment.author_id,x.comment.text):x.type==='note'&&sourceMerchant(x));
 const insufficient=x.type==='comment'&&insufficientComment(x.comment.text);
 const timing=validity(x);
 const uncertain=Object.values(delivery.batches||{}).some(b=>['attempting','uncertain'].includes(b.status)&&b.keys?.includes(key));
 if(excludedPeer&&uncertain)continue;
 if(!excluded&&!insufficient&&!uncertain&&timing.status==='expired'){
  watch.suppressed[key]={...x,reason:'明确用机日期已过，未推送',demand_validity:timing,suppressed_at:new Date().toISOString()};delete watch.outbox[key];continue;
 }
 if(excluded||insufficient){watch.suppressed[key]={...x,reason:excludedPeer?'用户停用同行来源线索，未纳入':excluded?'同行供给／推广，不作为客户线索':'意图依据不足或已租过的经验分享',suppressed_at:new Date().toISOString()};delete watch.outbox[key];}
}
delivery.batches ||= {};delivery.reports ||= {};history.sent ||= {};
for(const batch of Object.values(delivery.batches)){
 if(batch.status==='attempting')batch.status='uncertain';
 if(batch.status==='accepted')for(const key of batch.keys){history.sent[key] ||= batch.accepted_at;delete watch.outbox[key];}
}
if(!dry){save(deliveryPath,delivery);save(historyPath,history);save(watchPath,watch);}
const blocked=new Set(Object.values(delivery.batches).filter(b=>b.status==='uncertain').flatMap(b=>b.keys));
const start=scan.window_start?Date.parse(scan.window_start):windowStart(config.freshness_calendar_days);
const eligible=Object.values(watch.outbox||{}).filter(x=>!history.sent[x.key]&&!blocked.has(x.key)&&(x.type==='correction'||x.type==='resolved'||(Number.isFinite(x.comment?.published_at_ms||x.published_at_ms)&&(x.comment?.published_at_ms||x.published_at_ms)>=start&&(x.comment?.published_at_ms||x.published_at_ms)<=Date.now()))).filter(x=>!peerExcluded(x,watch,observedNotes)).filter(x=>x.type==='correction'||(x.type==='comment'?!merchant(x.comment.author,x.comment.author_id,x.comment.text):!sourceMerchant(x))).map(x=>({...x,source_is_merchant:sourceMerchant(x)}));
const awaiting=config.deepseek_review?.enabled?eligible.filter(x=>['note','comment'].includes(x.type)&&!approved(x)):[];
// Alerts never drain the lead queue, particularly when model review has failed.
const approvedEligible=eligible.filter(x=>!config.deepseek_review?.enabled||!['note','comment'].includes(x.type)||approved(x));
// Explicit, count-confirmed maintenance recovery must reproduce its approved
// manifest exactly. Normal patrols use the per-round priority quotas.
const prioritized=process.argv.includes('--priority-bypass')?{selected:approvedEligible,deferred:[]}:deliveryPicks(approvedEligible,config.delivery_priority);
const pending=alert?[]:prioritized.selected;
const posts=pending.filter(x=>x.type==='note'),comments=pending.filter(x=>x.type==='comment'),statuses=pending.filter(x=>x.type==='resolved'||x.type==='correction');
const groups=render({pending,scan,config,alert,awaiting:awaiting.length,blocked:blocked.size});
const runKey=alert?'alert:'+crypto.createHash('sha256').update(alert).digest('hex')+(scan.started_at?':'+scan.started_at:alertRun?':'+alertRun:''):(scan.started_at||'manual')+(process.argv.includes('--first-round')?':first':'');
const resultPath=path.join(base,alert?'four-hour-last-alert.json':'four-hour-last-delivery.json');
if(delivery.reports[runKey]&&!pending.length){
 const result={status:'already_reported',run_key:runKey,checked_at:new Date().toISOString(),awaiting:awaiting.length,blocked:blocked.size};
 if(!dry)save(resultPath,result);console.log(JSON.stringify({...result,group:config.target_group}));process.exit(0);
}
let planned=prepare(pending,groups,{alertScope:alert?runKey:''});
if(attachmentManifest&&!alert&&pending.length){
 const doc=require('./document-delivery.cjs').buildDocument(pending,scan,config,Date.now(),blocked.size);
 planned=[require('./attachment-delivery.cjs').prepareAttachment(doc,attachmentManifest)];
}
if(dry){
 const document=!alert&&pending.length&&config.document_delivery?.enabled?require('./document-delivery.cjs').buildDocument(pending,scan,config,Date.now(),blocked.size):null;
 console.log(JSON.stringify({dry_run:true,posts:posts.length,comments:comments.length,statuses:statuses.length,deferred_priority:prioritized.deferred.length,batches:document?1:planned.length,format:attachmentManifest||config.document_delivery?.mode==='pdf'?'file':document?'document-link':'markdown',bytes:document?[Buffer.byteLength(document.content)]:planned.map(g=>Buffer.byteLength(g.content)),expected:pending.length}));
 console.log(document?document.content:planned.map(g=>g.content).join('\n'));process.exit(0);
}
if(!alert&&!pending.length&&!attachmentManifest&&config.document_delivery?.mode==='pdf'){
 delivery.runs ||= {};delivery.runs[runKey]={status:'recorded_no_new',expected:0,keys:[],hashes:[],at:new Date().toISOString()};
 delivery.reports[runKey]=new Date().toISOString();save(deliveryPath,delivery);
 const result={status:'recorded_no_new',run_key:runKey,expected:0,accepted:0,messages:0,awaiting:awaiting.length,blocked:blocked.size,deferred_priority:prioritized.deferred.length,checked_at:new Date().toISOString()};save(resultPath,result);
 console.log(JSON.stringify({...result,group:config.target_group}));process.exit(0);
}
const version=cli(['--version']).match(/(\d+)\.(\d+)\.(\d+)/);
if(!version||Number(version[1])<1||(version[1]==='1'&&Number(version[2])<2)||(version[1]==='1'&&version[2]==='2'&&Number(version[3])<1))throw new Error('企业微信CLI版本不符合要求');
if(cli(['auth','show','--status']).trim()!=='authorized')throw new Error('企业微信授权未通过');
const sessions=JSON.parse(cli(['message','aibot','sessions','list']));
const matches=sessions.sessions.filter(s=>s.chat_name===config.target_group&&s.chat_type==='group');
if(matches.length!==1)throw new Error('目标群未唯一匹配：'+config.target_group);
if(!attachmentManifest&&!alert&&pending.length&&config.document_delivery?.enabled&&config.document_delivery?.mode==='pdf'){
 const doc=require('./document-delivery.cjs').buildDocument(pending,scan,config,Date.now(),blocked.size);
 planned=[require('./pdf-delivery.cjs').preparePdf(doc,base)];
}else if(!attachmentManifest&&!alert&&config.document_delivery?.enabled&&config.document_delivery?.mode==='daily'){
 const daily=require('./daily-document-delivery.cjs'),resume=daily.resumeDailyDocuments(pending,delivery,base,watch,{cli,save:()=>save(deliveryPath,delivery)});
 const context={cli,delivery,save:()=>save(deliveryPath,delivery),base,join:config.document_delivery.join,scan,awaiting:awaiting.length,blocked:blocked.size};
 planned=resume.documents.map(r=>daily.publishDailyDocument(r.doc,{...context,scan:r.scan}));
 const document=resume.fresh.length?require('./document-delivery.cjs').buildDocument(resume.fresh,scan,config,Date.now(),blocked.size):null;
 const published=document||!planned.length?daily.publishDailyDocument(document,context):null;
 if(published?.quiet){
  delivery.runs ||= {};delivery.runs[runKey]={status:'recorded_no_new',expected:0,keys:[],hashes:[],at:new Date().toISOString()};
  delivery.reports[runKey]=new Date().toISOString();save(deliveryPath,delivery);
  const result={status:'recorded_no_new',run_key:runKey,expected:0,accepted:0,messages:0,awaiting:awaiting.length,blocked:blocked.size,deferred_priority:prioritized.deferred.length,...published,checked_at:new Date().toISOString()};save(resultPath,result);
  console.log(JSON.stringify({...result,group:config.target_group}));process.exit(0);
 }
 if(published)planned.push(published);
}else if(!attachmentManifest&&!alert&&pending.length&&config.document_delivery?.enabled){
 const {buildDocument,publishDocument}=require('./document-delivery.cjs');
 const document=buildDocument(pending,scan,config,Date.now(),blocked.size);
 planned=[publishDocument(document,{cli,delivery,save:()=>save(deliveryPath,delivery),base,join:config.document_delivery.join})];
}
assertSameKeys(pending.map(x=>x.key),planned.flatMap(x=>x.keys));
let accepted=0;
delivery.runs ||= {};
delivery.runs[runKey]={status:'planned',expected:pending.length,keys:pending.map(x=>x.key),hashes:planned.map(g=>g.hash),at:new Date().toISOString()};save(deliveryPath,delivery);
for(const batch of planned){
 const {content,hash}=batch;
 if(delivery.batches[hash]?.status==='accepted')continue;
 if(delivery.batches[hash]?.status==='uncertain')throw new Error('发送状态不确定，停止自动重发');
 const payload=batch.attachment_path?require('./attachment-delivery.cjs').uploadAttachment(batch,cli):{msg_type:'markdown',markdown:{content}};
 delivery.batches[hash]={status:'attempting',keys:batch.keys,at:new Date().toISOString(),...(batch.attachment_path?{attachment_path:batch.attachment_path,attachment_sha256:batch.attachment_sha256}:{})};save(deliveryPath,delivery);
 let result;
 try{result=JSON.parse(cli(['message','aibot','send','--json',JSON.stringify({chat_id:matches[0].chat_id,...payload})]));}
 catch(e){delivery.batches[hash].status='uncertain';save(deliveryPath,delivery);throw new Error('发送结果待核实，未自动重试');}
 if(result.success!==true){delivery.batches[hash].status='failed';save(deliveryPath,delivery);throw new Error('企业微信明确返回发送失败，线索保留待重试');}
 const time=new Date().toISOString();
 delivery.batches[hash].status='accepted';delivery.batches[hash].accepted_at=time;save(deliveryPath,delivery);
 for(const key of batch.keys){history.sent[key]=time;delete watch.outbox[key];}
 history.updated_at=time;save(historyPath,history);save(watchPath,watch);
 accepted++;
}
const verified=verifyAccepted(planned,delivery.batches,history);
delivery.runs[runKey]={...delivery.runs[runKey],status:'verified',...verified,verified_at:new Date().toISOString()};
delivery.reports[runKey]=new Date().toISOString();save(deliveryPath,delivery);
// An operational alert must not replace the last lead-message artifact.
const artifact=path.join(base,alert?'four-hour-latest-alert.md':'four-hour-latest-message.md');fs.writeFileSync(artifact,planned.map(g=>g.content).join('\n\n'),{mode:0o600});
const result={status:'accepted_by_wecom',run_key:runKey,...verified,awaiting:awaiting.length,blocked:blocked.size,deferred_priority:prioritized.deferred.length,messages:accepted,...(planned[0]?.document_url?{document_url:planned[0].document_url,document_verified:true,...(planned[0].overview_url?{overview_url:planned[0].overview_url}:{})}:{}),...(planned[0]?.attachment_path?{format:'file',attachment_path:planned[0].attachment_path,attachment_sha256:planned[0].attachment_sha256}:{}),checked_at:new Date().toISOString()};save(resultPath,result);
console.log(JSON.stringify({...result,group:config.target_group,posts:posts.length,comments:comments.length,statuses:statuses.length,artifact}));
