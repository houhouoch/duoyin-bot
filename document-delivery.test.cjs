const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildDocument,verifyDocument,publishDocument}=require('./document-delivery.cjs');
const config=require('./monitor-config.json');
const now=Date.now();
const lead=i=>({key:'c'+i,type:'comment',note_id:'fixture',url:'https://www.xiaohongshu.com/explore/fixture',title:'相机求租',comment:{id:'c'+i,author:'测试用户'+i,text:'想租相机'+i,published_at_ms:now-1000}});
function fixture(){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-document-')),delivery={};let body='',creates=0,writes=0,throwAfterWrite=false;
 const doc=buildDocument(Array.from({length:27},(_,i)=>lead(i)),{started_at:new Date(now).toISOString()},config,now);
 const cli=args=>{
  const data=JSON.parse(args.at(-1)),cmd=args.slice(0,args.indexOf('--json')).join(' ');let result={errcode:0};
  if(cmd==='smartpage create'){creates++;result={...result,docid:'a1_fixture',url:'https://doc.weixin.qq.com/smartpage/a1_fixture'};}
  else if(cmd==='doc rules update'){assert.equal(data.corp_internal_join_auth,'read');assert.equal(data.corp_external_join_auth,'read');}
  else if(cmd==='smartpage pages get')result={...result,doc_title:doc.name,pages:[{page_id:'p1',...(data.page_id?{content_file_inner:body}:{})}]};
  else if(cmd==='smartpage pages append'){writes++;body=fs.readFileSync(data.file_path,'utf8');if(throwAfterWrite)throw Error('timeout');}
  else throw Error(cmd);
  return JSON.stringify(result);
 };
 return {base,delivery,doc,cli,save(){},join:'public',stats:()=>({creates,writes}),timeout:()=>{throwAfterWrite=true;}};
}
test('document contains 27 rows without six-row truncation; one post header',()=>{
 const f=fixture();try{assert.equal(f.doc.rows.length,27);assert.equal(f.doc.links.length,1);assert(verifyDocument(f.doc,f.doc.content));}finally{fs.rmSync(f.base,{recursive:true});}
});
test('reject missing final row, duplicate row, missing end and changed link',()=>{
 const f=fixture();try{
  for(const text of [f.doc.content.replace(f.doc.rows.at(-1),''),f.doc.content+'\n'+f.doc.rows[0],f.doc.content.replace(f.doc.end,''),f.doc.content.replace('/explore/fixture','/explore/wrong')])assert.throws(()=>verifyDocument(f.doc,text));
 }finally{fs.rmSync(f.base,{recursive:true});}
});
test('publish readback then resume reuses document without writing twice',()=>{
 const f=fixture();try{
  const a=publishDocument(f.doc,f),b=publishDocument(f.doc,f);assert.equal(a.hash,b.hash);assert.equal(a.keys.length,27);assert.deepEqual(f.stats(),{creates:1,writes:1});assert(!a.content.includes('测试用户'));
 }finally{fs.rmSync(f.base,{recursive:true});}
});
test('uncertain append resumes by reading complete document, never blindly appends twice',()=>{
 const f=fixture();try{f.timeout();assert.throws(()=>publishDocument(f.doc,f));publishDocument(f.doc,f);assert.deepEqual(f.stats(),{creates:1,writes:1});}finally{fs.rmSync(f.base,{recursive:true});}
});
test('unknown create result does not create another document',()=>{
 const f=fixture();try{f.delivery.documents={[f.doc.id]:{status:'creating'}};assert.throws(()=>publishDocument(f.doc,f),/停止自动重复创建/);assert.equal(f.stats().creates,0);}finally{fs.rmSync(f.base,{recursive:true});}
});
test('explicit create rejection can retry while unknown transport cannot',()=>{
 const f=fixture();try{
  const real=f.cli;let failed=false;
  f.cli=args=>{if(!failed&&args[1]==='create'){failed=true;return JSON.stringify({errcode:500});}return real(args);};
  assert.throws(()=>publishDocument(f.doc,f));assert.equal(f.delivery.documents[f.doc.id].status,'create_failed');
  publishDocument(f.doc,f);assert.equal(f.stats().creates,1);
 }finally{fs.rmSync(f.base,{recursive:true});}
});
test('unsafe markup is rejected before cloud calls',()=>{
 const x=lead(1);x.comment.text='javascript:alert(1)';assert.throws(()=>buildDocument([x],{},config),/安全/);
});
test('approved format counts 17 actual records under eight title links, not 17 posts or people',()=>{
 const pending=[];
 for(let i=0;i<5;i++)pending.push({key:'n'+i,type:'note',note_id:'post'+i,url:'https://www.xiaohongshu.com/explore/post'+i,title:'求租相机'+i,author:'同一昵称',desc:'需要租相机',published_at_ms:now});
 for(const [post,count] of [[4,2],[5,7],[6,2],[7,1]])for(let i=0;i<count;i++)pending.push({...lead(post+'-'+i),note_id:'post'+post,url:'https://www.xiaohongshu.com/explore/post'+post});
 const doc=buildDocument(pending,{},config,now);
 assert.equal(doc.rows.length,17);assert.equal(doc.links.length,8);
 assert.deepEqual(doc.statistics.map(s=>s.total),[1,1,1,1,3,7,2,1]);
 assert(doc.content.includes('本帖共3条求租线索｜帖子需求1条＋评论需求2条'));
 assert(doc.content.includes('本帖共7条求租线索｜评论需求7条'));
 assert(doc.summary.includes('8个原帖链接、17条求租线索，其中帖子需求5条、评论需求12条'));
 assert(doc.summary.includes('不等于17位独立客户'));
 assert(!doc.content.includes('<linkcard'));
 assert(verifyDocument(doc,doc.content));
 assert.throws(()=>verifyDocument(doc,doc.content.replace(doc.statistics[0].label,'')),/分组统计/);
 assert.throws(()=>verifyDocument(doc,doc.content.replace(doc.summary,'')),/总数说明/);
});
test('status changes are counted separately, never presented as new demand',()=>{
 const pending=[{...lead(1),type:'resolved',author:'用户',evidence:'已经租到了'},{...lead(2),type:'correction',author:'商家'}];
 const doc=buildDocument(pending,{},config,now);
 assert.equal(doc.rows.length,2);assert(doc.statistics[0].label.includes('本帖共2条记录｜状态更新1条＋更正1条'));
 assert(doc.summary.includes('0条求租线索'));assert(doc.summary.includes('状态更新1条、更正1条，不计入求租线索'));
});
test('sender sends one document link, retries explicit failure, and preserves key dedup (mock transport)',()=>{
 const {execFileSync}=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-document-sender-'));
 try{
  for(const name of ['notify-four-hour.cjs','document-delivery.cjs','lead-timeliness.cjs','lead-presentation.cjs','delivery-integrity.cjs','concise-message.cjs','demand-validity.cjs','deepseek-review.cjs','lead-fields.cjs','rental-strategy.cjs','hot-pools.cjs','camera-catalog.json'])fs.copyFileSync(path.join(__dirname,name),path.join(dir,name));
  fs.writeFileSync(path.join(dir,'monitor-config.json'),JSON.stringify({...config,document_delivery:{enabled:true,join:'public'},deepseek_review:{enabled:false}}));
  const rows=Array.from({length:27},(_,i)=>lead(i));
  fs.writeFileSync(path.join(dir,'watchlist.json'),JSON.stringify({outbox:Object.fromEntries(rows.map(x=>[x.key,x]))}));
  const scan=path.join(dir,'scan.json');fs.writeFileSync(scan,JSON.stringify({started_at:new Date(now).toISOString(),complete:true}));
  fs.writeFileSync(path.join(dir,'wecom-cli'),`#!${process.execPath}
const fs=require('fs'),p=require('path'),a=process.argv.slice(2),root=process.env.TEST_ROOT;
const args=a.includes('--json')?JSON.parse(a[a.indexOf('--json')+1]):{};const cmd=a.slice(0,a.includes('--json')?a.indexOf('--json'):a.length).join(' ');
let r={errcode:0};
if(cmd==='--version'){console.log('1.2.1');process.exit();}
if(cmd==='auth show --status'){console.log('authorized');process.exit();}
if(cmd==='message aibot sessions list')r.sessions=[{chat_id:'fixture',chat_name:'测试线索群',chat_type:'group'}];
else if(cmd==='smartpage create'){fs.writeFileSync(p.join(root,'title'),args.name);fs.appendFileSync(p.join(root,'creates'),'1');r.docid='a1_fixture';r.url='https://doc.weixin.qq.com/smartpage/a1_fixture';}
else if(cmd==='doc rules update'){if(args.corp_external_join_auth!=='read')throw Error('wrong ACL');}
else if(cmd==='smartpage pages get')r={...r,doc_title:fs.readFileSync(p.join(root,'title'),'utf8'),pages:[{page_id:'p1',...(args.page_id?{content_file_inner:fs.existsSync(p.join(root,'body'))?fs.readFileSync(p.join(root,'body'),'utf8'):''}:{})}]};
else if(cmd==='smartpage pages append')fs.copyFileSync(args.file_path,p.join(root,'body'));
else if(cmd==='message aibot send'){fs.appendFileSync(p.join(root,'messages'),JSON.stringify(args)+'\\n');r.success=!process.env.FAIL_SEND;}
else throw Error(cmd);console.log(JSON.stringify(r));`,{mode:0o700});
  const run=extra=>execFileSync(process.execPath,[path.join(dir,'notify-four-hour.cjs'),'--scan',scan,'--priority-bypass'],{env:{...process.env,PATH:dir+':/usr/bin:/bin',TEST_ROOT:dir,...extra},stdio:['ignore','pipe','pipe'],encoding:'utf8'});
  assert.throws(()=>run({FAIL_SEND:'1'}));
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir,'leads-history.json'))).sent).length,0);
  run({});const receipt=JSON.parse(fs.readFileSync(path.join(dir,'four-hour-last-delivery.json')));
  assert.equal(receipt.accepted,27);assert.equal(receipt.messages,1);assert.equal(receipt.document_verified,true);
  const history=JSON.parse(fs.readFileSync(path.join(dir,'leads-history.json')));assert.equal(Object.keys(history.sent).length,27);
  const before=fs.readFileSync(path.join(dir,'messages'),'utf8');run({});assert.equal(fs.readFileSync(path.join(dir,'messages'),'utf8'),before);
  assert.equal(fs.readFileSync(path.join(dir,'creates'),'utf8'),'1');assert(before.includes('查看完整文档'));assert(!before.includes('想租相机'));
 }finally{fs.rmSync(dir,{recursive:true});}
});

test('whole-row verification separates an original quote from a labeled quote',()=>{
 const a='- 主评论｜测试用户｜10/8：“蹲vivo x300”',b=a+'（意图待确认）';
 const doc={rows:[a,b],content:a+'\n'+b+'\n结束',end:'结束',links:[]};
 assert(verifyDocument(doc,doc.content));
 assert.throws(()=>verifyDocument(doc,doc.content.replace(a+'\n','')),/遗漏或重复/);
 assert.throws(()=>verifyDocument(doc,doc.content+'\n'+a),/遗漏或重复/);
 assert.throws(()=>verifyDocument(doc,doc.content.replace(b,a)),/遗漏或重复/);
});
test('manual-review rows do not replace or duplicate valid rows',()=>{
 const row='- 主评论｜测试用户｜10/8：“想租相机”';
 const doc={rows:[row],content:row+'\n结束',end:'结束',links:[]};
 const review='### 待核实候选（人工审查）\n'+row+'\n### 补充线索｜同行帖子评论\n';
 assert(verifyDocument(doc,review+doc.content));
 assert.throws(()=>verifyDocument(doc,review+'结束'),/遗漏或重复/);
});
