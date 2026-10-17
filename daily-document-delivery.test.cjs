const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {publishDailyDocument,clock,verifyRound,response,smartpageId}=require('./daily-document-delivery.cjs');
const {buildDocument}=require('./document-delivery.cjs');
const config=require('./monitor-config.json');
const first='2026-09-20T04:00:00.000Z';
const lead=i=>({key:'n'+i,type:'note',note_id:'n'+i,title:'求租相机'+i,desc:'求租相机'+i,url:'https://www.xiaohongshu.com/explore/n'+i,author:'测试',published_at_ms:Date.parse(first)});
const build=(ids,start=first)=>buildDocument(ids.map(lead),{started_at:start,complete:true},config,Date.parse(start));
function fixture(t){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-daily-'));t.after(()=>fs.rmSync(base,{recursive:true}));
 const delivery={},docs={},calls=[],stats={imports:0,creates:0,appends:0,replaces:0};let serial=0;
 const native=s=>s.replace(/\*\*/g,'').replace(/\[[^\]]*\]\([^\s)]+\)/g,'△');
 const control={};
 const cli=args=>{
  const data=JSON.parse(args.at(-1)),cmd=args.slice(0,args.indexOf('--json')).join(' ');calls.push(cmd);
  if(control.reject===cmd){control.reject=null;throw Object.assign(Error('cli rejected'),{stdout:JSON.stringify({error:{code:640027,message:'bad input'}})});}
  let r={errcode:0};
  if(cmd==='smartpage import'){
   stats.imports++;const id='a1_test'+(++serial),p='p'+serial;
   const source=fs.readFileSync(data.file_path,'utf8'),importTitle=control.importTitleFromH1?source.match(/^# (.+)$/m)?.[1]:data.name;
   docs[id]={title:importTitle,pages:{[p]:{page_id:p,page_title:importTitle,parent_id:'root',body:native(source)}}};
   r={task_status:'succ',docid:'internal-'+serial,url:'https://doc.weixin.qq.com/smartpage/'+id};
  }else if(cmd==='doc rules update'){assert.equal(data.corp_external_join_auth,'read');}
  else if(cmd==='smartpage pages get'){
   const d=docs[data.docid];let pages=Object.values(d.pages).filter(p=>!data.page_id||p.page_id===data.page_id);
   r={...r,doc_title:d.title,pages:pages.map(({body,...p})=>({...p,...(data.page_id?{content_file_inner:JSON.stringify(data.content_type==='block'?[{id:'summary',property:{title:{text:body.split('\n').find(s=>s.startsWith('今日收录：'))}}}]:body)}:{})}))};
  }else if(cmd==='smartpage pages update'){
   assert(!/[\\/:*?"<>|]/.test(data.create_page.page_name));stats.creates++;
   const id='p'+(++serial);docs[data.docid].pages[id]={page_id:id,parent_id:data.create_page.parent_page_id,page_title:data.create_page.page_name,body:''};
   r={...r,page_id:id,page_url:'https://doc.weixin.qq.com/smartpage/'+data.docid+'?p='+id};
  }else if(cmd==='smartpage pages append'){
   stats.appends++;docs[data.docid].pages[data.page_id].body+='\n'+native(fs.readFileSync(data.file_path,'utf8'));
   r.status='success';
  }else if(cmd==='smartpage blocks update'){
   assert.equal(data.method,'replace');assert.equal(data.block_id,'summary');stats.replaces++;
   const p=docs[data.docid].pages[data.page_id];p.body=p.body.replace(/^今日收录：.*$/m,data.mdx);r.status='success';
  }else throw Error(cmd);
  if(control.timeout===cmd){control.timeout=null;throw Error('timeout after mutation');}
  return JSON.stringify(r);
 };
 const run=(doc,start=first,extra={})=>publishDailyDocument(doc,{cli,delivery,save(){},base,join:'public',layout:{structure:'classified'},scan:{started_at:start,complete:true},...extra});
 return {base,delivery,docs,stats,control,calls,cli,run};
}
test('BJT date rollover and colon-free page names',()=>{
 assert.deepEqual(clock('2026-09-20T16:00:00Z'),{day:'2026-09-21',time:'00:00:00',name:'00时00分00秒',short:'9/21 00:00'});
 assert.throws(()=>clock('invalid'));
});
test('editable URL pad id is canonical when import returns a different internal id',()=>{
 assert.equal(smartpageId('https://doc.weixin.qq.com/smartpage/a1_valid-ID_2?scode=test'),'a1_valid-ID_2');
 assert.throws(()=>smartpageId('https://page.weixin.qq.com/smartpage/a1_bad'));
});
test('import title derived from first H1 is accepted and recorded',t=>{
 const f=fixture(t);f.control.importTitleFromH1=true;f.run(build([1]));
 const day=f.delivery.daily_documents['2026-09-20'];
 assert.equal(day.doc_title,day.name);
});
test('one daily document, separate child rounds, concise message, cumulative counts',t=>{
 const f=fixture(t),a=f.run(build([1,2])),second='2026-09-20T08:00:00Z',b=f.run(build([3],second),second);
 assert.equal(f.stats.imports,1);assert.equal(f.stats.creates,2);assert.equal(a.overview_url,b.overview_url);assert.notEqual(a.document_url,b.document_url);
 assert(a.content.includes('新增2条需求／2个帖子'));assert(a.content.includes('查看本轮'));assert(a.content.includes('今日总览'));assert(!a.content.includes('求租相机1'));
 const d=Object.values(f.docs)[0],home=Object.values(d.pages)[0];assert(home.body.includes('今日收录：3条求租需求，来自3个原帖'));assert(home.body.includes('已归档2轮'));
});
test('same round rerun reads and reuses pages without duplicate writes',t=>{
 const f=fixture(t),doc=build([1]);const a=f.run(doc),before={...f.stats},b=f.run(doc);assert.deepEqual(f.stats,before);assert.equal(a.hash,b.hash);
});
test('new Beijing day creates one separate daily document',t=>{
 const f=fixture(t);f.run(build([1]));const next='2026-09-20T16:00:00Z';f.run(build([2],next),next);assert.equal(f.stats.imports,2);
});
test('new comments on same post count as one distinct post across rounds',t=>{
 const f=fixture(t),a=lead(1),b={...lead(2),note_id:a.note_id,url:a.url};f.run(buildDocument([a],{started_at:first},config,Date.parse(first)));
 const second='2026-09-20T08:00:00Z';f.run(buildDocument([b],{started_at:second},config,Date.parse(second)),second);
 assert(Object.values(Object.values(f.docs)[0].pages)[0].body.includes('2条求租需求，来自1个原帖'));
});
test('empty completed round is archived quietly; incomplete is not no-results success',t=>{
 const f=fixture(t),a=f.run(null);assert(a.quiet);assert(!a.content);assert.equal(f.stats.creates,1);
 const second='2026-09-20T08:00:00Z';f.run(null,second,{awaiting:2});
 assert(Object.values(Object.values(f.docs)[0].pages).some(p=>p.body.includes('本轮未完成查询或仍有待处理内容')));
});
test('unknown import does not create a duplicate document',t=>{
 const f=fixture(t);f.control.timeout='smartpage import';assert.throws(()=>f.run(build([1])));assert.throws(()=>f.run(build([1])),/停止重复创建/);assert.equal(f.stats.imports,1);
});
test('definite CLI error envelope permits retry without false success',t=>{
 const f=fixture(t);f.control.reject='smartpage import';assert.throws(()=>f.run(build([1])),/640027/);assert.equal(f.delivery.daily_documents['2026-09-20'].status,'create_failed');f.run(build([1]));assert.equal(f.stats.imports,1);
});
test('unknown child create recovers only by unique actual tree match',t=>{
 const f=fixture(t),doc=build([1]);f.control.timeout='smartpage pages update';assert.throws(()=>f.run(doc));f.run(doc);assert.equal(f.stats.creates,1);
});
test('unknown append recovers readback without appending again',t=>{
 const f=fixture(t),doc=build([1]);f.control.timeout='smartpage pages append';assert.throws(()=>f.run(doc));f.run(doc);assert.equal(f.stats.appends,2);
});
test('inline placeholder readback is allowed but dropped rows and headings are rejected',()=>{
 const d=build([1,2]),body=d.content.replace(/\*\*/g,'').replace(/\[[^\]]*\]\([^\s)]+\)/g,'△');assert(verifyRound(d,body));
 assert.throws(()=>verifyRound(d,body.replace('2. △','')),/标题分组/);assert.throws(()=>verifyRound(d,body.replace(d.rows[1],'')));
});
test('legacy uncertainty and cross-round duplicate keys are stopped',t=>{
 const f=fixture(t),d=build([1]);f.delivery.documents={old:{status:'creating',keys:d.keys}};assert.throws(()=>f.run(d),/此前文档/);assert.equal(f.stats.imports,0);
 delete f.delivery.documents.old;f.run(d);const second='2026-09-20T08:00:00Z';assert.throws(()=>f.run(build([1,2],second),second),/相同待发记录/);
});
test('new scan recovers the original daily page and keeps fresh keys separate',t=>{
 const f=fixture(t),d=build([1]);f.run(d);
 const {resumeDailyDocuments}=require('./daily-document-delivery.cjs');
 const resumed=resumeDailyDocuments([lead(1),lead(2)],f.delivery,f.base);
 assert.equal(resumed.documents.length,1);assert.equal(resumed.documents[0].doc.id,d.id);assert.deepEqual(resumed.fresh.map(x=>x.key),['n2']);
 const before=f.stats.creates;f.run(resumed.documents[0].doc);assert.equal(f.stats.creates,before);
 const round=Object.values(f.delivery.daily_documents['2026-09-20'].rounds)[0];round.keys.push('missing');assert.throws(()=>resumeDailyDocuments([lead(1)],f.delivery,f.base),/部分记录/);
});
test('partially eligible old page is retained but only selected records enter a new round',t=>{
 const f=fixture(t),old=build([1,2]);f.run(old);
 const {resumeDailyDocuments}=require('./daily-document-delivery.cjs');
 const resumed=resumeDailyDocuments([lead(1)],f.delivery,f.base,{outbox:{n2:lead(2)}});
 assert.equal(resumed.documents.length,0);assert.deepEqual(resumed.fresh.map(x=>x.key),['n1']);
 const prior=Object.values(f.delivery.daily_documents['2026-09-20'].rounds)[0];
 assert(prior.delivery_superseded_at);assert.equal(prior.status,'verified');
 const next='2026-09-20T08:00:00Z';const msg=f.run(build([1],next),next);
 assert.deepEqual(msg.keys,['n1']);assert.equal(f.stats.creates,2);
});

function mockCliMain(){
 const fs=require('node:fs'),path=require('node:path');
 const root=process.env.TEST_ROOT,a=process.argv.slice(2),idx=a.indexOf('--json'),data=idx<0?{}:JSON.parse(a[idx+1]),cmd=a.slice(0,idx<0?a.length:idx).join(' ');
 if(cmd==='--version'){console.log('1.2.1');return;}if(cmd==='auth show --status'){console.log('authorized');return;}
 const p=path.join(root,'mock-cloud.json'),s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):{documents:{},serial:0,messages:[]};let r={errcode:0};
 const native=t=>t.replace(/\*\*/g,'').replace(/\[[^\]]*\]\([^\s)]+\)/g,'△');
 if(cmd==='message aibot sessions list')r.sessions=[{chat_id:'fixture',chat_name:'测试线索群',chat_type:'group'}];
 else if(cmd==='smartpage import'){
  const id='a1_fixture'+(++s.serial),page='p'+s.serial;
  s.documents[id]={title:data.name,pages:{[page]:{page_id:page,page_title:data.name,parent_id:'root',body:native(fs.readFileSync(data.file_path,'utf8'))}}};
  r={task_status:'succ',docid:id,url:'https://doc.weixin.qq.com/smartpage/'+id};
 }else if(cmd==='doc rules update'){if(data.corp_external_join_auth!=='read')throw Error('ACL');}
 else if(cmd==='smartpage pages get'){
  const d=s.documents[data.docid];r={...r,doc_title:d.title,pages:Object.values(d.pages).filter(p=>!data.page_id||p.page_id===data.page_id).map(({body,...p})=>({...p,...(data.page_id?{content_file_inner:JSON.stringify(data.content_type==='block'?[{id:'summary',property:{title:{text:body.split('\n').find(l=>l.startsWith('今日收录：'))}}}]:body)}:{})}))};
 }else if(cmd==='smartpage pages update'){
  const id='p'+(++s.serial);s.documents[data.docid].pages[id]={page_id:id,page_title:data.create_page.page_name,parent_id:data.create_page.parent_page_id,body:''};r={...r,page_id:id,page_url:'https://doc.weixin.qq.com/smartpage/'+data.docid+'?p='+id};
 }else if(cmd==='smartpage pages append')s.documents[data.docid].pages[data.page_id].body+='\n'+native(fs.readFileSync(data.file_path,'utf8'));
 else if(cmd==='smartpage blocks update'){const p=s.documents[data.docid].pages[data.page_id];p.body=p.body.replace(/^今日收录：.*$/m,data.mdx);}
 else if(cmd==='message aibot send'){s.messages.push(data.markdown.content);r.success=!process.env.FAIL_SEND;}
 else throw Error(cmd);
 fs.writeFileSync(p,JSON.stringify(s));console.log(JSON.stringify(r));
}
test('unified sender: daily delivery, failed-send retry, no duplicates, quiet empty next round',t=>{
 const {execFileSync}=require('node:child_process'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-daily-sender-'));t.after(()=>fs.rmSync(dir,{recursive:true}));
 for(const name of ['notify-four-hour.cjs','daily-document-delivery.cjs','document-delivery.cjs','lead-timeliness.cjs','lead-presentation.cjs','delivery-integrity.cjs','concise-message.cjs','demand-validity.cjs','deepseek-review.cjs','lead-fields.cjs','rental-strategy.cjs','hot-pools.cjs','camera-catalog.json'])fs.copyFileSync(path.join(__dirname,name),path.join(dir,name));
 fs.writeFileSync(path.join(dir,'monitor-config.json'),JSON.stringify({...config,document_delivery:{enabled:true,join:'public',mode:'daily'},document_layout:{...config.document_layout,structure:'classified'},deepseek_review:{enabled:false}}));
 const now=Date.now(),rows=[1,2].map(i=>({...lead(i),published_at_ms:now-1000}));
 fs.writeFileSync(path.join(dir,'watchlist.json'),JSON.stringify({outbox:Object.fromEntries(rows.map(x=>[x.key,x]))}));
 fs.writeFileSync(path.join(dir,'wecom-cli'),'#!'+process.execPath+'\n('+mockCliMain.toString()+')();',{mode:0o700});
 const scan=path.join(dir,'scan.json');fs.writeFileSync(scan,JSON.stringify({started_at:new Date(now).toISOString(),complete:true}));
 const run=extra=>execFileSync(process.execPath,[path.join(dir,'notify-four-hour.cjs'),'--scan',scan],{env:{...process.env,PATH:dir+':/usr/bin:/bin',TEST_ROOT:dir,...extra},stdio:['ignore','pipe','pipe'],encoding:'utf8'});
 assert.throws(()=>run({FAIL_SEND:'1'}));assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir,'leads-history.json'))).sent).length,0);
 run({});const cloud=()=>JSON.parse(fs.readFileSync(path.join(dir,'mock-cloud.json')));
 assert.equal(Object.keys(cloud().documents).length,1);assert.equal(Object.keys(Object.values(cloud().documents)[0].pages).length,2);
 assert.equal(cloud().messages.length,2);assert(cloud().messages[1].includes('查看本轮'));assert(cloud().messages[1].includes('今日总览'));
 const receipt=JSON.parse(fs.readFileSync(path.join(dir,'four-hour-last-delivery.json')));assert.equal(receipt.accepted,2);assert(receipt.overview_url);
 run({});assert.equal(cloud().messages.length,2);
 fs.writeFileSync(scan,JSON.stringify({started_at:new Date(now+60000).toISOString(),complete:true}));run({});
 assert.equal(cloud().messages.length,2);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'four-hour-last-delivery.json'))).status,'recorded_no_new');
 assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir,'leads-history.json'))).sent).length,2);
});

test('failed readback resumes known writing page and keeps partial selection separate',t=>{
 const f=fixture(t),doc=build([1,2]);f.run(doc);
 const day=f.delivery.daily_documents['2026-09-20'],r=day.rounds[doc.id];
 r.status='planned';f.delivery.documents[doc.id].status='writing';
 const writes={...f.stats};let saves=0;
 const result=require('./daily-document-delivery.cjs').resumeDailyDocuments([lead(1)],f.delivery,f.base,{outbox:{n2:lead(2)}},{cli:f.cli,save(){saves++;}});
 assert.equal(r.status,'verified');assert(r.recovered_by_readback_at);assert(r.delivery_superseded_at);
 assert.equal(f.delivery.documents[doc.id].status,'verified');assert.equal(saves,1);
 assert.deepEqual(result.fresh.map(x=>x.key),['n1']);assert.deepEqual(f.stats,writes);
 const next='2026-09-20T08:00:00Z';f.run(build([1],next),next);
 assert.equal(f.stats.creates,2);
});
test('unfinished page recovery rejects dropped text, unknown pages and missing read tools',t=>{
 const f=fixture(t),doc=build([1]);f.run(doc);
 const day=f.delivery.daily_documents['2026-09-20'],r=day.rounds[doc.id];r.status='planned';
 const resume=recovery=>require('./daily-document-delivery.cjs').resumeDailyDocuments([lead(1)],f.delivery,f.base,{},recovery);
 assert.throws(()=>resume({}),/需读回原页/);
 const p=f.docs[day.docid].pages[r.page_id];p.body=p.body.replace(doc.rows[0],'');
 assert.throws(()=>resume({cli:f.cli}),/遗漏或重复/);assert.equal(r.status,'planned');assert(!r.delivery_superseded_at);
 delete f.docs[day.docid].pages[r.page_id];assert.throws(()=>resume({cli:f.cli}),/页面层级/);
});
