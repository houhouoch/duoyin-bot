const fs=require('node:fs');
const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {config}=require('./lead-fields.cjs');
const {completion}=require('./delivery-integrity.cjs');
const patrolHealth=require('./patrol-health.cjs');
const syncWorkspace=(...args)=>require('./daily-document-extras.cjs').syncWorkspace(...args);
process.umask(0o077);
const os=require('node:os');
const base=__dirname,tools=process.env.XHS_MCP_HOME||path.join(os.homedir(),'.local/share/duoyin-bot/xiaohongshu-mcp-v2.5.0');
const node=process.execPath;
const profile=process.env.HERMES_MONITOR_HOME||path.join(os.homedir(),'.hermes/profiles/xhs-rental-monitor');
const backendUrl=(process.env.XHS_BACKEND_URL||'http://127.0.0.1:18061').replace(/\/$/,'');
const python=process.env.DUOYIN_PYTHON||path.join(base,'.venv/bin/python3');
const launchAgent=process.env.XHS_LAUNCH_AGENT||path.join(os.homedir(),'Library/LaunchAgents/ai.duoyin.xhs-readonly-backend.plist');
const lock=path.join(base,'four-hour.lock'),watchPath=path.join(base,'watchlist.json');
let locked=false;
let run={profile:'xhs-rental-monitor',started_at:new Date().toISOString(),pid:process.pid,status:'starting',stage:'lock'};
function state(stage,extra={}){run={...run,stage,...extra,updated_at:new Date().toISOString()};const p=path.join(base,'run-status.json');fs.writeFileSync(p+'.tmp',JSON.stringify(run,null,2),{mode:0o600});fs.renameSync(p+'.tmp',p);}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const log=s=>console.log(new Date().toISOString()+' '+s);
const watch=()=>JSON.parse(fs.readFileSync(watchPath,'utf8'));
const wecomCli=args=>execFileSync(process.env.WECOM_CLI_BIN||'wecom-cli',args,{env:{...process.env,WECOM_CLI_CONFIG_DIR:process.env.WECOM_CLI_CONFIG_DIR||path.join(os.homedir(),'.hermes/profiles/wecom-case-assistant/wecom-cli')},encoding:'utf8',timeout:args[0]==='smartpage'?120000:30000,maxBuffer:2*1024*1024});
const readJson=(name,fallback={})=>{try{return JSON.parse(fs.readFileSync(path.join(base,name),'utf8'));}catch{return fallback;}};
function syncOperations(reason,scanPath){
 const scan=scanPath&&fs.existsSync(scanPath)?JSON.parse(fs.readFileSync(scanPath,'utf8')):{};
 const review=readJson('deepseek-last-review.json');
 const currentReview=run.mode==='deliver-pending-only'||Date.parse(review.started_at||'')>=Date.parse(run.started_at)?review:{};
 const receipt=run.delivery_check||{};
 const ledger=patrolHealth.record(base,reason?{...run,error:reason,stage:'failed'}:run,scan,currentReview,receipt);
 const save=()=>{const target=path.join(base,'four-hour-delivery.json'),tmp=target+'.tmp';fs.writeFileSync(tmp,JSON.stringify(ledger,null,2),{mode:0o600});fs.renameSync(tmp,target);};
 try{const result=syncWorkspace({cli:wecomCli,delivery:ledger,save,base,scan:{started_at:run.started_at,complete:false},join:config.document_delivery?.join,allowFollowupEditing:config.document_layout?.followup_editor==='authorized_user'});state(run.stage,{document_workspace:result});return result;}
 catch{state(run.stage,{document_workspace:{status:'pending',reason:'运行记录已在本机保留，文档可写时补归档'}});return null;}
}
const notifyAlert=(reason,scanPath)=>syncOperations(reason,scanPath);
function checkDeliveryHealth(){
 const historyFile=path.join(base,'run-history.jsonl');const history=fs.existsSync(historyFile)?fs.readFileSync(historyFile,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
 state('delivery_preflight',{status:'running',schedule_audit:patrolHealth.scheduleAudit(history)});
 const ledger=readJson('four-hour-delivery.json');
 if(config.document_delivery?.mode!=='daily')ledger.daily_documents={};
 state('delivery_preflight',{delivery_health:patrolHealth.preflight(wecomCli,ledger,config.target_group)});
}
async function child(args){
 return new Promise((resolve,reject)=>{
  const p=spawn(node,args,{stdio:['inherit','inherit','pipe']});
  let stderr='';
  p.stderr.on('data',chunk=>{process.stderr.write(chunk);stderr=(stderr+chunk.toString()).slice(-16384);});
  p.once('error',reject);
  p.once('exit',code=>{
   if(code===0)return resolve();
   reject(require('./patrol-child-error.cjs').failure(args[0],code,stderr));
  });
 });
}
async function health(){try{return (await fetch(backendUrl+'/health',{signal:AbortSignal.timeout(3000)})).ok;}catch{return false;}}
(async()=>{
 if(fs.existsSync(lock)){
  let meta;try{meta=JSON.parse(fs.readFileSync(path.join(lock,'owner.json'),'utf8'));}catch{log('另一个流程正在获取巡检锁，本轮跳过');return;}
  let alive=false;try{process.kill(meta.pid,0);alive=true;}catch{}
  if(alive){log('已有巡检进行中，本轮未重复请求或发送');return;}
  fs.renameSync(lock,lock+'.stale-'+Date.now());
 }
 const legacy=execFileSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n').some(l=>l.includes(base+'/scan.cjs'));
 if(legacy){log('已有采集进程进行中，本轮未重复请求');return;}
 try{fs.mkdirSync(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST'){log('另一个流程已获取巡检锁，本轮跳过');return;}throw e;}locked=true;
 fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,started_at:new Date().toISOString()}),{mode:0o600});
 if(process.argv.includes('--refresh-document')){
  const previous=readJson('run-status.json'),previousReview=readJson('deepseek-last-review.json');
  if(previous.started_at&&previous.completed_at&&!['refresh-document','deliver-pending-only'].includes(previous.mode)){
   const previousScan=previous.scan_path&&fs.existsSync(previous.scan_path)?JSON.parse(fs.readFileSync(previous.scan_path,'utf8')):{};
   const review=Date.parse(previousReview.started_at)>=Date.parse(previous.started_at)&&Date.parse(previousReview.completed_at)<=Date.parse(previous.completed_at)?previousReview:{};
   const file=path.join(base,'run-history.jsonl'),history=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
   patrolHealth.record(base,{...previous,schedule_audit:patrolHealth.scheduleAudit(history,Date.parse(previous.started_at))},previousScan,review,previous.delivery_check||{});
  }
  state('document_refresh',{status:'running',mode:'refresh-document'});
  const ledger=readJson('four-hour-delivery.json');const save=()=>{const f=path.join(base,'four-hour-delivery.json');fs.writeFileSync(f+'.tmp',JSON.stringify(ledger,null,2),{mode:0o600});fs.renameSync(f+'.tmp',f);};
  const result=syncWorkspace({cli:wecomCli,delivery:ledger,save,base,scan:{started_at:run.started_at,complete:false},join:config.document_delivery?.join,allowFollowupEditing:config.document_layout?.followup_editor==='authorized_user'});
  state('finished',{status:'document_refreshed',document_workspace:result,completed_at:new Date().toISOString()});log('今日文档已按轮次和完整汇总读回核对，未发送群消息');return;
 }
 if(process.argv.includes('--deliver-pending-only')){
  state('pending_preflight',{status:'running',mode:'deliver-pending-only'});checkDeliveryHealth();
  const source=fs.readFileSync(path.join(base,'four-hour-latest-scan-path.txt'),'utf8').trim(),prior=JSON.parse(fs.readFileSync(source));
  if(Date.now()-Date.parse(prior.started_at)>4*3600000)throw Error('原采集记录已超过四小时，请运行完整巡检');
  const scan={started_at:run.started_at,window_start:new Date(require('./hot-pools.cjs').start(config.freshness_calendar_days)).toISOString(),complete:false,notes:prior.notes||[],searches:[],search_plan:[],warnings:[],maintenance:true,source_scan_path:source};
  const out=path.join(base,'four-hour-maintenance-'+run.started_at.replace(/[:.]/g,'-')+'.json');fs.writeFileSync(out,JSON.stringify(scan,null,2),{mode:0o600});
  state('notify',{scan_path:out,source_scan_path:source});await child([path.join(base,'notify-four-hour.cjs'),'--scan',out]);
  const receipt=readJson('four-hour-last-delivery.json');if(receipt.run_key!==scan.started_at||!['accepted_by_wecom','recorded_no_new'].includes(receipt.status))throw Error('待发线索回执不属于本轮');
  state('delivery_checked',{status:receipt.awaiting?'partial':'completed',delivery_check:receipt,delivery:receipt.status,pending:Object.keys(watch().outbox||{}).length,priority_deferred:receipt.deferred_priority,review_deferred:receipt.awaiting});
  syncOperations(null,out);state('finished',{completed_at:new Date().toISOString()});log('本轮既有合格线索已按新分类交付，运行问题仅归档文档');return;
 }

 if(process.argv.includes('--retry-notify-only')){
  const prior=JSON.parse(fs.readFileSync(path.join(base,'run-status.json'),'utf8'));
  const out=fs.readFileSync(path.join(base,'four-hour-latest-scan-path.txt'),'utf8').trim();
  if(prior.status!=='failed'||!['notify','notify_retry'].includes(prior.failed_stage)||prior.scan_path!==out)throw Error('仅允许重试刚失败的通知轮次');
  const scan=JSON.parse(fs.readFileSync(out,'utf8'));
  const scanTime=Date.parse(scan.started_at);
  if(!Number.isFinite(scanTime)||Date.now()-scanTime>4*3600000)throw Error('扫描结果已超过四小时，停止通知重试');
  const attachmentIndex=process.argv.indexOf('--attachment-manifest');
  const attachmentArgs=attachmentIndex>=0?['--attachment-manifest',process.argv[attachmentIndex+1]]:[];
  if(attachmentIndex>=0&&!attachmentArgs[1])throw Error('缺少附件校验清单');
  state('notify_retry',{status:'running',mode:'retry-notify-only',scan_path:out,source_started_at:scan.started_at});
  await child([path.join(base,'notify-four-hour.cjs'),'--scan',out,...attachmentArgs]);
  const w=watch(),review=config.deepseek_review?.enabled?JSON.parse(fs.readFileSync(path.join(base,'deepseek-last-review.json'),'utf8')):null;
  const delivery=JSON.parse(fs.readFileSync(path.join(base,'four-hour-last-delivery.json'),'utf8'));
  if(delivery.run_key!==scan.started_at||!['accepted_by_wecom','recorded_no_new'].includes(delivery.status))throw Error('通知重试回执核对失败');
  const pending=Object.keys(w.outbox||{}).length,priorityDeferred=delivery.deferred_priority||0,actionablePending=Math.max(0,pending-priorityDeferred),result=completion(scan,review,actionablePending,delivery);
  state('delivery_checked',{...result,searches:scan.searches?.length||0,rechecked:scan.rechecked,warnings:scan.warnings||[],pending,priority_deferred:priorityDeferred,review_deferred:review?.deferred||0,delivery_check:delivery});
  if(result.needs_alert){
   state('partial_alert',{alert_status:'attempting'});
   try{notifyAlert('partial',out);state('partial_alert',{alert_status:'submitted_or_already_reported'});}
   catch{state('partial_alert',{alert_status:'failed_or_uncertain'});throw Error('异常提醒发送失败或结果待核实，线索发送回执已保留');}
  }
  syncOperations(null,out);
  state('finished',{status:'recovered_notification',completed_at:new Date().toISOString()});
  log('通知重试完成，群消息回执和去重记录已核对');return;
 }
 if(process.argv.includes('--deliver-approved-only')){
  // Explicit maintenance recovery: reuse the same queue, lock, sender and receipts.
  // No inventory import, MCP reads or model calls occur in this mode.
  state('recovery_preflight',{status:'running',mode:'deliver-approved-only'});
  const expected=Number(process.argv[process.argv.indexOf('--expected-count')+1]);
  if(!process.argv.includes('--expected-count')||!Number.isInteger(expected)||expected<1)throw Error('补发必须指定确认的线索数量');
  const out=fs.readFileSync(path.join(base,'four-hour-latest-scan-path.txt'),'utf8').trim();
  const scan=JSON.parse(fs.readFileSync(out));
  const attachmentIndex=process.argv.indexOf('--attachment-manifest');
  const attachmentArgs=attachmentIndex>=0?['--attachment-manifest',process.argv[attachmentIndex+1]]:[];
  if(attachmentIndex>=0&&!attachmentArgs[1])throw Error('缺少附件校验清单');
  const preview=execFileSync(node,[path.join(base,'notify-four-hour.cjs'),'--scan',out,'--dry-run','--priority-bypass',...attachmentArgs],{encoding:'utf8',timeout:30000});
  const summary=JSON.parse(preview.split('\n')[0]);
  if(summary.expected!==expected)throw Error('补发预检数量与确认数量不同，未发送');
  state('recovery_notify',{scan_path:out,expected});
  await child([path.join(base,'notify-four-hour.cjs'),'--scan',out,'--priority-bypass',...attachmentArgs]);
  const receipt=JSON.parse(fs.readFileSync(path.join(base,'four-hour-last-delivery.json')));
  if(receipt.run_key!==scan.started_at||receipt.accepted!==expected||receipt.status!=='accepted_by_wecom')throw Error('补发回执核对失败，不能确认完成');
  state('finished',{status:'recovery_delivered',completed_at:new Date().toISOString(),pending:Object.keys(watch().outbox||{}).length,delivery_check:receipt});
  log('已补发通过复核的线索；原巡检失败记录保留，未重跑采集');return;
 }
 checkDeliveryHealth();
 state('inventory',{status:'running'});
 try{execFileSync(python,[path.join(base,'import-inventory.py')],{stdio:'pipe',timeout:60000});}
 catch{throw new Error('库存表读取失败，巡检已停止；请检查库存源文件位置，未使用过期库存静默继续');}
 state('merge');
 await child([path.join(base,'collaboration.cjs'),'merge','--owned']);
 if(watch().paused){notifyAlert(watch().paused.reason);state('paused',{status:'paused',reason:watch().paused.reason});log('采集已暂停，等待人工处理');return;}
 state('mcp_health');
 if(!await health()){
  // launchd owns the backend lifetime, independently of cron or chat sessions.
  const domain='gui/'+process.getuid(),service=domain+'/'+(process.env.XHS_LAUNCH_LABEL||'ai.duoyin.xhs-readonly-backend');
  try{execFileSync('/bin/launchctl',['print',service],{stdio:'ignore'});}
  catch{execFileSync('/bin/launchctl',['bootstrap',domain,launchAgent],{stdio:'ignore',timeout:10000});}
  for(let i=0;i<6&&!await health();i++)await wait(3000);
 }
 if(!await health()){notifyAlert('小红书MCP服务无法连接，采集已中断');throw new Error('MCP服务未连接');}
 const token=fs.readFileSync(path.join(tools,'private/api-token'),'utf8').trim();
 const response=await fetch(backendUrl+'/api/v1/login/status',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)});
 const login=await response.json();
 if(!response.ok||!login.success)throw new Error('小红书登录状态查询失败');
 if(login.data?.is_logged_in!==true){
  const state=watch();state.paused={reason:'小红书登录已失效，需要人工重新扫码',at:new Date().toISOString()};fs.writeFileSync(watchPath,JSON.stringify(state,null,2),{mode:0o600});
  notifyAlert(state.paused.reason);throw new Error('小红书登录已失效，已暂停');
 }
 await wait(config.request_interval_ms);
 const first=process.argv.includes('--first-round');
 const out=path.join(base,'four-hour-scan-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
 const args=[path.join(base,'scan.cjs'),'--days',String(config.freshness_calendar_days),'--out',out];
 state('scan',{scan_path:out});
 if(first)args.push('--keywords','相机 在哪租,相机 什么平台租,求租 R50,演唱会 镜头 求租','--max-detail','8','--recheck-max','4');
 try{await child(args);}catch(e){notifyAlert(watch().paused?.reason||e.message);throw e;}
 fs.writeFileSync(path.join(base,'four-hour-latest-scan-path.txt'),out,{mode:0o600});
 await child([path.join(base,'collaboration.cjs'),'merge','--owned']);
 state('deepseek');
 try{await child([path.join(base,'deepseek-review.cjs'),'--owned']);}
 catch{throw new Error('DeepSeek意图复核失败，候选已保留，下轮重试；请检查Key、余额、网络或模型响应');}
 state('notify');
 await child([path.join(base,'notify-four-hour.cjs'),'--scan',out,...(first?['--first-round']:[])]);
 const scan=JSON.parse(fs.readFileSync(out)),w=watch();
 const review=config.deepseek_review?.enabled?JSON.parse(fs.readFileSync(path.join(base,'deepseek-last-review.json'))):null;
 const delivery=JSON.parse(fs.readFileSync(path.join(base,'four-hour-last-delivery.json')));
 if(delivery.run_key!==scan.started_at+(first?':first':''))throw Error('发送回执不属于本轮，不能确认完成');
 const pending=Object.keys(w.outbox||{}).length,priorityDeferred=delivery.deferred_priority||0,actionablePending=Math.max(0,pending-priorityDeferred),result=completion(scan,review,actionablePending,delivery);
 state('delivery_checked',{...result,searches:scan.searches?.length||0,rechecked:scan.rechecked,warnings:scan.warnings||[],pending,priority_deferred:priorityDeferred,review_deferred:review?.deferred||0,delivery_check:delivery});
 if(result.needs_alert){
  state('partial_alert',{alert_status:'attempting'});
  try{notifyAlert('partial',out);state('partial_alert',{alert_status:'submitted_or_already_reported'});}
  catch{state('partial_alert',{alert_status:'failed_or_uncertain'});throw Error('异常提醒发送失败或结果待核实，线索发送回执已保留');}
 }
 syncOperations(null,out);
 state('finished',{completed_at:new Date().toISOString()});
 log(result.needs_alert?'本轮问题已归档文档':'本轮交付回执已核对，运行记录仅归档文档');
})().catch(e=>{
 if(locked)state('failed',{status:watch().paused?'paused':'failed',failed_stage:run.stage,error:e.message,...(e.child?{child_failure:{child:e.child,exit_code:e.exit_code,category:e.category}}:{}),completed_at:new Date().toISOString()});
 // All operational failures are retained locally and archived when the document is writable.
 if(locked)try{notifyAlert(e.message,run.scan_path&&fs.existsSync(run.scan_path)?run.scan_path:null);}catch{log('运行问题已在本机保留，等待文档可写后归档');}
 console.error('巡检未完成：'+e.message);process.exitCode=1;
}).finally(()=>{
 if(locked){fs.unlinkSync(path.join(lock,'owner.json'));fs.rmdirSync(lock);}
 if(locked)fs.appendFileSync(path.join(base,'run-history.jsonl'),JSON.stringify(run)+'\n',{mode:0o600});
});
