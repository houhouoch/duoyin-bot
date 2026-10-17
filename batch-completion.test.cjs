const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {reviewQueue,approved}=require('./deepseek-review.cjs');
const {prepare,verifyAccepted,completion}=require('./delivery-integrity.cjs');
const {render}=require('./concise-message.cjs');
const config=require('./monitor-config.json');
const credentials={base_url:'https://api.deepseek.com',model:'deepseek-flash',api_key:'test-only'};
const lead=i=>({key:'c'+i,type:'comment',note_id:'fixture',title:'求租相机',url:'https://www.xiaohongshu.com/explore/fixture',first_discovered_at:new Date(Date.now()-60000+i).toISOString(),comment:{id:'c'+i,author:'测试客户',text:'求租相机'+i,published_at_ms:Date.now()-1000}});
const response=(source,decision='demand')=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({decision,evidence:source,device:'相机',location:'未知',rental_period:'未知'})}}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})});
test('52 candidates continue through 3 batches, preserving a shared budget and checkpoints',async()=>{
 const rows=Array.from({length:52},(_,i)=>lead(i)),watch={outbox:Object.fromEntries(rows.map(x=>[x.key,x]))};let calls=0,checkpoints=[];
 const budget={deadline:Date.now()+480000,cost_usd:0,max_usd:0.15,requests:0,tokens:0};
 const {stats}=await reviewQueue(watch,{sent:{}},{items:{}},credentials,{batchSize:24,budget,checkpoint:s=>checkpoints.push(s.reviewed),fetcher:async(u,o)=>{const s=JSON.parse(JSON.parse(o.body).messages[1].content).subject;return response(s,++calls<=5?'supply':'demand');}});
 assert.equal(stats.reviewed,52);assert.equal(stats.suppressed,5);assert.equal(stats.deferred,0);assert.equal(stats.batches,3);assert.deepEqual(checkpoints,[24,48,52]);assert.equal(budget.requests,52);assert.equal(Object.values(watch.outbox).filter(approved).length,47);
});
test('old pending candidate is reviewed before newly discovered candidate, regardless of publish date',async()=>{
 const old=lead(1),fresh=lead(2);old.comment.published_at_ms=Date.now()-8*86400000;
 const watch={outbox:{fresh,old}},order=[];const budget={deadline:Date.now()+480000,cost_usd:0,max_usd:0.15,requests:0,tokens:0};
 const r=await reviewQueue(watch,{sent:{}},{items:{}},credentials,{budget,fetcher:async(u,o)=>{const s=JSON.parse(JSON.parse(o.body).messages[1].content).subject;order.push(s);budget.deadline=0;return response(s);}});
 assert.deepEqual(order,[old.comment.text]);assert.equal(r.stats.deferred,1);assert(r.stats.budget_limited);assert(watch.outbox.fresh);assert(!approved(fresh));
});
test('time and cost caps defer safely without resetting budget between batches',async()=>{
 for(const budget of [{deadline:0,cost_usd:0,max_usd:0.15},{deadline:Date.now()+480000,cost_usd:0.14,max_usd:0.15}]){
  let calls=0;const x=lead(1),w={outbox:{[x.key]:x}};
  const r=await reviewQueue(w,{sent:{}},{items:{}},credentials,{budget,fetcher:()=>{calls++;throw Error('should not call');}});
  assert.equal(calls,0);assert.equal(r.stats.deferred,1);assert(r.stats.budget_limited);assert(w.outbox[x.key]);
 }
});
test('budget exhausted between uncertain passes keeps candidate pending, not an API failure',async()=>{
 const x=lead(1),w={outbox:{[x.key]:x}},budget={deadline:Date.now()+10000,cost_usd:0,max_usd:0.15,requests:0,tokens:0};let calls=0;
 const r=await reviewQueue(w,{sent:{}},{items:{}},credentials,{budget,fetcher:async()=>{calls++;budget.deadline=0;return response(x.comment.text,'uncertain');}});
 assert.equal(calls,1);assert.equal(r.stats.deferred,1);assert(r.stats.budget_limited);assert(!approved(x));
});
test('planner rejects missing, duplicate and mismatched visible rows before any send',()=>{
 const a=lead(1),b=lead(2),groups=render({pending:[a,b],config});
 assert.throws(()=>prepare([a,b],[{...groups[0],keys:[a.key]}]),/数量核对/);
 assert.throws(()=>prepare([a,b],[{...groups[0],keys:[a.key,a.key]}]),/数量核对/);
 assert.throws(()=>prepare([a,b],[{...groups[0],content:groups[0].content+'- 正文｜多余\n'}]),/正文条数/);
});
test('short messages have visible part headers and only the final lead message has an end marker',()=>{
 for(const n of [1,6,7,22,40]){
  const pending=Array.from({length:n},(_,i)=>lead(i));
  const planned=prepare(pending,render({pending,config}));
  assert.equal(planned.length,Math.ceil(n/6));
  planned.forEach((p,i)=>{
   assert(p.keys.length<=6);assert(p.content.split('\n')[0].endsWith(`分组 ${i+1}/${planned.length}`));
   assert.equal(p.content.includes('本批发送完毕'),i===planned.length-1);
  });
  assert.deepEqual(planned.flatMap(p=>p.keys).sort(),pending.map(x=>x.key).sort());
 }
 for(const args of [{},{alert:'partial'},{awaiting:3},{blocked:1}]){
  const planned=prepare([],render({config,...args}));
  assert(planned.every(p=>!p.content.includes('分组 ')&&!p.content.includes('本批发送完毕')));
 }
});
test('split messages count every key once; incomplete and uncertain receipts never pass verification',()=>{
 const pending=Array.from({length:60},(_,i)=>lead(i));const groups=render({pending,config,maxBytes:1200}),planned=prepare(pending,groups);
 assert(planned.length>1);assert(planned.every((p,i)=>p.content.includes(`分组 ${i+1}/${planned.length}`)&&Buffer.byteLength(p.content)<=20480));
 const batches=Object.fromEntries(planned.map(p=>[p.hash,{status:'accepted',keys:p.keys}])),history={sent:Object.fromEntries(pending.map(x=>[x.key,'now']))};
 assert.equal(verifyAccepted(planned,batches,history).accepted,60);
 batches[planned[1].hash].status='uncertain';assert.throws(()=>verifyAccepted(planned,batches,history),/未确认成功/);
 batches[planned[1].hash].status='accepted';delete history.sent[pending[0].key];assert.throws(()=>verifyAccepted(planned,batches,history),/去重记录/);
});
test('partial review, incomplete search and queue backlog remain partial without a separate group alert',()=>{
 const ok={status:'accepted_by_wecom'};
 assert.equal(completion({complete:true},{status:'completed'},0,ok).needs_alert,false);
 for(const [s,r,p] of [[{complete:false},{},0],[{searches:[{error:'INTERNAL_ERROR'}]},{},0],[{}, {status:'partial',deferred:28},28],[{}, {},1]]){const result=completion(s,r,p,ok);assert.equal(result.status,'partial');assert.equal(result.needs_alert,false);assert(result.issues_recorded);}
 const a=prepare([],render({config,alert:'partial'}),{alertScope:'run1'}),b=prepare([],render({config,alert:'partial'}),{alertScope:'run2'});
 assert.notEqual(a[0].hash,b[0].hash);assert(!a[0].content.includes('INTERNAL_ERROR'));assert(!a[0].content.includes('28'));
});
test('sender resumes after explicit failure, isolates uncertain sends, and keeps alerts separate (mock CLI only)',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-delivery-test-'));
 try{
  for(const name of ['notify-four-hour.cjs','delivery-integrity.cjs','concise-message.cjs','demand-validity.cjs','deepseek-review.cjs','lead-fields.cjs','rental-strategy.cjs','hot-pools.cjs','camera-catalog.json'])fs.copyFileSync(path.join(__dirname,name),path.join(dir,name));
  fs.writeFileSync(path.join(dir,'monitor-config.json'),JSON.stringify({...config,document_delivery:{enabled:false},deepseek_review:{enabled:false}}));
  const rows=Array.from({length:60},(_,i)=>{const x=lead(i);x.comment.text+=' 求租相机'.repeat(30);return x;});
  fs.writeFileSync(path.join(dir,'watchlist.json'),JSON.stringify({outbox:Object.fromEntries(rows.map(x=>[x.key,x]))}));
  const scan=path.join(dir,'scan.json');fs.writeFileSync(scan,JSON.stringify({started_at:'test-run',complete:true}));
  // The subprocess PATH resolves only this fake transport; it has no real credentials.
  fs.writeFileSync(path.join(dir,'wecom-cli'),`#!${process.execPath}\nconst fs=require('fs');const a=process.argv.slice(2);if(a[0]==='--version')console.log('1.2.1');else if(a[0]==='auth')console.log('authorized');else if(a.includes('list'))console.log(JSON.stringify({sessions:[{chat_id:'fixture',chat_name:'测试线索群',chat_type:'group'}]}));else{const file=process.env.TEST_LOG;const n=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\\n').length+1:1;const data=JSON.parse(a[a.indexOf('--json')+1]);fs.appendFileSync(file,JSON.stringify(data)+'\\n');if(n===Number(process.env.FAIL_AT)){if(process.env.UNCERTAIN)console.log('invalid response');else console.log(JSON.stringify({success:false}));}else console.log(JSON.stringify({success:true}));}`,{mode:0o700});
  const log=path.join(dir,'transport.jsonl'),env={...process.env,PATH:dir+':/usr/bin:/bin',TEST_LOG:log};
  const run=(extra={},args=[])=>execFileSync(process.execPath,[path.join(dir,'notify-four-hour.cjs'),'--scan',scan,'--priority-bypass',...args],{env:{...env,...extra},encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.throws(()=>run({FAIL_AT:'2'}));
  const first=JSON.parse(fs.readFileSync(path.join(dir,'four-hour-delivery.json'))),accepted=Object.values(first.batches).find(x=>x.status==='accepted');assert(accepted.keys.length>0&&accepted.keys.length<60);
  run();const history=JSON.parse(fs.readFileSync(path.join(dir,'leads-history.json')));assert.equal(Object.keys(history.sent).length,60);
  const before=fs.readFileSync(log,'utf8'),artifact=fs.readFileSync(path.join(dir,'four-hour-latest-message.md'),'utf8');
  run();assert.equal(fs.readFileSync(log,'utf8'),before);
  run({},['--alert','partial']);assert.equal(fs.readFileSync(path.join(dir,'four-hour-latest-message.md'),'utf8'),artifact);
  const alerted=fs.readFileSync(log,'utf8');run({},['--alert','partial']);assert.equal(fs.readFileSync(log,'utf8'),alerted);
  const x=lead(99);fs.writeFileSync(path.join(dir,'watchlist.json'),JSON.stringify({outbox:{[x.key]:x}}));
  const next=alerted.trim().split('\n').length+1;assert.throws(()=>run({FAIL_AT:String(next),UNCERTAIN:'1'}));
  const uncertain=fs.readFileSync(log,'utf8');run();
  const newMessages=fs.readFileSync(log,'utf8').slice(uncertain.length);assert(!newMessages.includes('求租相机99'));assert(JSON.parse(fs.readFileSync(path.join(dir,'watchlist.json'))).outbox[x.key]);
 }finally{fs.rmSync(dir,{recursive:true});}
});
