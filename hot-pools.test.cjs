const test=require('node:test'),assert=require('node:assert/strict');
const hot=require('./hot-pools.cjs'),liveConfig=require('./monitor-config.json');
const config={...liveConfig,hot_pool:{...liveConfig.hot_pool,max_refresh_categories_per_run:3}};
const NOW=Date.parse('2026-09-18T12:00:00Z');
const feed=(id,comments='1',likes='1')=>({id,xsecToken:'fixture-token',noteCard:{displayTitle:'租相机',interactInfo:{commentCount:comments,likedCount:likes}}});
const results=()=>config.discovery_categories.flatMap(category=>config.hot_pool.sorts.map(sort_by=>({category,sort_by,kind:'hot',keyword:'租'+category,feeds:Array.from({length:24},(_,i)=>feed(category+i,String(i),String(100-i)))})));
test('20 ranked members per category, not 20 total; duplicate hits collapse without claiming detail reads',()=>{
 const w={};hot.update(w,config,results(),NOW);
 assert.equal(Object.values(w.hot_pools).reduce((n,p)=>n+p.member_ids.length,0),60);
 for(const category of config.discovery_categories){assert.equal(w.hot_pools[category].member_ids.length,20);assert.equal(w.hot_pools[category].member_ids[0],category+'23');}
 assert.equal(Object.keys(w.hot_candidates).length,60);assert(!w.notes);assert.equal(hot.coverage(w,config,[],NOW)[0].never_read,20);
});
test('Chinese heat counts normalize; unknown is not fabricated zero',()=>{
 assert.equal(hot.count('1.2万'),12000);assert.equal(hot.count('2,300'),2300);assert.equal(hot.count('3k+'),3000);assert.equal(hot.count(''),null);assert.equal(hot.count('0'),0);
});
test('daily refresh and old hot posts independent from ten-day freshness',()=>{
 const w={};assert.equal(hot.plans(w,config,NOW).length,6);assert(hot.plans(w,config,NOW).every(p=>p.publish_time==='不限'));
 hot.update(w,config,results(),NOW);assert.equal(hot.plans(w,config,NOW+4*3600000).length,0);assert.equal(hot.plans(w,config,NOW+86400000).length,6);assert.equal(hot.jobs(w,config,NOW).length,60);
});
test('camera, phone, lens read fairly; cross-category note cannot be read twice',()=>{
 const w={};hot.update(w,config,results(),NOW);assert.deepEqual(hot.jobs(w,config,NOW).slice(0,3).map(j=>j.category),config.discovery_categories);
 w.hot_pools['手机'].member_ids[0]=w.hot_pools['相机'].member_ids[0];const js=hot.jobs(w,config,NOW);assert.equal(js.length,new Set(js.map(x=>x.id)).size);
});
test('failed refresh retains old pool without a false fresh timestamp',()=>{
 const w={};hot.update(w,config,results(),NOW);const before=JSON.stringify(w.hot_pools['相机'].member_ids);
 hot.update(w,config,[{kind:'hot',category:'相机',error:'timeout'}],NOW+86400000);
 assert.equal(JSON.stringify(w.hot_pools['相机'].member_ids),before);assert.equal(w.hot_pools['相机'].refreshed_at,new Date(NOW).toISOString());
});
test('underfilled pool is not padded or called complete',()=>{
 const w={};hot.update(w,config,[{kind:'hot',category:'镜头',keyword:'租镜头',sort_by:'最多评论',feeds:[feed('single')]}],NOW);
 const p=hot.coverage(w,config,[],NOW).find(p=>p.category==='镜头');assert.equal(p.selected,1);assert.equal(p.target,20);assert.equal(p.never_read,1);assert(p.refresh_partial);
});
test('inactive waits 12h, active 4h, failed initial read does not loop',()=>{
 const w={notes:{}};hot.update(w,config,results(),NOW);for(const id of w.hot_pools['相机'].member_ids)w.notes[id]={last_checked:new Date(NOW-5*3600000).toISOString()};
 assert(!hot.jobs(w,config,NOW).some(j=>j.category==='相机'));const id=w.hot_pools['相机'].member_ids[0];w.notes[id].last_activity_at=new Date(NOW).toISOString();assert(hot.jobs(w,config,NOW).some(j=>j.id===id));
 w.hot_candidates[id].last_attempted=new Date(NOW).toISOString();assert(!hot.jobs(w,config,NOW).some(j=>j.id===id));
});
test('old-parent comment age independent; day 4 to 10 labeled historical; Beijing calendar boundary',()=>{
 const x={published_at_ms:NOW-100*86400000,comment:{published_at_ms:NOW-3600000}};assert.equal(hot.ageLabel(x,config,NOW),'近3天需求');x.comment.published_at_ms=NOW-7*86400000;assert(hot.ageLabel(x,config,NOW).includes('历史需求'));x.comment.published_at_ms=NOW-11*86400000;assert.equal(hot.ageLabel(x,config,NOW),'不在有效窗口');assert.equal(new Date(hot.start(10,NOW)).toISOString(),'2026-09-08T16:00:00.000Z');
});
test('only unsent expiry reopens, never supply or already-sent suppression',()=>{
 const x={type:'comment',comment:{published_at_ms:NOW-7*86400000},reason:'超过近期窗口，未推送'};
 const w={suppressed:{a:{...x,key:'a'},b:{...x,key:'b',reason:'规则排除：同行／意图依据不足'},c:{...x,key:'c'}}};assert.equal(hot.restoreExpired(w,{sent:{c:'accepted'}},config,NOW),1);assert(w.outbox.a);assert(w.suppressed.b);assert(w.suppressed.c);assert(!w.suppressed.a);assert.equal(hot.restoreExpired(w,{sent:{c:'accepted'}},config,NOW),0);
});
test('partial comment depth capped; read and complete coverage remain distinct',()=>{
 assert.equal(hot.commentLimit(null,config),40);assert.equal(hot.commentLimit({comment_coverage:{partial:true,request_limit:40}},config),80);assert.equal(hot.commentLimit({comment_coverage:{partial:true,request_limit:120}},config),120);
 const w={notes:{}};hot.update(w,config,results(),NOW);const id=w.hot_pools['相机'].member_ids[0];w.notes[id]={last_checked:new Date(NOW).toISOString(),comment_coverage:{partial:true}};
 const c=hot.coverage(w,config,[{note_id:id}],NOW)[0];assert.equal(c.read_this_run,1);assert.equal(c.never_read,19);assert.equal(c.partial_comments,1);
});
test('production refresh is bounded to one category without reducing 20-post pool size',()=>{
 const w={};hot.update(w,config,results(),NOW-2*86400000);
 const first=hot.plans(w,liveConfig,NOW);assert.equal(first.length,2);assert(first.every(x=>x.category==='相机'));
 hot.update(w,liveConfig,first.map(x=>({...x,error:'timeout'})),NOW);
 const second=hot.plans(w,liveConfig,NOW);assert(second.every(x=>x.category==='手机'));
 assert(Object.values(w.hot_pools).every(p=>p.member_ids.length===20));
});
test('failed first refresh cannot starve the next empty category',()=>{
 const w={};const first=hot.plans(w,liveConfig,NOW);hot.update(w,liveConfig,first.map(x=>({...x,error:'timeout'})),NOW);
 assert.equal(hot.plans(w,liveConfig,NOW)[0].category,'手机');assert.equal(w.hot_pools['相机'].member_ids.length,0);
});
