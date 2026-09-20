const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {input,hash,approved,validate,classify,reviewQueue}=require('./deepseek-review.cjs');
const credentials={base_url:'https://api.deepseek.com',model:'deepseek-flash',api_key:'test-only-placeholder'};
const candidate=()=>({key:'comment:example:c1',note_id:'example',type:'comment',title:'广州相机出租',desc:'商家地址广州，演唱会可租',url:'https://www.xiaohongshu.com/explore/example?xsec_token=not-for-model',token:'not-for-model',comment:{text:'26号租rf100400多少钱',author:'测试客户',author_id:'test-customer',published_at_ms:Date.now()-1000}});
const answer=(decision='inquiry')=>({decision,evidence:'多少钱',device:'rf100400',location:'未知',rental_period:'26号'});
const fake=(result=answer())=>async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})});
test('model receives bounded public text only; unknown location is not inferred from context',()=>{
 const x=candidate(),s=input(x),raw=JSON.stringify(s);
 assert(!raw.includes('not-for-model'));assert(!raw.includes('test-customer'));
 assert.throws(()=>validate({...answer(),location:'广州'},s),/原文依据/);
 assert.equal(validate(answer(),s).location,'未知');
});
test('invented evidence and device are rejected',()=>{
 const s=input(candidate());assert.throws(()=>validate({...answer(),evidence:'我想租一周'},s));
 assert.throws(()=>validate({...answer(),device:'佳能R50'},s));
});
test('non-thinking review carries no tools and no outbound interaction capability',async()=>{
 const x=candidate();let count=0;const result=await classify(x,credentials,async(url,opts)=>{
  count++;assert.equal(url,'https://api.deepseek.com/chat/completions');
  const body=JSON.parse(opts.body);assert.equal(body.thinking.type,'disabled');assert(!body.tools);assert.equal(opts.redirect,'error');return fake()(url,opts);
 });assert.equal(count,1);assert.equal(result.decision,'inquiry');assert(approved({...x,ai_review:result}));
});
test('uncertain result is rechecked using low thinking',async()=>{
 let count=0;const result=await classify(candidate(),credentials,async(url,opts)=>{
  count++;const body=JSON.parse(opts.body);if(count===2){assert.equal(body.thinking.type,'enabled');assert.equal(body.reasoning_effort,'low');}
  return fake(answer(count===1?'uncertain':'inquiry'))();
 });assert.equal(count,2);assert.equal(result.mode,'low');assert.equal(result.usage.total_tokens,60);
});
test('repeat review hits cache; sent leads are not reviewed or requeued',async()=>{
 const x=candidate(),watch={outbox:{[x.key]:x}},cache={items:{}};let calls=0;
 const fetcher=async()=>{calls++;return fake()();};
 await reviewQueue(watch,{sent:{}},cache,credentials,{fetcher});
 const second=await reviewQueue(watch,{sent:{}},cache,credentials,{fetcher});assert.equal(calls,1);assert.equal(second.stats.cached,1);
 const third=await reviewQueue(watch,{sent:{[x.key]:'already-sent'}},cache,credentials,{fetcher});assert.equal(calls,1);assert.equal(third.stats.skipped_sent,1);
});
test('model failures retry once and keep candidate pending without a sent record',async()=>{
 const x=candidate(),watch={outbox:{[x.key]:x}},history={sent:{}},cache={items:{}};let calls=0;
 await assert.rejects(()=>reviewQueue(watch,history,cache,credentials,{fetcher:async()=>{calls++;throw Error('secret-like upstream message never logged');}}),/连接失败/);
 assert.equal(calls,2);assert(watch.outbox[x.key]);assert.deepEqual(history.sent,{});assert(!approved(x));
});
test('supplier judgment suppresses only this lead, not an entire author',async()=>{
 const x=candidate(),watch={outbox:{[x.key]:x}},cache={items:{}};
 await reviewQueue(watch,{sent:{}},cache,credentials,{fetcher:fake(answer('supply'))});
 assert(!watch.outbox[x.key]);assert.equal(watch.suppressed[x.key].ai_review.decision,'supply');assert(!watch.authors);
});
test('quoted supplier prices are excluded before model review',async()=>{
 const x=candidate();x.comment.text='r50+18-45三天一共128';let calls=0;const watch={outbox:{[x.key]:x}};
 await reviewQueue(watch,{sent:{}},{items:{}},credentials,{fetcher:async()=>{calls++;return fake()();}});assert.equal(calls,0);assert(!watch.outbox[x.key]);
});
test('invalid authorization does not retry or leak upstream response body',async()=>{
 let calls=0;const x=candidate(),watch={outbox:{[x.key]:x}};
 await assert.rejects(()=>reviewQueue(watch,{sent:{}},{items:{}},credentials,{fetcher:async()=>{calls++;return {ok:false,status:401,json:async()=>{throw Error('must not read body');}};}}),/HTTP 401/);assert.equal(calls,1);assert(watch.outbox[x.key]);
});
test('rule exclusions occur before model calls',async()=>{
 const x=candidate();x.comment.author='测试相机租赁';let calls=0;const watch={outbox:{[x.key]:x}};
 await reviewQueue(watch,{sent:{}},{items:{}},credentials,{fetcher:async()=>{calls++;return fake()();}});assert.equal(calls,0);assert(!watch.outbox[x.key]);
});
test('batch size is not a run limit; stale or future results are not reviewed',async()=>{
 const a=candidate(),b=candidate();b.key='second';b.comment.text='27号想租相机';
 const stale=candidate();stale.key='stale';stale.comment.published_at_ms=Date.now()-10*86400000;
 const future=candidate();future.key='future';future.comment.published_at_ms=Date.now()+86400000;
 let calls=0;const watch={outbox:{a,b,stale,future}};
 const r=await reviewQueue(watch,{sent:{}},{items:{}},credentials,{batchSize:1,fetcher:async(url,opts)=>{calls++;const s=JSON.parse(JSON.parse(opts.body).messages[1].content);return fake({decision:'inquiry',evidence:s.subject,device:'未知',location:'未知',rental_period:'未知'})();}});assert.equal(calls,2);assert.equal(r.stats.deferred,1);assert.equal(r.stats.batches,2);assert(approved(b));assert(!approved(stale));assert(!approved(future));
});
test('modified source invalidates previous review',async()=>{
 const x=candidate();x.ai_review=await classify(x,credentials,fake());assert(approved(x));const old=hash(x);x.comment.text+=' 上海自提';assert.notEqual(hash(x),old);assert(!approved(x));
});
test('malformed, empty and truncated responses fail closed',async()=>{
 for(const message of ['', 'not-json'])await assert.rejects(()=>classify(candidate(),credentials,async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:message}}]})})),/未通过/);
 await assert.rejects(()=>classify(candidate(),credentials,async()=>({ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:JSON.stringify(answer())}}]})})),/未通过/);
});
test('dry notification gates unreviewed leads; an alert never sends pending leads',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-ds-test-'));
 try{
  for(const name of ['notify-four-hour.cjs','document-delivery.cjs','delivery-integrity.cjs','concise-message.cjs','demand-validity.cjs','deepseek-review.cjs','lead-fields.cjs','rental-strategy.cjs','hot-pools.cjs','camera-catalog.json'])fs.copyFileSync(path.join(__dirname,name),path.join(dir,name));
  const config=JSON.parse(fs.readFileSync(path.join(__dirname,'monitor-config.json')));config.deepseek_review={enabled:true};fs.writeFileSync(path.join(dir,'monitor-config.json'),JSON.stringify(config));
  const x=candidate();x.ai_review=await classify(x,credentials,fake());const y=candidate();y.key='unreviewed';y.comment.text='27号想租相机';
  fs.writeFileSync(path.join(dir,'watchlist.json'),JSON.stringify({outbox:{[x.key]:x,[y.key]:y}}));
  const run=args=>execFileSync(process.execPath,[path.join(dir,'notify-four-hour.cjs'),'--dry-run',...args],{encoding:'utf8'});
  const normal=run([]);assert.equal(JSON.parse(normal.split('\n')[0]).comments,1);assert(!normal.includes('AI复核'));assert(normal.includes('主评论｜测试客户'));assert(normal.includes('26号租rf100400多少钱'));assert(!normal.includes('27号想租相机'));
  const other=candidate();other.key='other-model';other.comment.text='求租华为手机';other.ai_review=await classify(other,credentials,fake({decision:'demand',evidence:'求租',device:'华为手机',location:'未知',rental_period:'未知'}));
  const uncertain=candidate();uncertain.key='uncertain';uncertain.comment.text='国庆还有吗';uncertain.ai_review=await classify(uncertain,credentials,fake({decision:'uncertain',evidence:'国庆还有吗',device:'未知',location:'未知',rental_period:'国庆'}));
  fs.writeFileSync(path.join(dir,'watchlist.json'),JSON.stringify({outbox:{[x.key]:x,[other.key]:other,[uncertain.key]:uncertain,[y.key]:y}}));
  const grouped=run([]);assert.equal(JSON.parse(grouped.split('\n')[0]).comments,3);assert(grouped.includes('求租华为手机'));assert(grouped.includes('意图待确认'));assert.equal(grouped.match(/https:\/\/www.xiaohongshu.com\/explore\/example/g).length,1);
  const before=fs.readFileSync(path.join(dir,'watchlist.json'),'utf8');
  const alert=run(['--alert','DeepSeek测试异常']);assert.equal(JSON.parse(alert.split('\n')[0]).comments,0);assert(!alert.includes('AI判断引文'));assert(alert.includes('线索复核暂时失败'));assert.equal(fs.readFileSync(path.join(dir,'watchlist.json'),'utf8'),before);assert(!fs.existsSync(path.join(dir,'four-hour-delivery.json')));
  fs.writeFileSync(path.join(dir,'four-hour-delivery.json'),JSON.stringify({batches:{legacyAccepted:{status:'accepted',keys:[x.key],accepted_at:new Date().toISOString()},legacyUncertain:{status:'uncertain',keys:[other.key]}}}));
  const reconciled=run([]);assert.equal(JSON.parse(reconciled.split('\n')[0]).comments,1);assert(!reconciled.includes('26号租rf100400多少钱'));assert(!reconciled.includes('求租华为手机'));assert(reconciled.includes('停止自动重发'));assert(!fs.existsSync(path.join(dir,'leads-history.json')));
 }finally{fs.rmSync(dir,{recursive:true});}
});
