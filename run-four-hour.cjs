const fs=require('node:fs');
const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {config}=require('./lead-fields.cjs');
const {completion}=require('./delivery-integrity.cjs');
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
const notifyAlert=(reason,scanPath)=>execFileSync(node,[path.join(base,'notify-four-hour.cjs'),'--alert',reason,...(scanPath?['--scan',scanPath]:[])],{stdio:'inherit',timeout:90000});
async function child(args){
 return new Promise((resolve,reject)=>{
  const p=spawn(node,args,{stdio:'inherit'});
  p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(new Error('采集进程失败，退出码 '+code)));
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
 state('inventory',{status:'running'});
 try{execFileSync(python,[path.join(base,'import-inventory.py')],{stdio:'pipe',timeout:60000});}
 catch{throw new Error('库存表读取失败，巡检已停止；请检查库存源文件位置，未使用过期库存静默继续');}
 state('merge');
 await child([path.join(base,'collaboration.cjs'),'merge','--owned']);
 if(watch().paused){notifyAlert(watch().paused.reason);state('paused',{status:'paused',reason:watch().paused.reason});log('采集已暂停，等待人工处理');return;}
 state('mcp_health');
 if(!await health()){
  // launchd owns the backend lifetime, independently of cron or chat sessions.
  const domain='gui/'+process.getuid(),service=domain+'/ai.duoyin.xhs-readonly-backend';
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
 state('finished',{completed_at:new Date().toISOString()});
 log(result.needs_alert?'本轮部分完成，已单独提交异常提醒':'本轮采集、复核及群消息回执已核对完成');
})().catch(e=>{
 if(locked)state('failed',{status:watch().paused?'paused':'failed',failed_stage:run.stage,error:e.message,completed_at:new Date().toISOString()});
 // Scan failures already alert in their own catch; delivery subprocess failures did not.
 if((run.failed_stage||run.stage)!=='scan'&&!/MCP服务未连接/.test(e.message))try{notifyAlert(e.message);}catch{log('异常告警发送失败，需检查企业微信授权或会话');}
 console.error('巡检未完成：'+e.message);process.exitCode=1;
}).finally(()=>{
 if(locked){fs.unlinkSync(path.join(lock,'owner.json'));fs.rmdirSync(lock);}
 if(locked)fs.appendFileSync(path.join(base,'run-history.jsonl'),JSON.stringify(run)+'\n',{mode:0o600});
});
