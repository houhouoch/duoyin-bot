const test=require('node:test'),assert=require('node:assert/strict');
const {read,failure,sanitize}=require('./mcp-readonly.cjs');
const ok=()=>({ok:true,status:200,json:async()=>({success:true,data:{feeds:[]}})});
const bad=(details,status=500)=>({ok:false,status,json:async()=>({code:'INTERNAL_ERROR',details})});
test('omit only redundant unrestricted publication filter; preserve latest sort and real restrictions',async()=>{
 for(const publish_time of ['不限','一周内']){
  const body={keyword:'求租 相机',filters:{sort_by:'最新',publish_time}};let sent;
  await read('search',body,{fetcher:async(u,o)=>{sent=JSON.parse(o.body);return ok();},sleep:async()=>{}});
  assert.equal(sent.filters.sort_by,'最新');assert.equal(sent.filters.publish_time,publish_time==='不限'?undefined:publish_time);assert.equal(body.filters.publish_time,publish_time);
 }
});
test('local connection refusal stops the scan without repeated platform requests',async()=>{
 let calls=0;
 await assert.rejects(()=>read('search',{}, {fetcher:async()=>{calls++;throw new TypeError('fetch failed',{cause:{code:'ECONNREFUSED'}});},sleep:async()=>{throw Error('must not retry');}}),e=>e.backend_unavailable===true&&e.code==='BACKEND_UNAVAILABLE');
 assert.equal(calls,1);
});
test('a transient initialization failure retries once, preserves details, and recovers',async()=>{
 let calls=0;const events=[],waits=[];
 const result=await read('search',{keyword:'求租 vivo X200U'},{token:'test-secret',fetcher:async()=>++calls===1?bad('context deadline exceeded'):ok(),sleep:async ms=>waits.push(ms),onAttempt:e=>events.push(e)});
 assert.equal(calls,2);assert.deepEqual(result.feeds,[]);assert.deepEqual(waits,[15000,5000]);assert.equal(events[0].details,'context deadline exceeded');assert.equal(events[1].status,'success');
});
test('captcha or login restriction inside details stops without retry, including local HTTP 500',async()=>{
 for(const reason of ['需要验证码','请重新登录','访问频繁','risk control','session expired']){
  let calls=0;await assert.rejects(()=>read('search',{}, {fetcher:async()=>{calls++;return bad(reason);},sleep:async()=>{throw Error('must not retry');}}),e=>e.restricted===true);assert.equal(calls,1);
 }
 assert(failure(500,{details:{code:300012}}).restricted);
});
test('HTTP restrictions stop even when response is malformed',async()=>{
 let calls=0;await assert.rejects(()=>read('search',{}, {fetcher:async()=>{calls++;return {status:429,ok:false,json:async()=>{throw Error('html');}};}}),e=>e.restricted);assert.equal(calls,1);
});
test('repeated failures are never returned as zero results',async()=>{
 let calls=0;await assert.rejects(()=>read('search',{}, {fetcher:async()=>{calls++;return bad('context deadline exceeded');},sleep:async()=>{}}),/context deadline/);assert.equal(calls,2);
});
test('invalid request is not retried',async()=>{
 let calls=0;await assert.rejects(()=>read('search',{}, {fetcher:async()=>{calls++;return {status:400,ok:false,json:async()=>({code:'INVALID_REQUEST',details:'筛选参数错误'})};}}));assert.equal(calls,1);
});
test('retry respects the scan budget',async()=>{
 let calls=0;await assert.rejects(()=>read('search',{}, {now:()=>0,deadline:125000,fetcher:async()=>{calls++;return bad('timeout');},sleep:async()=>{throw Error('budget must prevent retry');}}),/预算不足/);assert.equal(calls,1);
});
test('details do not amplify timeout latency with an automatic retry',async()=>{
 let calls=0;await assert.rejects(()=>read('detail',{}, {fetcher:async()=>{calls++;throw new DOMException('secret upstream','TimeoutError');}}),/超时/);assert.equal(calls,1);
});
test('logs redact credentials and URLs; non-read routes are refused',async()=>{
 const value=sanitize('context deadline exceeded https://host/?xsec_token=secret\nCookie: secret\nBearer secret\nAPI_KEY=secret',['secret']);assert(!value.includes('secret'));assert(!value.includes('https://'));
 assert(!sanitize('{"cookie":"unknown-sensitive-value","web_session":"another-secret"}').includes('sensitive'));assert(!sanitize('{"cookie":"unknown-sensitive-value","web_session":"another-secret"}').includes('another-secret'));
 await assert.rejects(()=>read('comment',{}, {fetcher:()=>{throw Error('must not send');}}),/只允许/);
});
test('a success envelope without a result array is not a successful empty search',async()=>{
 await assert.rejects(()=>read('search',{}, {fetcher:async()=>({ok:true,status:200,json:async()=>({success:true,data:{}})}),sleep:async()=>{}}),/缺少搜索结果数组/);
});
