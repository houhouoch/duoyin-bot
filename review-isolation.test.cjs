const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {reviewQueue,approved,classify}=require('./deepseek-review.cjs');
const credentials={base_url:'https://api.deepseek.com',model:'deepseek-flash',api_key:'test-only'};
const lead=i=>({key:'c'+i,note_id:'fixture',type:'comment',title:'求租相机',url:'https://www.xiaohongshu.com/explore/fixture',first_discovered_at:new Date(Date.now()-100000+i).toISOString(),comment:{id:'c'+i,author:'测试客户',text:'求租相机'+i,published_at_ms:Date.now()-1000}});
const reply=(subject,patch={})=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({decision:'demand',evidence:subject,device:'相机',location:'未知',rental_period:'未知',...patch})}}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})});
test('a twice-invalid candidate does not block 18 already approved or later candidates',async()=>{
 const rows=Array.from({length:20},(_,i)=>lead(i)),w={outbox:Object.fromEntries(rows.map(x=>[x.key,x]))},cache={items:{}};let calls=0;
 const {stats}=await reviewQueue(w,{sent:{}},cache,credentials,{fetcher:async(u,o)=>{calls++;const s=JSON.parse(JSON.parse(o.body).messages[1].content).subject;return reply(s,s==='求租相机18'?{location:'不存在的城市'}:{});}});
 assert.equal(calls,21);assert.equal(stats.failed_candidates,1);assert.equal(stats.deferred,1);assert.equal(stats.reviewed,19);
 assert.equal(Object.values(w.outbox).filter(approved).length,19);assert(!approved(rows[18]));assert(approved(rows[19]));
 assert.match(rows[18].ai_review_error.code,/INVALID_LOCATION/);assert.equal(Object.keys(cache.items).length,19);assert(!JSON.stringify(stats).includes('不存在的城市'));
 const cooled=await reviewQueue(w,{sent:{}},cache,credentials,{fetcher:()=>{throw Error('cooldown must not call model');}});assert.equal(cooled.stats.cooldown_candidates,1);
 rows[18].ai_review_error.next_retry_at=new Date(Date.now()-1000).toISOString();
 const recovered=await reviewQueue(w,{sent:{}},cache,credentials,{fetcher:async(u,o)=>reply(JSON.parse(JSON.parse(o.body).messages[1].content).subject)});
 assert.equal(recovered.stats.reviewed,1);assert(approved(rows[18]));assert(!rows[18].ai_review_error);
});
test('response diagnostics distinguish truncation, empty, invalid JSON and unsupported source evidence',async()=>{
 const x=lead(1);
 for(const [finish,content,code] of [['length','SECRET','OUTPUT_TRUNCATED'],['stop','','EMPTY_CONTENT'],['stop','SECRET','INVALID_CONTENT_JSON'],['stop',JSON.stringify({decision:'demand',evidence:'SECRET'}),'EVIDENCE_NOT_IN_SOURCE']]){
  await assert.rejects(()=>classify(x,credentials,async()=>({ok:true,json:async()=>({choices:[{finish_reason:finish,message:{content}}]})})),e=>e.candidate_error&&e.code.includes(code)&&!e.message.includes('SECRET'));
 }
});
test('invalid cached fields are not trusted; one fresh valid review repairs the candidate',async()=>{
 const x=lead(1),w={outbox:{[x.key]:x}},cache={items:{}};
 await reviewQueue(w,{sent:{}},cache,credentials,{fetcher:async()=>reply(x.comment.text)});
 Object.values(cache.items)[0].location='错误城市';let calls=0;
 await reviewQueue(w,{sent:{}},cache,credentials,{fetcher:async()=>{calls++;return reply(x.comment.text);}});
 assert.equal(calls,1);assert.equal(x.ai_review.location,'未知');assert(approved(x));
});
test('global authorization failures still stop the review; they are not mislabeled as candidate errors',async()=>{
 const x=lead(1),w={outbox:{[x.key]:x}};let calls=0;
 await assert.rejects(()=>reviewQueue(w,{sent:{}},{items:{}},credentials,{fetcher:async()=>{calls++;return {ok:false,status:401};}}),/HTTP 401/);
 assert.equal(calls,1);assert(w.outbox[x.key]);assert(!x.ai_review_error);
});
test('approved-only recovery uses the lock and original sender, never calls MCP or model',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-approved-recovery-'));
 try{
  for(const f of ['run-four-hour.cjs','patrol-health.cjs','daily-document-extras.cjs','lead-presentation.cjs','notify-four-hour.cjs','delivery-integrity.cjs','concise-message.cjs','demand-validity.cjs','deepseek-review.cjs','lead-fields.cjs','rental-strategy.cjs','hot-pools.cjs','camera-catalog.json','monitor-config.json'])fs.copyFileSync(path.join(__dirname,f),path.join(dir,f));
  const cfg=JSON.parse(fs.readFileSync(path.join(dir,'monitor-config.json')));cfg.document_delivery={enabled:false};fs.writeFileSync(path.join(dir,'monitor-config.json'),JSON.stringify(cfg));
  const rows=Array.from({length:19},(_,i)=>lead(i));for(const x of rows.slice(0,18))x.ai_review=await classify(x,credentials,async()=>reply(x.comment.text));
  fs.writeFileSync(path.join(dir,'watchlist.json'),JSON.stringify({outbox:Object.fromEntries(rows.map(x=>[x.key,x]))}));
  const scan=path.join(dir,'scan.json');fs.writeFileSync(scan,JSON.stringify({started_at:'recovery-fixture',complete:false}));fs.writeFileSync(path.join(dir,'four-hour-latest-scan-path.txt'),scan);
  fs.writeFileSync(path.join(dir,'wecom-cli'),`#!${process.execPath}\nconst fs=require('fs'),a=process.argv.slice(2);if(a[0]==='--version')console.log('1.2.1');else if(a[0]==='auth')console.log('authorized');else if(a.includes('list'))console.log(JSON.stringify({sessions:[{chat_name:'测试线索群',chat_type:'group',chat_id:'test'}]}));else{fs.appendFileSync(process.env.TEST_TRANSPORT,JSON.stringify(JSON.parse(a[a.indexOf('--json')+1]))+'\\n');console.log(JSON.stringify({success:true}));}`,{mode:0o700});
  // Throw immediately if the runner attempts any network/model/collector call.
  fs.writeFileSync(path.join(dir,'deny-network.cjs'),"globalThis.fetch=()=>{throw Error('Unexpected network call in recovery');};");
  const transport=path.join(dir,'transport.jsonl'),env={...process.env,PATH:dir+':/usr/bin:/bin',TEST_TRANSPORT:transport};
  execFileSync(process.execPath,['--require',path.join(dir,'deny-network.cjs'),path.join(dir,'run-four-hour.cjs'),'--deliver-approved-only','--expected-count','18'],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const status=JSON.parse(fs.readFileSync(path.join(dir,'run-status.json'))),watch=JSON.parse(fs.readFileSync(path.join(dir,'watchlist.json')));
  assert.equal(status.status,'recovery_delivered');assert.equal(status.delivery_check.accepted,18);assert.equal(Object.keys(watch.outbox).length,1);assert(!fs.existsSync(path.join(dir,'four-hour.lock')));
  const sent=fs.readFileSync(transport,'utf8').trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(sent.length,3);assert(sent.every(s=>!s.markdown.content.includes('求租相机18')));
  assert(sent[2].markdown.content.endsWith('本批发送完毕\n'));
 }finally{fs.rmSync(dir,{recursive:true});}
});
