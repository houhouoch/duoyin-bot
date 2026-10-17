const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {buildDocument}=require('./document-delivery.cjs'),{publishDailyDocument}=require('./daily-document-delivery.cjs');
const {syncWorkspace,label}=require('./chronological-document.cjs');
const config=require('./monitor-config.json');
function fixture(t){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-time-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));fs.writeFileSync(path.join(base,'monitor-config.json'),JSON.stringify(config));
 const delivery={},docs={},calls=[];let serial=0;
 const native=s=>s.replace(/\*\*/g,'').replace(/\[[^\]]*\]\([^\s)]+\)/g,'△');
 const parse=s=>native(s).trim().split(/\n\s*\n/).filter(Boolean).map(text=>({id:'b'+(++serial),type:/^#{1,6} /.test(text)?'header_'+text.match(/^#+/)[0].length:'text',property:{title:{text:text.replace(/^#{1,6} /,'')}},markdown:text}));
 const body=p=>p.blocks.map(b=>b.markdown).join('\n\n');
 const control={};
 const cli=a=>{
  const cmd=a.slice(0,a.indexOf('--json')).join(' '),d=JSON.parse(a.at(-1));calls.push({cmd,d});let r={errcode:0};
  if(cmd==='smartpage import'){const id='a1_fixture',p='p'+(++serial);docs[id]={title:d.name,pages:{[p]:{page_id:p,page_title:d.name,parent_id:'root',blocks:parse(fs.readFileSync(d.file_path,'utf8'))}}};r={task_status:'succ',url:'https://doc.weixin.qq.com/smartpage/'+id};}
  else if(cmd==='doc rules update'){}
  else if(cmd==='smartpage pages get'){
   const doc=docs[d.docid];r={...r,doc_title:doc.title,pages:Object.values(doc.pages).filter(p=>!d.page_id||d.page_id===p.page_id).map(({blocks,...p})=>({...p,...(d.page_id?{content_file_inner:JSON.stringify(d.content_type==='block'?blocks:body({blocks}))}:{})}))};
  }else if(cmd==='smartpage pages append')docs[d.docid].pages[d.page_id].blocks.push(...parse(fs.readFileSync(d.file_path,'utf8')));
  else if(cmd==='smartpage blocks update'){
   const p=docs[d.docid].pages[d.page_id];
   if(d.method==='delete'){const ids=new Set(d.block_ids);for(let n=0;n<p.blocks.length;n++)for(const b of p.blocks)if(ids.has(b.parent_id))ids.add(b.id);p.blocks=p.blocks.filter(b=>!ids.has(b.id));}
   else{const i=p.blocks.findIndex(b=>b.id===d.block_id);assert(i>=0,'real anchor required');if(d.method==='replace')p.blocks.splice(i,1,...parse(d.mdx));else if(d.method==='insertBefore')p.blocks.splice(i,0,...parse(d.mdx));else throw Error(d.method);}
  }else if(cmd==='smartpage pages update'){
   const doc=docs[d.docid];
   if(d.create_page){const id='p'+(++serial);doc.pages[id]={page_id:id,page_title:d.create_page.page_name,parent_id:d.create_page.parent_page_id,blocks:[]};r.page_id=id;}
   else if(d.rename_page)doc.pages[d.rename_page.page_id].page_title=d.rename_page.new_name;
   else if(d.move_page){const p=doc.pages[d.move_page.page_id];assert.equal(d.move_page.new_parent_page_id,p.parent_id);}
   else if(d.delete_page){assert(!Object.values(doc.pages).some(p=>p.parent_id===d.delete_page.page_id));delete doc.pages[d.delete_page.page_id];}
   else throw Error('unknown page update');
  }else throw Error(cmd);
  if(control.timeout===cmd||(control.timeoutBody&&cmd==='smartpage pages append'&&fs.readFileSync(d.file_path,'utf8').includes(control.timeoutBody))){control.timeoutBody=null;control.timeout=null;throw Error('timeout after mutation');}
  return JSON.stringify(r);
 };
 const run=(start,key,extra={})=>{const x={key,type:'note',note_id:key,title:'求租相机'+key,desc:'求租相机'+key,author:'测试',url:'https://www.xiaohongshu.com/explore/'+key,published_at_ms:Date.parse(start)};const scan={started_at:start,complete:true};const doc=buildDocument([x],scan,config,Date.parse(start));return publishDailyDocument(doc,{cli,delivery,save(){},base,join:'public',scan,...extra});};
 const workspace=start=>syncWorkspace({cli,delivery,save(){},base,scan:{started_at:start},join:'public'});
 const home=()=>{const day=Object.values(delivery.daily_documents)[0];return body(docs[day.docid].pages[day.overview_id]);};
 return {base,delivery,docs,calls,control,cli,run,workspace,home,body};
}
test('chronological full summary sorts late 00/04/08 rounds ahead of existing 12 without dropping original quotes',t=>{
 const f=fixture(t);for(const [time,key] of [['04:00','n12'],['16:00','n00'],['20:00','n04'],['00:00','n08']]){
  const date=time==='04:00'?'2026-10-08':time==='00:00'?'2026-10-08':'2026-10-07';f.run(date+'T'+time+':00Z',key);
 }
 const s=f.home();const labels=['00点巡检','04点巡检','08点巡检','12点巡检'];const positions=labels.map(x=>s.indexOf('## '+x));assert(positions.every((n,i)=>n>=0&&(!i||n>positions[i-1])));
 for(const k of ['n00','n04','n08','n12'])assert(s.includes('求租相机'+k));assert(s.includes('今日收录：4条'));assert(!s.includes('分类入口'));assert(f.calls.some(c=>c.d.method==='insertBefore'));
 assert(!f.calls.some(c=>c.cmd.includes('message')));
});
test('issues and pending candidates move into the matching round and summary, and old classified pages retire after archiving',t=>{
 const f=fixture(t),start='2026-10-08T02:04:00Z';f.run(start,'lead');const day=Object.values(f.delivery.daily_documents)[0],r=Object.values(day.rounds)[0];
 day.workspace={pages:{}};for(const name of ['相机','手机','镜头']){const z=JSON.parse(f.cli(['smartpage','pages','update','--json',JSON.stringify({docid:day.docid,create_page:{page_name:name,parent_page_id:day.overview_id}})]));day.workspace.pages[name]={page_id:z.page_id};}
 f.delivery.operational_notes={a:{id:'a',started_at:start,status:'archived',accepted:1,searches_completed:1,searches_planned:2,queries:[{keyword:'求租 R50',error:false}],warnings:['剩余搜索未执行'],review_pending:1,manual_candidates:[{key:'pending',type:'comment',note_id:'p',title:'原帖',url:'https://www.xiaohongshu.com/explore/p',comment:{author:'待核用户',text:'哪里租镜头',published_at_ms:Date.parse(start)}}]}};
 f.workspace(start);const cloud=f.docs[day.docid];assert.equal(Object.keys(cloud.pages).length,2);const round=f.body(cloud.pages[r.page_id]);assert(round.includes('求租 R50'));assert(round.includes('待核实候选'));assert(round.includes('哪里租镜头'));assert(f.home().includes('剩余搜索未执行'));assert.equal(f.delivery.operational_notes.a.timeline.summary_verified,true);assert(!f.delivery.runs);assert(!f.calls.some(c=>c.cmd.includes('message')));
 const before=f.calls.filter(c=>/update|append|import/.test(c.cmd)).length;f.workspace(start);assert.equal(f.calls.filter(c=>/update|append|import/.test(c.cmd)).length,before);
});
test('an unknown summary append is recovered by real readback and never repeated',t=>{
 const f=fixture(t),start='2026-10-08T00:00:00Z';f.control.timeout='smartpage pages append';assert.throws(()=>f.run(start,'n8'));f.run(start,'n8');const s=f.home();assert.equal((s.match(/## 08点巡检/g)||[]).length,1);assert.equal(Object.keys(f.docs.a1_fixture.pages).length,2);
});
test('manual rounds retain real time and same-slot extra rounds receive distinct names',t=>{
 const f=fixture(t);f.run('2026-10-08T02:04:00Z','n10');f.run('2026-10-08T04:00:00Z','n12');f.run('2026-10-08T04:10:00Z','n1210');
 const day=Object.values(f.delivery.daily_documents)[0];const names=Object.values(day.rounds).map(x=>x.title);assert.equal(new Set(names).size,3);assert(names.includes('10时04分巡检（手动）'));assert(names.includes('12点巡检'));assert(f.home().includes('12时10分00秒补充巡检'));assert.equal(label('2026-10-08T16:00:00Z'),'00点巡检');
});

test('unknown summary seed append recovers without deleting its counts or creating another round',t=>{
 const f=fixture(t),start='2026-10-08T00:00:00Z';f.control.timeoutBody='## 今日汇总';assert.throws(()=>f.run(start,'n8'));f.run(start,'n8');assert.equal((f.home().match(/## 今日汇总/g)||[]).length,1);assert(f.home().includes('今日收录：1条'));assert.equal(Object.keys(f.docs.a1_fixture.pages).length,2);
});

test('manual candidates precede peer comments and retired tracking indexes disappear without changing counts',t=>{
 const f=fixture(t),start='2026-10-08T02:04:00Z';f.run(start,'lead');const day=Object.values(f.delivery.daily_documents)[0],r=Object.values(day.rounds)[0];
 const append=(page,body)=>{const file=path.join(f.base,'extra.md');fs.writeFileSync(file,body);f.cli(['smartpage','pages','append','--json',JSON.stringify({docid:day.docid,page_id:page,content_type:'markdown',file_path:file})]);};
 append(r.page_id,'### 同行帖子评论\n\n同行原文保留\n\n## 分类与跟进索引\n\n原跟进说明\n\n| 序号 | 跟进状态 |\n| 1 | 未登记 |');
 append(day.overview_id,'### 同行帖子评论\n\n同行原文保留');
 f.docs[day.docid].pages[day.overview_id].blocks.unshift({id:'child-link',type:'page',property:{title:{text:r.timeline_title||r.title}},markdown:'页面入口'});
 f.delivery.operational_notes={a:{id:'a',started_at:start,status:'pending',accepted:1,review_pending:1,manual_candidates:[{key:'pending',type:'comment',note_id:'p',title:'原帖',url:'https://www.xiaohongshu.com/explore/p',comment:{author:'待核用户',text:'哪里租镜头',published_at_ms:Date.parse(start)}}]}};
 f.workspace(start);for(const body of [f.home(),f.body(f.docs[day.docid].pages[r.page_id])]){
  assert(body.indexOf('待核实候选（人工审查）')<body.indexOf('### 同行帖子评论'));assert.equal((body.match(/哪里租镜头/g)||[]).length,1);assert(!body.includes('分类与跟进索引'));assert(body.includes('同行原文保留'));
 }
 const before=f.calls.filter(c=>/update|append|import/.test(c.cmd)).length;f.workspace(start);assert.equal(f.calls.filter(c=>/update|append|import/.test(c.cmd)).length,before);assert.equal(r.keys.length,1);
});

test('native tracking table removes only root components and preserves following lead statistics',t=>{
 const f=fixture(t),start='2026-10-08T02:04:00Z';f.run(start,'lead');const day=Object.values(f.delivery.daily_documents)[0],r=Object.values(day.rounds)[0],page=f.docs[day.docid].pages[r.page_id];
 page.blocks.push({id:'tracking-head',parent_id:r.page_id,type:'header_2',property:{title:{text:'分类与跟进索引'}},markdown:'## 分类与跟进索引'},
 {id:'tracking-info',parent_id:r.page_id,type:'text',property:{title:{text:'跟进说明'}},markdown:'跟进说明'},
 {id:'native-table',parent_id:r.page_id,type:'unspecified',property:{},markdown:'表格组件'},
 {id:'native-cell',parent_id:'native-table',type:'unspecified',property:{},markdown:'表格单元格'},
 {id:'native-value',parent_id:'native-cell',type:'text',property:{title:{text:'未登记'}},markdown:'未登记'},
 {id:'ending',parent_id:r.page_id,type:'text',property:{title:{text:'本批文档整理完毕'}},markdown:'本批文档整理完毕'});
 f.workspace(start);const removed=f.calls.filter(x=>x.d.method==='delete'&&x.d.block_ids.includes('tracking-head'))[0].d.block_ids;
 assert.deepEqual(removed,['tracking-head','tracking-info','native-table']);assert(page.blocks.some(x=>x.id==='ending'));assert(!page.blocks.some(x=>x.id==='native-cell'));
});

test('a failed document refresh stays in maintenance history and cannot create a fake patrol or duplicate review candidates',t=>{
 const f=fixture(t),start='2026-10-08T02:04:00Z',maintenance='2026-10-08T03:54:02Z';f.run(start,'lead');
 publishDailyDocument(null,{cli:f.cli,delivery:f.delivery,save(){},base:f.base,join:'public',scan:{started_at:maintenance,complete:false}});
 f.delivery.operational_notes={m:{id:'m',started_at:maintenance,run_mode:'refresh-document',status:'pending',error:'文档整理定位失败',accepted:0,manual_candidates:[{key:'pending',type:'comment',url:'https://www.xiaohongshu.com/explore/p',comment:{text:'待核原话',author:'测试',published_at_ms:Date.parse(start)}}]}};
 f.workspace(maintenance);const day=Object.values(f.delivery.daily_documents)[0];assert.equal(Object.values(day.rounds).length,1);assert.equal(Object.values(day.maintenance_rounds).length,1);assert.equal(Object.keys(f.docs[day.docid].pages).length,2);assert(!f.home().includes('待核原话'));assert(f.home().includes('文档整理定位失败'));assert(f.home().includes('已归档1轮'));
});
