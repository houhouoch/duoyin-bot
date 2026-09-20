const test=require('node:test'),assert=require('node:assert/strict');
const {inventoryMatches,tier,compare,queries,rechecks,broadCandidate,modelPools,buildModelPools,freshPicks,searchOrder,detailOrder,deliveryPicks,presentationOrder}=require('./rental-strategy.cjs');
const {reviewQueue,input}=require('./deepseek-review.cjs');
test('inventory recognizes camera, phone and lens variants while other equipment remains eligible',()=>{
 for(const text of ['求租R50','有vivo X300Ultra吗','rf100-400'])assert(inventoryMatches(text).length);
 assert.equal(inventoryMatches('求租R5000新相机').length,0);
 assert.equal(tier({type:'comment',comment:{text:'求租华为手机'}}),'other');
 assert(broadCandidate('求租华为手机'));assert(broadCandidate('有大疆4p吗'));assert(broadCandidate('19号有rf400的镜头吗'));assert(!broadCandidate('求租办公室'));
});
test('each rotation preserves two inventory searches and one direct-demand discovery per category',()=>{
 const state={},a=queries(state),b=queries(state);
 assert.equal(a.filter(x=>x.kind==='inventory').length,6);assert.equal(a.filter(x=>x.kind==='discovery').length,3);
 assert(a.some(x=>/vivo|三星/i.test(x.keyword)));assert(b.some(x=>x.kind==='discovery'&&/镜头/.test(x.keyword)));assert.notDeepEqual(a,b);
});
test('each nine-search round covers all three categories with two inventory and one broad discovery',()=>{
 const state={inventory_cursor:500,discovery_cursor:250};const cameras=new Set();
 for(let i=0;i<60;i++){
  const plan=queries(state);assert.equal(plan.length,9);assert.equal(new Set(plan.map(p=>p.keyword)).size,9);
  for(const category of ['相机','手机','镜头'])assert.deepEqual(plan.filter(p=>p.category===category).map(p=>p.kind),['inventory','inventory','discovery']);
  for(const category of ['相机','手机','镜头']){const inventory=plan.filter(p=>p.category===category&&p.kind==='inventory');assert.notEqual(inventory[0].model,inventory[1].model);}
  assert(!plan.some(p=>/镜头 镜头|手机 机身|在哪租 求租/.test(p.keyword)));
  if(i<6)for(const p of plan.filter(p=>p.category==='相机'&&p.kind==='inventory'))cameras.add(p.model);
 }
 assert.equal(cameras.size,12);assert([...cameras].some(x=>/富士/.test(x)));assert([...cameras].some(x=>/pocket/.test(x)));
 assert.equal(state.inventory_cursor,500);assert.equal(state.diversity_round,60);
});
test('inventory heading does not hide kit bodies or travel model variants; phone aliases collapse',()=>{
 for(const text of ['a6700','ZVE10','G7X2','GR3','XT50','XS20'])assert(modelPools['相机'].includes(text),text);
 assert(!modelPools['相机'].some(x=>/vivo|RF100|神牛/i.test(x)));
 assert.equal(modelPools['手机'].filter(x=>/x300(?:u|ultra)$/i.test(x)).length,1);
 assert(modelPools['镜头'].includes('适马1850'));
 const pools=buildModelPools([{category:'佳能新品',combination:'R99 单机身'},{category:'富士镜头',combination:'XF16-50镜头'}]);
 assert(pools['相机'].includes('R99'));assert(pools['镜头'].includes('XF16-50'));
});
test('new candidates alternate categories instead of filling slots with the first phone query',()=>{
 const items=Array.from({length:15},(_,i)=>({id:'p'+i,title:'求租 vivo X300Ultra',demand:true,inventory_match:true}));
 items.push({id:'c',title:'求租 富士',demand:true},{id:'l',title:'求租 RF100-400',demand:true},{id:'known',title:'佳能',known:true});
 const selected=freshPicks(items,12);assert.deepEqual(selected.slice(0,3).map(x=>x.id),['c','p0','l']);assert(!selected.some(x=>x.id==='known'));assert.equal(selected.length,12);
});
test('merchant comment sources stay capped and source category never overwrites explicit title category',()=>{
 const a=Array.from({length:10},(_,i)=>({id:i,title:'相机出租',merchant:true}));assert.equal(freshPicks(a,12).length,2);
 const b=[{id:'phone',title:'vivo X300Ultra',category:'镜头'},{id:'lens',title:'RF100-400',category:'镜头'}];assert.equal(freshPicks(b,12)[0].id,'phone');
});
test('new posts start before hot reads and all queues survive scheduling without duplicate details',()=>{
 const fresh=Array.from({length:9},(_,i)=>({id:'n'+i})),hot=Array.from({length:6},(_,i)=>({id:'h'+i,phase:'hot'})),old=[{id:'o'},{id:'n0'}];
 const scheduled=detailOrder(fresh,hot,old);assert.equal(scheduled[0].phase,'new');assert.equal(scheduled.length,16);assert.equal(new Set(scheduled.map(x=>x.id)).size,16);
 assert.deepEqual(scheduled.slice(0,7).map(x=>x.phase),['new','hot','recheck','new','new','new','new']);
 const latest=Array.from({length:9},(_,i)=>({keyword:'l'+i}));const order=searchOrder(latest,[{keyword:'h'}]);assert.deepEqual(order.map(x=>x.keyword),['l0','l1','l2','h','l3','l4','l5','l6','l7','l8']);
});
test('delivery keeps direct demand first, caps each source, and keeps peer comments at or below 20 percent',()=>{
 const make=(key,type,note,source=false,text='求租R50')=>({key,type,note_id:note,title:text,desc:text,published_at_ms:Date.now(),source_is_merchant:source,...(type==='comment'?{comment:{text,published_at_ms:Date.now()}}:{})});
 const rows=[make('direct','note','direct'),...Array.from({length:8},(_,i)=>make('organic'+i,'comment','organic')),...Array.from({length:8},(_,i)=>make('peer'+i,'comment','peer',true))];
 const result=deliveryPicks(rows,{peer_max_share:.2,max_peer_sources_per_run:2,max_records_per_source_per_run:5,model_family_soft_share:.3,family_cap_minimum_candidates:100});
 assert.equal(result.selected.filter(x=>x.note_id==='organic').length,5);
 assert.equal(result.selected.filter(x=>x.source_is_merchant).length,1);
 assert.equal(result.selected[0].type,'note');assert.equal(result.selected.at(-1).source_is_merchant,true);
 assert.equal(new Set(result.selected.map(x=>x.key)).size,result.selected.length);
});
test('dominant known model family is deferred while diverse families remain available',()=>{
 const row=(key,text)=>({key,type:'comment',note_id:key,title:text,published_at_ms:Date.now(),comment:{text,published_at_ms:Date.now()}});
 const rows=[...Array.from({length:20},(_,i)=>row('x'+i,'求租 vivo X300Ultra')),...['R50','富士X100V','pocket3','GR3','尼康Z30','三星S23U','RF100-400','适马1850','腾龙18300','拍立得mini12'].map((x,i)=>row('d'+i,'求租 '+x))];
 const result=deliveryPicks(rows,{peer_max_share:.2,max_peer_sources_per_run:2,max_records_per_source_per_run:5,model_family_soft_share:.3,family_cap_minimum_candidates:10});
 const x300=result.selected.filter(x=>/X300/i.test(x.comment.text)).length;
 assert(x300/result.selected.length<=.3);assert(result.deferred.some(x=>/X300/i.test(x.comment.text)));
});
test('presentation always places direct posts, organic comments, peer comments, then statuses',()=>{
 const rows=[{key:'peer',type:'comment',note_id:'p',title:'租相机',source_is_merchant:true,comment:{text:'问价',published_at_ms:1}},{key:'organic',type:'comment',note_id:'o',title:'演唱会',comment:{text:'求租',published_at_ms:1}},{key:'direct',type:'note',note_id:'d',title:'求租相机',published_at_ms:1},{key:'status',type:'resolved',note_id:'s'}];
 assert.deepEqual(presentationOrder(rows).map(x=>x.key),['direct','organic','peer','status']);
});
test('recent candidates rank first; inventory wins within same 12 hour age band',()=>{
 const make=(text,h)=>({type:'comment',comment:{text,published_at_ms:Date.now()-h*3600000}});
 const newest=make('求租手机',1),oldInventory=make('求租R50',48),freshInventory=make('求租R50',2);
 assert(compare(newest,oldInventory)<0);assert(compare(freshInventory,newest)<0);
});
test('active rechecks do not starve older tracked posts',()=>{
 const notes={};for(let i=0;i<10;i++)notes[i]={token:'test',last_checked:new Date(Date.now()-i*3600000).toISOString(),...(i<5?{last_activity_at:new Date().toISOString()}: {})};
 const picked=rechecks(notes,4);assert.equal(picked.length,4);assert(picked.some(x=>Number(x.id)>=5));assert(picked.some(x=>Number(x.id)<5));
});
test('review cost/time budget defers without model calls or losing candidates',async()=>{
 const x={key:'test',type:'comment',comment:{author:'客户',text:'求租R50',published_at_ms:Date.now()-1000}},watch={outbox:{test:x}};
 const result=await reviewQueue(watch,{sent:{}},{items:{}},{},{budget:{deadline:Date.now()+10000,max_usd:0.01,cost_usd:0},fetcher:()=>{throw Error('must not call');}});
 assert.equal(result.stats.deferred,1);assert(watch.outbox.test);
});
test('reply context is included without private metadata',()=>{
 const s=input({type:'comment',title:'租相机',comment:{text:'国庆还有吗',parent_text:'有大疆4p吗',author_id:'private-id'}});
 assert.equal(s.parent_context,'有大疆4p吗');assert(!JSON.stringify(s).includes('private-id'));
});
test('a failed recent attempt cannot permanently starve untouched old posts',()=>{
 const old=new Date(Date.now()-10*86400000).toISOString();
 const notes={failed:{token:'test',last_checked:old,last_attempted:new Date().toISOString()},untouched:{token:'test',last_checked:old}};
 assert.equal(rechecks(notes,1)[0].id,'untouched');
});
