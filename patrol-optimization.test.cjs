const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {deliveryPicks,searchOrder}=require('./rental-strategy.cjs');
const {describe}=require('./lead-presentation.cjs');
const {reviewQueue,hash}=require('./deepseek-review.cjs');
const {scheduleAudit,preflight,detailTimeout,detailResult}=require('./patrol-health.cjs');
const {buildDocument}=require('./document-delivery.cjs');
const {publishDailyDocument}=require('./daily-document-delivery.cjs');
const {syncWorkspace}=require('./daily-document-extras.cjs');
const config={...require('./monitor-config.json'),delivery_priority:{...require('./monitor-config.json').delivery_priority,include_peer_leads:true,peer_max_share:0.2,max_peer_sources_per_run:2,supplemental_enabled:true,supplemental_max_per_run:50},document_layout:{...require('./monitor-config.json').document_layout,followup_enabled:true}};
const time=new Date().toISOString();
const lead=(i,peer=false)=>({key:'c'+i,type:'comment',note_id:'p'+Math.floor(i/5),title:'求租手机',source_is_merchant:peer,url:'https://www.xiaohongshu.com/explore/p'+Math.floor(i/5),comment:{id:'c'+i,author:'测试用户',text:'求租 RF100400 镜头',published_at_ms:Date.now()-i*60000}});
test('a bounded supplemental lane progresses even when no main candidates exist',()=>{
 const rows=Array.from({length:80},(_,i)=>lead(i,true));
 const selected=deliveryPicks(rows,config.delivery_priority);
 assert.equal(selected.selected.length,50);assert.equal(selected.deferred.length,30);assert(selected.selected.every(x=>x.delivery_lane==='supplemental'));
 assert.equal(new Set(selected.selected.map(x=>x.key)).size,50);
 const counts={};for(const x of selected.selected)counts[x.note_id]=(counts[x.note_id]||0)+1;assert(Object.values(counts).every(n=>n<=5));
 assert.equal(deliveryPicks(rows,{...config.delivery_priority,supplemental_enabled:false}).selected.length,0);
});
test('main quotas and supplemental keys stay disjoint when the same peer source has many comments',()=>{
 const rows=[...Array.from({length:8},(_,i)=>lead(i)),...Array.from({length:70},(_,i)=>lead(i+100,true))];
 const p=deliveryPicks(rows,config.delivery_priority),keys=p.selected.map(x=>x.key);
 assert(p.selected.some(x=>!x.source_is_merchant));assert.equal(p.selected.filter(x=>x.source_is_merchant).length,50);
 assert.equal(new Set(keys).size,keys.length);assert(p.deferred.every(x=>!keys.includes(x.key)));
});
test('supplemental cap remains absolute when main lead counts are high',()=>{
 const rows=[...Array.from({length:240},(_,i)=>lead(i)),...Array.from({length:100},(_,i)=>lead(i+1000,true))];
 const selected=deliveryPicks(rows,{...config.delivery_priority,max_peer_sources_per_run:100,family_cap_minimum_candidates:1000});
 assert.equal(selected.selected.filter(x=>x.source_is_merchant).length,50);
 assert.equal(selected.supplemental,50);
});
test('classification uses the comment evidence and never borrows a phone model from its post',()=>{
 const x=lead(1);x.delivery_lane='supplemental';x.ai_review={decision:'inquiry',device:'RF100400'};
 const d=describe([x]);assert.equal(d.rows[0].category,'镜头');assert.equal(d.rows[0].intent,'询价');assert.equal(d.supplemental_count,1);
 assert(d.followup.includes('未登记'));assert(d.followup.includes('已联系'));assert(d.followup.includes('已解决'));
 const vague=lead(2);vague.comment.text='这个多少钱';assert.equal(describe([vague]).rows[0].category,'其他与待确认');
});
test('exact-source validation failures cool down, then enter manual review without changing valid caches',async()=>{
 const x=lead(1),w={outbox:{[x.key]:x}},cache={items:{}};let calls=0;
 const fetcher=async()=>{calls++;return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({decision:'demand',evidence:x.comment.text,device:'不存在的型号',location:'未知',rental_period:'未知'})}}]})};};
 const credentials={base_url:'https://api.deepseek.com',model:'deepseek-flash',api_key:'fixture'};
 await reviewQueue(w,{sent:{}},cache,credentials,{fetcher});assert.equal(calls,2);assert.equal(x.ai_review_error.failed_rounds,1);
 const second=await reviewQueue(w,{sent:{}},cache,credentials,{fetcher});assert.equal(calls,2);assert.equal(second.stats.cooldown_candidates,1);
 x.ai_review_error.next_retry_at=new Date(Date.now()-1000).toISOString();await reviewQueue(w,{sent:{}},cache,credentials,{fetcher});assert.equal(calls,4);assert(x.ai_review_error.manual_review_required);
 await reviewQueue(w,{sent:{}},cache,credentials,{fetcher});assert.equal(calls,4);assert.equal(x.ai_review_error.input_hash,hash(x));assert(!x.ai_review);assert(w.outbox[x.key]);
});
test('the first six searches cover one inventory and one demand query from every category',()=>{
 const categories=['相机','手机','镜头'];const plan=categories.flatMap(category=>[{keyword:category+'1',kind:'latest',query_kind:'inventory',category},{keyword:category+'2',kind:'latest',query_kind:'inventory',category}]).concat(categories.map(category=>({keyword:'求租'+category,kind:'latest',query_kind:'discovery',category})));
 const ordered=searchOrder(plan,[{keyword:'hot'}]);
 for(const c of categories)assert(ordered.slice(0,6).some(x=>x.category===c&&x.query_kind==='discovery'));
 assert.equal(ordered.at(-1).keyword,'hot');assert.equal(ordered.length,10);
});
test('missed slots exclude maintenance runs, and detail cooldown retains high priority demand reads',()=>{
 const now=Date.parse('2026-10-08T02:35:00Z'),history=[{started_at:'2026-10-08T00:02:00Z'},{started_at:'2026-10-07T20:04:00Z',mode:'refresh-document'}];
 const audit=scheduleAudit(history,now);assert(audit.missing.includes('2026-10-07T20:00:00.000Z'));assert(!audit.missing.includes('2026-10-08T00:00:00.000Z'));
 const watch={notes:{},detail_health:{}};detailResult(watch,'p',{status:'failed',elapsed_ms:120000});detailResult(watch,'p',{status:'failed',elapsed_ms:60000});assert(watch.detail_health.p.next_attempt_at);
 assert.equal(detailTimeout({id:'p'},watch),60000);assert.equal(detailTimeout({id:'p',demand:true},watch),120000);
 detailResult(watch,'p',{status:'success',elapsed_ms:12000});assert.equal(watch.detail_health.p.failures,0);assert(!watch.detail_health.p.next_attempt_at);
});
test('permission preflight checks the actual session and document read without writing a document',()=>{
 const calls=[],cli=a=>{calls.push(a.join(' '));if(a[0]==='--version')return 'wecom-cli 1.2.1';if(a[0]==='auth')return 'authorized';if(a[0]==='message')return JSON.stringify({sessions:[{chat_name:'目标群',chat_type:'group'}]});return JSON.stringify({errcode:0,pages:[]});};
 const result=preflight(cli,{daily_documents:{day:{docid:'fixture'}}},'目标群');assert.equal(result.document_read,'ready');assert(calls.some(x=>x.startsWith('smartpage pages get')));assert(calls.every(x=>!x.includes('append')&&!x.includes('send')));
 assert.throws(()=>preflight(a=>a[0]==='--version'?'1.2.0':cli(a),{},'目标群'),/版本/);
});
function cloud(t){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-workspace-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));fs.mkdirSync(path.join(base,'smartpage'));fs.writeFileSync(path.join(base,'monitor-config.json'),JSON.stringify({...config,document_layout:{...config.document_layout,structure:'classified'}}));
 const delivery={},documents={},calls=[];let serial=0;
 const cli=a=>{
  const cmd=a.slice(0,a.includes('--json')?a.indexOf('--json'):a.length).join(' ');calls.push(cmd);
  if(cmd==='identity whoami')return JSON.stringify({extra_identity_context:'授权真人用户身份：\n名字：本人\nID：authorized-user\n'});
  const d=JSON.parse(a.at(-1));let r={errcode:0};
  if(cmd==='smartpage import'){const id='a1_cloud',p='p'+(++serial);documents[id]={title:d.name,pages:{[p]:{page_id:p,page_title:d.name,parent_id:'root',body:fs.readFileSync(d.file_path,'utf8')}}};r={task_status:'succ',url:'https://doc.weixin.qq.com/smartpage/'+id};}
  else if(cmd==='smartpage pages get'){const doc=documents[d.docid];r={...r,doc_title:doc.title,pages:Object.values(doc.pages).filter(p=>!d.page_id||p.page_id===d.page_id).map(({body,...p})=>({...p,...(d.page_id?{content_file_inner:JSON.stringify(d.content_type==='block'?[{id:'summary',property:{title:{text:body.split('\n').find(x=>x.startsWith('今日收录：'))}}}]:body)}:{})}))};}
  else if(cmd==='smartpage pages update'){const id='p'+(++serial);documents[d.docid].pages[id]={page_id:id,page_title:d.create_page.page_name,parent_id:d.create_page.parent_page_id,body:''};r.page_id=id;}
  else if(cmd==='smartpage pages append')documents[d.docid].pages[d.page_id].body+=fs.readFileSync(d.file_path,'utf8');
  else if(cmd==='smartpage blocks update'){const p=documents[d.docid].pages[d.page_id];p.body=p.body.replace(/^今日收录：.*$/m,d.mdx);}
  else if(cmd==='doc members update'){assert.equal(d.add_member_list.items.length,1);assert.equal(d.add_member_list.items[0].userid,'authorized-user');assert.equal(d.add_member_list.items[0].user_auth,'edit');}
  else assert.equal(cmd,'doc rules update');
  return JSON.stringify(r);
 };
 return {base,delivery,documents,calls,cli,save:()=>{}};
}
test('workspace navigation, followup tables and issue archives are idempotent and send no group alerts',t=>{
 const c=cloud(t),x=lead(1),scan={started_at:time,complete:true},doc=buildDocument([x],scan,config);publishDailyDocument(doc,{...c,scan,layout:{structure:'classified'}});
 c.delivery.operational_notes={one:{id:'one',status:'pending',started_at:time,accepted:1,searches_completed:7,searches_planned:11,detail_failures:2,review_pending:7,warnings:['详情读取超时'],schedule_missing:[]}};
 const first=syncWorkspace({...c,scan,allowFollowupEditing:true});assert.equal(first.status,'verified');assert.equal(c.delivery.operational_notes.one.status,'archived');
 const pages=Object.values(c.documents.a1_cloud.pages);assert(pages.some(x=>x.page_title==='运行记录'&&x.body.includes('待核实候选7条')));assert(pages.some(x=>x.page_title==='镜头'&&x.body.includes('镜头1条')));assert(pages.some(x=>x.body.includes('分类与跟进索引')&&x.body.includes('未登记')));
 const readsBefore=c.calls.filter(x=>x==='smartpage pages get').length;const writes=c.calls.filter(x=>/append|update|import/.test(x)).length;syncWorkspace({...c,scan,allowFollowupEditing:true});assert.equal(c.calls.filter(x=>/append|update|import/.test(x)).length,writes);assert(!c.calls.some(x=>x.includes('message')));assert.equal(c.calls.filter(x=>x==='smartpage pages get').length-readsBefore,1);
});
test('an unconfirmed workspace append is not blindly repeated',t=>{
 const c=cloud(t),scan={started_at:time,complete:true};publishDailyDocument(buildDocument([lead(1)],scan,config),{...c,scan,layout:{structure:'classified'}});
 const cli=a=>{if(a.slice(0,3).join(' ')==='smartpage pages append')throw Error('transport uncertain');return c.cli(a);};
 assert.throws(()=>syncWorkspace({...c,cli,scan}),/不确定/);assert.throws(()=>syncWorkspace({...c,scan}),/待核实/);
});
