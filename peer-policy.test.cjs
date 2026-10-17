const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {peerExcluded,sourceMerchant}=require('./lead-fields.cjs');
const {reviewQueue}=require('./deepseek-review.cjs');
const {deliveryPicks}=require('./rental-strategy.cjs');
const noPeer={include_peer_leads:false};
const row=(key,source=false)=>({key,type:'comment',note_id:key,url:'https://www.xiaohongshu.com/explore/'+key,title:source?'相机出租':'求租相机',source_is_merchant:source,is_demand_post:!source,comment:{text:'想租R50',author:'真实客户',published_at_ms:Date.now()-1000}});
test('peer source excludes customer comments while direct and organic demand remain',()=>{
 assert(peerExcluded(row('peer',true),{},new Map(),noPeer));
 assert(!peerExcluded(row('organic'),{},new Map(),noPeer));
 const watch={notes:{old:{is_merchant_post:true,title:'租赁推广'}}};
 assert(peerExcluded({...row('legacy'),note_id:'old'},watch,new Map(),noPeer));
 assert(peerExcluded({...row('merchant'),author:'测试相机租赁店',is_demand_post:true}, {},new Map(),noPeer));
 assert(!peerExcluded(row('legacy-peer',true),{},new Map(),{include_peer_leads:true}));
});
test('known peer backlog is suppressed before model calls and cannot become manual-review work',async()=>{
 const x=row('peer',true);x.ai_review_error={manual_review_required:true};
 const watch={outbox:{[x.key]:x}},history={sent:{old:'preserved'}},cache={items:{}};let calls=0;
 const result=await reviewQueue(watch,history,cache,{}, {peerSettings:noPeer,fetcher:async()=>{calls++;throw Error('must not call');}});
 assert.equal(calls,0);assert.equal(result.stats.suppressed,1);assert.equal(result.stats.deferred,0);assert.equal(result.stats.manual_review_candidates,0);
 assert(!watch.outbox.peer);assert(watch.suppressed.peer);assert.equal(history.sent.old,'preserved');assert.equal(watch.suppressed.peer.comment.text,'想租R50');
});
test('peer rejection wins even when old supplemental quotas are enabled',()=>{
 const items=[row('peer',true),row('organic'),{...row('direct'),type:'note',desc:'想租R50'}];
 const result=deliveryPicks(items,{...noPeer,supplemental_enabled:true,supplemental_max_per_run:50,max_records_per_source_per_run:5});
 assert.deepEqual(result.excluded.map(x=>x.key),['peer']);assert.deepEqual(new Set(result.selected.map(x=>x.key)),new Set(['organic','direct']));assert.equal(result.supplemental,0);assert(!result.deferred.some(x=>x.key==='peer'));
});
test('uncertain peer deliveries stay isolated without model or manual-review work',async()=>{
 const x=row('uncertain-peer',true);x.ai_review_error={manual_review_required:true};
 const watch={outbox:{[x.key]:x}},before=JSON.stringify(watch);let calls=0;
 const result=await reviewQueue(watch,{sent:{}},{items:{}},{},{peerSettings:noPeer,uncertainKeys:new Set([x.key]),fetcher:async()=>{calls++;throw Error('must not call');}});
 assert.equal(calls,0);assert.equal(result.stats.peer_quarantined,1);assert.equal(result.stats.deferred,0);assert.equal(result.stats.manual_review_candidates,0);assert.equal(JSON.stringify(watch.outbox),JSON.stringify(JSON.parse(before).outbox));assert.equal(result.dirty,false);
});
test('unread peer cards consume no new-detail slots and stay as local evidence',()=>{
 const {picks}=require('./unread-candidates.cjs');const now=Date.now(),watch={pending_details:{p:{id:'p',title:'相机出租',merchant:true,first_discovered_at:new Date(now).toISOString()},d:{id:'d',title:'求租相机',demand:true,first_discovered_at:new Date(now).toISOString()}}};
 assert.deepEqual(picks(watch,1,now).map(x=>x.id),['d']);assert(watch.pending_details.p);
});
test('unified sender and bypass preview omit peer backlog without altering live ledgers',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-no-peer-'));try{
  for(const name of fs.readdirSync(__dirname).filter(x=>x.endsWith('.cjs')))fs.copyFileSync(path.join(__dirname,name),path.join(dir,name));
  for(const name of ['monitor-config.json','camera-catalog.json'])fs.copyFileSync(path.join(__dirname,name),path.join(dir,name));
  const config=JSON.parse(fs.readFileSync(path.join(dir,'monitor-config.json')));config.deepseek_review.enabled=false;fs.writeFileSync(path.join(dir,'monitor-config.json'),JSON.stringify(config));
  const items=[row('peer',true),row('organic')];fs.writeFileSync(path.join(dir,'watchlist.json'),JSON.stringify({outbox:Object.fromEntries(items.map(x=>[x.key,x]))}));
  const before=fs.readFileSync(path.join(dir,'watchlist.json'),'utf8');
  for(const args of [[],['--priority-bypass']]){
   const text=cp.execFileSync(process.execPath,[path.join(dir,'notify-four-hour.cjs'),'--dry-run',...args],{encoding:'utf8'});const report=JSON.parse(text.split('\n')[0]);
   assert.equal(report.expected,1);assert(!text.includes('相机出租'));assert(!text.includes('补充线索来自同行'));
  }
  assert.equal(fs.readFileSync(path.join(dir,'watchlist.json'),'utf8'),before);assert(!fs.existsSync(path.join(dir,'leads-history.json')));
 }finally{fs.rmSync(dir,{recursive:true});}
});
