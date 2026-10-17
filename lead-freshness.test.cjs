const test=require('node:test'),assert=require('node:assert/strict');
const {deliveryPicks,queries,searchOrder}=require('./rental-strategy.cjs');
const unread=require('./unread-candidates.cjs');
const {buildDocument,verifyDocument}=require('./document-delivery.cjs');
const {opContent}=require('./chronological-document.cjs');
const config={...require('./monitor-config.json'),delivery_priority:{...require('./monitor-config.json').delivery_priority,include_peer_leads:true,peer_max_share:0.2,max_peer_sources_per_run:2,supplemental_enabled:true,supplemental_max_per_run:50},document_layout:{...require('./monitor-config.json').document_layout,followup_enabled:true}};
const now=Date.parse('2026-10-08T03:30:00Z');
const lead=(key,time,note=key)=>({key,type:'comment',note_id:note,title:'相机租赁',url:'https://www.xiaohongshu.com/explore/'+note,source_is_merchant:true,first_discovered_at:'2026-10-08T01:00:00Z',comment:{id:key,author:'客户',text:'求租相机',published_at_ms:Date.parse(time)}});
test('large old backlog cannot displace 35 recent slots or 15 historical slots',()=>{
 const old=Array.from({length:200},(_,i)=>lead('old'+i,'2026-09-29T01:00:00Z'));
 const fresh=Array.from({length:60},(_,i)=>lead('fresh'+i,'2026-10-08T01:00:00Z'));
 const p=deliveryPicks([...old,...fresh],config.delivery_priority,now);
 assert.equal(p.selected.filter(x=>x.key.startsWith('fresh')).length,35);assert.equal(p.selected.filter(x=>x.key.startsWith('old')).length,15);
 assert.equal(p.deferred.length,210);assert.equal(new Set(p.selected.map(x=>x.key)).size,50);
 assert(p.deferred.every(x=>!p.selected.some(s=>s.key===x.key)));
});
test('recent slots use comment time, Beijing midnight, and allow unused capacity to be borrowed',()=>{
 const boundary=lead('boundary','2026-10-05T16:00:00Z');boundary.published_at_ms=now-100*86400000;
 const before=lead('before','2026-10-05T15:59:59Z');
 const many=Array.from({length:60},(_,i)=>lead('h'+i,'2026-09-30T01:00:00Z'));
 const p=deliveryPicks([...many,before,boundary],config.delivery_priority,now);assert.equal(p.selected[0].key,'boundary');assert.equal(p.selected.length,50);
 const fresh=Array.from({length:60},(_,i)=>lead('f'+i,'2026-10-08T01:00:00Z'));assert.equal(deliveryPicks(fresh,config.delivery_priority,now).selected.length,50);
});
test('shared-source cap still protects both quotas and main leads stay first',()=>{
 const rows=[...Array.from({length:30},(_,i)=>lead('h'+i,'2026-09-30T01:00:00Z','shared')),...Array.from({length:30},(_,i)=>lead('f'+i,'2026-10-08T01:00:00Z','shared'))];
 const direct={...lead('direct','2026-10-08T01:00:00Z'),type:'note',source_is_merchant:false,published_at_ms:now,comment:undefined,desc:'求租相机'};
 const p=deliveryPicks([direct,...rows],config.delivery_priority,now);assert.equal(p.selected[0].key,'direct');assert.equal(p.selected.filter(x=>x.note_id==='shared').length,5);
 assert(p.selected.filter(x=>x.note_id==='shared').every(x=>x.key.startsWith('f')));
});
test('first three searches always cover all three explicit demand categories despite yield scores',()=>{
 for(let i=0;i<24;i++){
  const plan=queries({diversity_round:i}).map(x=>({...x,query_kind:x.kind,kind:'latest'}));
  const ordered=searchOrder(plan,[{keyword:'hot',kind:'hot'}],{});
  assert.deepEqual(new Set(ordered.slice(0,3).map(x=>x.category)),new Set(['相机','手机','镜头']));
  assert(ordered.slice(0,3).every(x=>x.query_kind==='discovery'&&/求租|想租/.test(x.keyword)));assert.equal(ordered.length,10);
 }
});
test('unread results survive missing searches, failures and refreshes; success alone removes them',()=>{
 const w={notes:{}};unread.remember(w,[{id:'a',title:'求租相机',token:'fixture1',demand:true}],now);
 w.pending_details.a.last_attempted=new Date(now+1000).toISOString();unread.remember(w,[],now+3600000);
 assert(w.pending_details.a);const first=w.pending_details.a.first_discovered_at;
 unread.remember(w,[{id:'a',title:'求租相机',token:'fixture2',demand:true}],now+7200000);assert.equal(w.pending_details.a.token,'fixture2');assert.equal(w.pending_details.a.first_discovered_at,first);
 w.notes.a={last_checked:new Date(now+7300000).toISOString()};unread.remember(w,[],now+7400000);assert(!w.pending_details.a);
});
test('carried candidates reserve six slots, interleave with new candidates and keep global merchant cap',()=>{
 const w={notes:{}};
 unread.remember(w,Array.from({length:30},(_,i)=>({id:'old'+i,title:'求租相机',demand:true})),now-3600000);
 unread.remember(w,Array.from({length:50},(_,i)=>({id:'new'+i,title:'求租相机',demand:true})),now);
 const p=unread.picks(w,18,now);assert.equal(p.filter(x=>x.id.startsWith('old')).length,6);assert.equal(p.filter(x=>x.id.startsWith('new')).length,12);assert(p[2].id.startsWith('old'));assert.equal(new Set(p.map(x=>x.id)).size,18);
 const peers={notes:{}};unread.remember(peers,Array.from({length:10},(_,i)=>({id:'o'+i,title:'出租相机',merchant:true})),now-3600000);unread.remember(peers,Array.from({length:10},(_,i)=>({id:'n'+i,title:'出租相机',merchant:true})),now);assert.equal(unread.picks(peers,18,now).length,0);
});
test('unread age expires by discovery time and never by an inferred publication date',()=>{
 const w={notes:{},pending_details:{old:{id:'old',first_discovered_at:new Date(now-11*86400000).toISOString()},new:{id:'new',first_discovered_at:new Date(now-86400000).toISOString(),published_at_ms:now-400*86400000}}};
 assert.equal(unread.remember(w,[],now),1);assert(w.pending_details.new);assert(!w.pending_details.old);
});
test('document distinguishes publication and discovery and verifies timing readback without guessing missing dates',()=>{
 const x=lead('x','2026-10-07T16:30:00Z');const scan={started_at:new Date(now).toISOString(),complete:false,search_plan:[{keyword:'求租相机',sort_by:'最新'}],searches:[],unread_candidates_pending:12};
 const d=buildDocument([x],scan,config,now);assert(d.content.includes('近期新增1条'));assert(d.content.includes('搜索未执行1项'));assert(d.content.includes('未读候选12帖'));
 assert(d.content.includes('发布时间：2026-10-08 00:30:00'));assert(d.content.includes('首次发现：2026-10-08 09:00:00'));assert(d.content.includes('取得群回执后补记'));
 assert.throws(()=>verifyDocument(d,d.content.replace(/^  发布时间：.*\n/gm,'')),/时间信息/);
 delete x.first_discovered_at;assert(buildDocument([x],scan,config,now).content.includes('首次发现：未知'));
});
test('real push time requires successful receipt rather than document creation or run start',()=>{
 const s=opContent({accepted:1,delivery_confirmed_at:'2026-10-08T03:31:25Z'});assert(s.includes('群回执确认）：2026-10-08 11:31:25'));
 assert(!opContent({accepted:0,delivery_confirmed_at:'2026-10-08T03:31:25Z'}).includes('11:31:25'));assert(opContent({accepted:0}).includes('尚无已确认'));
 assert(opContent({searches_unexecuted:[{keyword:'相机'},{keyword:'镜头'}]}).includes('计划搜索未执行2项'));
});
