const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const daily=require('./daily-document-delivery.cjs');
const {fingerprint,row}=require('./concise-message.cjs');
const norm=s=>String(s).replace(/\\/g,'').replace(/\s/g,'');
const safe=s=>{if(/<(?:script|iframe|object|embed|svg)\b|\bon\w+\s*=|javascript:|data:text\/html|vbscript:/i.test(s))throw Error('文档内容安全检查未通过');};
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const label=start=>{const c=daily.clock(start),[h,m]=c.time.split(':').map(Number);return h%4===0&&m<30?String(h).padStart(2,'0')+'点巡检':c.time.slice(0,5).replace(':','时')+'分巡检（手动）';};
function titleForNew(day,start){
 const base=label(start);if(!Object.values(day.rounds||{}).some(r=>(r.timeline_title||r.title)===base))return base;
 const c=daily.clock(start),prefix=c.name+'补充巡检',matches=Object.values(day.rounds||{}).filter(r=>(r.timeline_title||r.title||'').startsWith(prefix)).length;
 return prefix+(matches?`（${matches+1}）`:'');
}
function roundLabel(day,r){return r.timeline_title||(r.timeline_title=titleForNew({...day,rounds:Object.fromEntries(Object.entries(day.rounds||{}).filter(([,x])=>x!==r))},r.started_at));}
function leadContent(doc){
 // Keep every accepted quote, source heading, count and link. Tracking is edited on the round page.
 return doc.content.replace(/^# .*\n/,'').replace(/## 分类与跟进索引\n[\s\S]*?(?=本批文档整理完毕)/,'').replace(/## 分类速览\n[\s\S]*?(?=### 求租线索)/,'').replace(/^### 求租线索[^\n]*\n/gm,'').replace(/^## /gm,'### ').trim();
}
function sourceDoc(base,key,r){
 if(!r.keys?.length)return null;
 const root=path.join(base,'smartpage')+path.sep,f=r.source_doc_file&&path.resolve(r.source_doc_file);
 if(!f||!f.startsWith(root))throw Error('轮次缺少受控原文快照');
 const d=JSON.parse(fs.readFileSync(f,'utf8'));
 if(d.id!==key||d.id!==fingerprint(d.content,d.keys)||d.keys.length!==r.keys.length||d.keys.some(k=>!r.keys.includes(k)))throw Error('轮次原文快照校验失败');
 return d;
}
function ordered(day){return Object.entries(day.rounds||{}).filter(([,r])=>r.status==='verified').sort((a,b)=>Date.parse(a[1].started_at)-Date.parse(b[1].started_at)||a[0].localeCompare(b[0]));}
function transport(cli,day,base){
 const call=(a,d)=>daily.response(cli,a,{docid:day.docid,...d});
 const tree=()=>call(['smartpage','pages','get'],{});
 const read=(page,type='markdown')=>{
  const p=call(['smartpage','pages','get'],{page_id:page,content_type:type}).pages?.[0];if(p?.page_id!==page)throw Error('文档页面读回不匹配');
  let v=p.content_file_inner??(p.file_path?fs.readFileSync(p.file_path,'utf8'):null);if(v===null)throw Error('文档正文未返回');
  if(type==='block'){while(typeof v==='string')v=JSON.parse(v);}else if(v.startsWith('"'))try{v=JSON.parse(v);}catch{}return v;
 };
 const append=(page,body)=>{safe(body);const dir=path.join(base,'smartpage');fs.mkdirSync(dir,{recursive:true,mode:0o700});const f=path.join(dir,'时间汇总-'+digest(body).slice(0,16)+'.md');fs.writeFileSync(f,body,{mode:0o600});return call(['smartpage','pages','append'],{page_id:page,content_type:'markdown',file_path:f});};
 const insert=(body,before)=>{safe(body);return before?call(['smartpage','blocks','update'],{page_id:day.overview_id,method:'insertBefore',block_id:before,mdx:body}):append(day.overview_id,body);};
 return {call,tree,read,append,insert};
}
function syncSummary({cli,delivery,save,base,day}){
 const t=transport(cli,day,base),structure=t.tree();
 if(![day.name,day.doc_title].includes(structure.doc_title)||!structure.pages.some(p=>p.page_id===day.overview_id))throw Error('今日文档结构发生变化');
 for(const r of Object.values(day.rounds||{}))if(!r.keys?.length&&Object.values(delivery.operational_notes||{}).some(op=>op.run_mode==='refresh-document'&&op.started_at===r.started_at)){r.status='maintenance';save();}
 day.timeline||={sections:{}};const timeline=day.timeline;
 const rounds=ordered(day);
 if(!timeline.initialized){
  const blocks=t.read(day.overview_id,'block');
  const seeded=blocks.some(b=>b.property?.title?.text==='今日汇总')&&blocks.some(b=>b.property?.title?.text?.startsWith('轮次导航：'));
  // The first migration retires only generated overview text; page blocks are never deleted here.
  const old=seeded?[]:blocks.filter((b,index)=>b.type!=='page'&&(b.property?.title?.text===day.name||b.property?.title?.text?.startsWith('今日收录：')||b.property?.title?.text?.startsWith('定时计划：')||b.property?.title?.text?.startsWith('每个标题链接下')||['轮次目录','分类入口'].includes(b.property?.title?.text)||(b.property?.title?.text==='△'&&rounds.some(([,r])=>blocks[index-1]?.property?.title?.text===`${r.title}轮次｜${r.description}。`))||(b.property?.title?.text==='△｜△｜△｜△｜△｜△｜△'&&blocks[index-1]?.property?.title?.text==='分类入口')||b.property?.title?.text?.startsWith('分类页面只提供轮次入口')||rounds.some(([,r])=>b.property?.title?.text===`${r.title}轮次｜${r.description}。`)));
  if(old.length){timeline.initializing=true;save();t.call(['smartpage','blocks','update'],{page_id:day.overview_id,method:'delete',block_ids:old.map(b=>b.id)});}
  let body=t.read(day.overview_id);
  if(!body.includes('## 今日汇总'))t.append(day.overview_id,`## 今日汇总\n\n${daily.summary(day)}\n\n定时计划：北京时间00点、04点、08点、12点、16点、20点。按实际巡检时间从早到晚汇集完整线索；手动巡检和补发保留真实时间。\n\n轮次导航：\n\n## 按时间查看完整内容\n`);
  const fresh=t.read(day.overview_id,'block');if(!fresh.some(b=>b.property?.title?.text==='今日汇总'))throw Error('今日汇总标题未完整读回');
  timeline.initialized=true;timeline.initializing=false;save();
 }
 for(const [key,r] of rounds){
  const s=timeline.sections[key]||={};if(s.verified_at)continue;
  const marker=roundLabel(day,r),doc=sourceDoc(base,key,r);
  const body=`## ${marker}\n\n实际开始：${daily.clock(r.started_at).time}。${r.description}。\n\n[打开本轮独立页面](${r.url})\n\n${doc?leadContent(doc):`本轮状态：${r.description}。`}\n\n`;
  let current=t.read(day.overview_id);const blocks=t.read(day.overview_id,'block');
  const matches=blocks.filter(b=>b.type==='header_2'&&b.property?.title?.text===marker);
  if(matches.length>1)throw Error('汇总轮次标题不唯一');
  if(!matches.length){
   if(s.writing)throw Error('汇总轮次追加结果不确定，未重复追加');
   const later=rounds.find(([k,x])=>Date.parse(x.started_at)>Date.parse(r.started_at)&&timeline.sections[k]?.verified_at);
   const anchor=later?blocks.find(b=>b.type==='header_2'&&b.property?.title?.text===roundLabel(day,later[1]))?.id:null;if(later&&!anchor)throw Error('汇总排序锚点缺失');
   s.writing=true;save();try{t.insert(body,anchor);}catch(e){if(e.definite){s.writing=false;save();}throw e;}
   current=t.read(day.overview_id);
  }
  const heading='## '+marker,index=current.indexOf(heading),next=current.indexOf('\n## ',index+heading.length);if(index<0)throw Error('汇总轮次未读回');
  const part=current.slice(index,next<0?undefined:next);
  if(doc)daily.verifyRound({...doc,content:leadContent(doc)},part);else if(!part.includes(r.description))throw Error('空轮次状态未完整读回');
  s.writing=false;s.verified_at=new Date().toISOString();s.marker=marker;save();
 }
 const blocks=t.read(day.overview_id,'block'),sum=blocks.filter(b=>b.property?.title?.text?.startsWith('今日收录：'));
 if(sum.length!==1)throw Error('今日汇总统计块不唯一');
 const desired=daily.summary(day);if(norm(sum[0].property.title.text)!==norm(desired))t.call(['smartpage','blocks','update'],{page_id:day.overview_id,method:'replace',block_id:sum[0].id,mdx:desired});
 const nav=blocks.filter(b=>b.property?.title?.text?.startsWith('轮次导航：'));if(nav.length!==1)throw Error('轮次导航不唯一');
 const directory='轮次导航：'+rounds.map(([,r])=>`[${roundLabel(day,r)}](${r.url})`).join('｜');
 const directoryHash=digest(directory);if(timeline.directory_hash!==directoryHash){t.call(['smartpage','blocks','update'],{page_id:day.overview_id,method:'replace',block_id:nav[0].id,mdx:directory});timeline.directory_hash=directoryHash;save();}
 const final=t.read(day.overview_id);if(!norm(final).includes(norm(desired)))throw Error('今日汇总统计不符');
 let position=-1;for(const [,r] of rounds){const n=final.indexOf('## '+roundLabel(day,r));if(n<=position)throw Error('汇总未按时间升序排列');position=n;}
 timeline.verified_at=new Date().toISOString();save();return {status:'verified',overview_url:day.overview_url,rounds:rounds.length};
}
function opContent(op,scan={},config={}){
 const lines=['## 本轮搜索记录与运行情况',`本轮已确认推送${op.accepted||0}条线索。`];
 const confirmed=op.accepted&&Number.isFinite(Date.parse(op.delivery_confirmed_at))?daily.clock(op.delivery_confirmed_at):null;
 lines.push(confirmed?`实际推送时间（群回执确认）：${confirmed.day} ${confirmed.time}（北京时间）。`:'实际推送时间：尚无已确认群回执。');
 const unexecuted=Array.isArray(op.searches_unexecuted)?op.searches_unexecuted.length:op.searches_unexecuted;
 if(unexecuted)lines.push(`计划搜索未执行${unexecuted}项。`);
 if(op.unread_candidates_pending!==undefined)lines.push(`未读候选${op.unread_candidates_pending}帖，不计入有效线索。`);
 const searches=op.queries||scan.searches||[];
 if(searches.length)lines.push('### 搜索记录\n\n'+searches.map(s=>`- ${String(s.keyword||'未记录关键词').replaceAll('<','&lt;').replaceAll('>','&gt;')}：${s.error?'未成功完成':'已执行'}。`).join('\n'));
 else if(op.run_mode==='deliver-pending-only'||scan.maintenance)lines.push('本轮补发已有合格线索，没有重新执行搜索。');
 if(op.searches_planned)lines.push(`搜索完成${op.searches_completed}/${op.searches_planned}项。`);
 if(op.detail_failures)lines.push(`有${op.detail_failures}个帖子未成功读取。`);
 if(op.error)lines.push('本轮执行中断：'+String(op.error).replaceAll('<','&lt;').replaceAll('>','&gt;'));
 if(op.warnings?.length)lines.push('### 未完成项目\n\n'+op.warnings.map(w=>'- '+String(w).replaceAll('MCP请求超时','读取超时').replaceAll('<','&lt;').replaceAll('>','&gt;')).join('\n'));
 if(op.schedule_missing?.length)lines.push('以下计划时段没有运行记录：'+op.schedule_missing.map(x=>{const c=daily.clock(x);return c.day+' '+c.time.slice(0,5);}).join('、')+'。');
 if(op.run_mode!=='refresh-document'&&(op.review_pending||op.manual_candidates?.length))lines.push(`### 待核实候选\n\n本轮有${op.review_pending||op.manual_candidates.length}条候选待核实，不计入有效线索数量。\n\n`+(op.manual_candidates||[]).map((x,i)=>{
  const u=new URL(x.url);if(u.protocol!=='https:'||u.hostname!=='www.xiaohongshu.com')throw Error('候选来源链接异常');
  return `**待核${i+1}. [查看原帖](${u.href})**\n\n${row(x,{},config,Date.parse(op.started_at))}\n`;
 }).join('\n'));
 return lines.join('\n\n')+'\n';
}
function promoteReview({t,day,r,op,page,summary,save}){
 if(op.run_mode==='refresh-document'||(!op.review_pending&&!op.manual_candidates?.length))return;
 const state=op.timeline[summary?'review_summary':'review_round']||={};if(state.verified_at)return;
 const marker=`人工审查记录时间：${daily.clock(op.started_at).time}`,runtime=`运行记录时间：${daily.clock(op.started_at).time}`;
 const scope=()=>{const blocks=t.read(page,'block');let start=0,end=blocks.length;
  if(summary){start=blocks.findIndex(b=>b.type==='header_2'&&b.property?.title?.text===roundLabel(day,r));if(start<0)throw Error('人工审查所属轮次缺失');const next=blocks.findIndex((b,i)=>i>start&&b.type==='header_2');if(next>=0)end=next;}
  return {part:blocks.slice(start,end)};
 };
 let current=t.read(page),view=scope();
 if(!view.part.some(b=>b.property?.title?.text===marker)){
  if(state.writing)throw Error('人工审查前移结果待核实，未重复插入');
  const header=summary?'#### 待核实候选':'### 待核实候选';let from=current.indexOf(header);
  if(summary)from=current.indexOf(header,current.indexOf('## '+roundLabel(day,r)));
  const finish=current.indexOf(runtime,from);if(from<0||finish<0)throw Error('待核候选正文边界不明');
  let body=current.slice(from,finish).replace(/^#{3,4} 待核实候选/,'### 待核实候选（人工审查）').trim();
  // Preserve the live candidate text, including human edits; restore source links serialized as △.
  for(const [i,x] of (op.manual_candidates||[]).entries()){
   const u=new URL(x.url);if(u.protocol!=='https:'||u.hostname!=='www.xiaohongshu.com')throw Error('候选来源链接异常');
   body=body.replace(new RegExp('(待核'+(i+1)+'\\. )△','g'),'$1[查看原帖]('+u.href+')');
  }
  body+='\n\n'+marker+'\n';safe(body);
  const peer=view.part.find(b=>b.type?.startsWith('header')&&/^(?:补充线索｜|主要线索｜)?同行帖子评论$/.test(b.property?.title?.text||''));
  const target=peer||view.part.find(b=>b.property?.title?.text==='分类与跟进索引')||view.part.find(b=>b.property?.title?.text==='本轮搜索记录与运行情况');
  if(!target)throw Error('人工审查优先位置缺少锚点');state.writing=true;save();
  try{t.call(['smartpage','blocks','update'],{page_id:page,method:'insertBefore',block_id:target.id,mdx:body});}catch(e){if(e.definite){state.writing=false;save();}throw e;}
  if(!t.read(page).includes(marker))throw Error('人工审查前移正文未读回');view=scope();
 }
 const stop=view.part.findIndex(b=>b.property?.title?.text===runtime);let old=-1;for(let i=stop-1;i>=0;i--){if(view.part[i].type?.startsWith('header')){if(view.part[i].property?.title?.text==='待核实候选')old=i;break;}}
 if(old>=0){const end=view.part.findIndex((b,i)=>i>old&&b.property?.title?.text===runtime);if(end<0)throw Error('原待核段落边界不明');const range=view.part.slice(old,end);
  if(range.some(b=>b.type==='page'||b.type==='table'))throw Error('原待核候选存在非文本组件');state.deleting=true;save();
  try{t.call(['smartpage','blocks','update'],{page_id:page,method:'delete',block_ids:range.filter(b=>!b.parent_id||b.parent_id===page).map(b=>b.id)});}catch(e){if(e.definite){state.deleting=false;save();}throw e;}
 }
 view=scope();const manual=view.part.findIndex(b=>b.property?.title?.text==='待核实候选（人工审查）'),peer=view.part.findIndex(b=>b.type?.startsWith('header')&&/^(?:补充线索｜|主要线索｜)?同行帖子评论$/.test(b.property?.title?.text||''));
 if(manual<0||(peer>=0&&manual>=peer)||!view.part.some(b=>b.property?.title?.text===marker))throw Error('人工审查优先顺序未确认');
 state.writing=false;state.deleting=false;state.verified_at=new Date().toISOString();save();
}
function removeFollowup(t,r,save){
 if(r.followup_removed)return;
 const blocks=t.read(r.page_id,'block'),start=blocks.findIndex(b=>b.property?.title?.text==='分类与跟进索引');
 if(start<0){r.followup_removed=true;save();return;}
 let end=start+1;while(end<blocks.length&&!blocks[end].type?.startsWith('header')){
  const b=blocks[end],txt=b.property?.title?.text||'';
  if(b.type==='page'||txt.startsWith('本批文档整理完毕')||txt==='△'||txt.startsWith('本轮已确认推送'))break;
  end++;if(b.type==='table')break;
 }
 const ids=blocks.slice(start,end).filter(b=>!b.parent_id||b.parent_id===r.page_id).map(b=>b.id);r.followup_removing=true;save();
 try{t.call(['smartpage','blocks','update'],{page_id:r.page_id,method:'delete',block_ids:ids});}catch(e){if(e.definite){r.followup_removing=false;save();}throw e;}
 if(t.read(r.page_id,'block').some(b=>b.property?.title?.text==='分类与跟进索引'))throw Error('跟进索引移除未确认');
 r.followup_removing=false;r.followup_removed=true;save();
}
function scanFor(base,op){
 const history=path.join(base,'run-history.jsonl');
 const runs=fs.existsSync(history)?fs.readFileSync(history,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
 const r=runs.find(x=>x.started_at===op.started_at);const f=op.scan_path||r?.scan_path;
 if(!f||!path.resolve(f).startsWith(path.resolve(base)+path.sep)||!fs.existsSync(f))return {};
 return JSON.parse(fs.readFileSync(f,'utf8'));
}
function syncOneDay({cli,delivery,save,base,scan,join='public',allowFollowupEditing=false}){
 const stamp=daily.clock(scan.started_at),config=JSON.parse(fs.readFileSync(path.join(base,'monitor-config.json'),'utf8'));
 if(!delivery.daily_documents?.[stamp.day])daily.publishDailyDocument(null,{cli,delivery,save,base,scan:{...scan,complete:false},join});
 const day=delivery.daily_documents[stamp.day];const t=transport(cli,day,base);day.timeline||={sections:{}};
 if(allowFollowupEditing&&!day.workspace?.followup_editor_granted){
  const identity=JSON.parse(cli(['identity','whoami'])),user=String(identity.extra_identity_context||'').match(/授权真人用户身份：[\s\S]*?\nID：([^\s]+)/)?.[1];
  if(!user||!/^[A-Za-z0-9_-]+$/.test(user))throw Error('授权真人身份未确认');
  t.call(['doc','members','update'],{add_member_list:{items:[{userid:user,user_type:'user',user_auth:'edit'}]}});day.workspace||={pages:{}};day.workspace.followup_editor_granted=true;save();
 }
 // Attach issues to the round that actually produced them, including prior archived issue pages.
 for(const op of Object.values(delivery.operational_notes||{}).filter(x=>daily.clock(x.started_at).day===stamp.day)){
  const evidence=scanFor(base,op);const start=op.round_started_at||evidence.started_at||op.started_at;
  let match=(op.run_mode==='refresh-document'?ordered(day).filter(([,r])=>r.keys?.length).at(-1):null)||ordered(day).find(([,r])=>r.started_at===start)||ordered(day).find(([,r])=>Math.abs(Date.parse(r.started_at)-Date.parse(op.started_at))<120000);
  if(!match){daily.publishDailyDocument(null,{cli,delivery,save,base,scan:{started_at:start,complete:false},join,awaiting:op.review_pending||0});match=ordered(day).find(([,r])=>r.started_at===start);}
  const [key,r]=match;op.timeline||={};const marker=`运行记录时间：${daily.clock(op.started_at).time}`;
  const body='\n'+opContent(op,evidence,config)+'\n'+marker+'\n';
  if(!op.timeline.round_verified){const current=t.read(r.page_id);if(!current.includes(marker)){
   if(op.timeline.round_writing)throw Error('本轮运行记录追加结果待核实');op.timeline.round_writing=true;save();try{t.append(r.page_id,body);}catch(e){if(e.definite){op.timeline.round_writing=false;save();}throw e;}
  }if(!t.read(r.page_id).includes(marker))throw Error('本轮运行记录未读回');op.timeline.round_writing=false;op.timeline.round_verified=true;op.timeline.round_key=key;save();}
 }
 syncSummary({cli,delivery,save,base,day});
 for(const op of Object.values(delivery.operational_notes||{}).filter(x=>daily.clock(x.started_at).day===stamp.day)){
  const r=day.rounds[op.timeline.round_key],marker=`运行记录时间：${daily.clock(op.started_at).time}`;if(op.timeline.summary_verified)continue;
  const current=t.read(day.overview_id),heading='## '+roundLabel(day,r),index=current.indexOf(heading),next=current.indexOf('\n## ',index+heading.length);
  // Each round uses level 2, while source headings and issue headings become level 3 or lower.
  const part=current.slice(index,next<0?undefined:next);
  if(!part.includes(marker)){
   if(op.timeline.summary_writing)throw Error('汇总运行记录追加结果待核实');
   const rounds=ordered(day),position=rounds.findIndex(([k])=>k===op.timeline.round_key),later=rounds[position+1];
   const blocks=t.read(day.overview_id,'block'),origin=blocks.findIndex(b=>b.type==='header_2'&&b.property?.title?.text===roundLabel(day,r)),anchor=blocks.find((b,i)=>i>origin&&b.type==='header_2')?.id||null;if(origin<0)throw Error('汇总运行记录排序锚点缺失');
   const body='\n'+opContent(op,scanFor(base,op),config).replace(/^## /gm,'### ').replace(/^### (搜索记录|未完成项目|待核实候选)/gm,'#### $1')+'\n'+marker+'\n';
   op.timeline.summary_writing=true;save();try{t.insert(body,anchor);}catch(e){if(e.definite){op.timeline.summary_writing=false;save();}throw e;}
  }
  if(!t.read(day.overview_id).includes(marker))throw Error('汇总运行记录未读回');
  op.timeline.summary_writing=false;op.timeline.summary_verified=true;op.status='archived';op.document_url=r.url;op.archived_at=new Date().toISOString();save();
 }
 // Rename and order actual round pages, then retire only the pages created by the former workspace.
 let tree=t.tree();const rounds=ordered(day);
 for(const [i,[key,r]] of rounds.entries()){
  const actual=tree.pages.find(p=>p.page_id===r.page_id);if(!actual||actual.parent_id!==day.overview_id)throw Error('轮次页面层级已改变');
  const title=roundLabel(day,r);if(actual.page_title!==title){t.call(['smartpage','pages','update'],{rename_page:{page_id:r.page_id,new_name:title}});r.original_title||=r.title;r.title=title;save();}
  if(r.timeline_position!==i){t.call(['smartpage','pages','update'],{move_page:{page_id:r.page_id,new_parent_page_id:day.overview_id,index:i}});r.timeline_position=i;save();}
 }
 tree=t.tree();
 for(const [name,p] of Object.entries(day.workspace?.pages||{})){
  const actual=tree.pages.find(x=>x.page_id===p.page_id);if(!actual){p.retired=true;save();continue;}
  if(actual.parent_id!==day.overview_id||actual.page_title!==name||tree.pages.some(x=>x.parent_id===p.page_id))throw Error('旧分类页面结构变化，未删除');
  if(p.retiring)throw Error('旧分类页面删除结果待核实');
  const before=t.read(p.page_id);const folder=path.join(base,'smartpage');fs.writeFileSync(path.join(folder,'旧分页-'+stamp.day+'-'+name+'.md'),before,{mode:0o600});
  p.retiring=true;save();try{t.call(['smartpage','pages','update'],{delete_page:{page_id:p.page_id}});}catch(e){if(e.definite){p.retiring=false;save();}throw e;}
  tree=t.tree();if(tree.pages.some(x=>x.page_id===p.page_id))throw Error('旧分类页面删除未确认');p.retiring=false;p.retired=true;save();
 }
 for(const op of Object.values(delivery.operational_notes||{}).filter(x=>daily.clock(x.started_at).day===stamp.day)){
  const r=day.rounds[op.timeline?.round_key];if(!r)continue;
  promoteReview({t,day,r,op,page:r.page_id,summary:false,save});
  promoteReview({t,day,r,op,page:day.overview_id,summary:true,save});
 }
 for(const op of Object.values(delivery.operational_notes||{}).filter(x=>x.run_mode==='refresh-document'&&daily.clock(x.started_at).day===stamp.day)){
  const r=day.rounds[op.timeline?.round_key];if(!r)continue;
  for(const page of [r.page_id,day.overview_id]){
   const blocks=t.read(page,'block'),stop=blocks.findIndex(b=>b.property?.title?.text===`运行记录时间：${daily.clock(op.started_at).time}`);
   let start=-1;for(let i=stop-1;i>=0;i--)if(blocks[i].type?.startsWith('header')){if(blocks[i].property?.title?.text==='待核实候选')start=i;break;}
   if(start>=0)t.call(['smartpage','blocks','update'],{page_id:page,method:'delete',block_ids:blocks.slice(start,stop).filter(b=>!b.parent_id||b.parent_id===page).map(b=>b.id)});
  }
 }
 for(const [,r] of ordered(day))removeFollowup(t,r,save);
 // An internal document refresh is not a rental patrol. Preserve its local evidence and retire any empty page made by old recovery code.
 for(const [key,r] of Object.entries(day.rounds||{}).filter(([,r])=>!r.keys?.length&&Object.values(delivery.operational_notes||{}).some(op=>op.run_mode==='refresh-document'&&op.started_at===r.started_at))){
  let actual=t.tree();if(actual.pages.some(p=>p.parent_id===r.page_id))throw Error('维护空页存在子页面，未移除');
  const blocks=t.read(day.overview_id,'block'),start=blocks.findIndex(b=>b.type==='header_2'&&b.property?.title?.text===roundLabel(day,r));
  if(start>=0){let end=blocks.findIndex((b,i)=>i>start&&b.type==='header_2');if(end<0)end=blocks.length;
   t.call(['smartpage','blocks','update'],{page_id:day.overview_id,method:'delete',block_ids:blocks.slice(start,end).filter(b=>!b.parent_id||b.parent_id===day.overview_id).map(b=>b.id)});
  }
  if(actual.pages.some(p=>p.page_id===r.page_id)){t.read(r.page_id);t.call(['smartpage','pages','update'],{delete_page:{page_id:r.page_id}});}
  if(t.tree().pages.some(p=>p.page_id===r.page_id))throw Error('维护空页移除未确认');
  day.maintenance_rounds||={};day.maintenance_rounds[key]={...r,retired_at:new Date().toISOString()};delete day.rounds[key];delete day.timeline.sections[key];save();
 }
 syncSummary({cli,delivery,save,base,day});
 day.timeline.verified_at=new Date().toISOString();save();return {status:'verified',structure:'chronological' ,overview_url:day.overview_url,rounds:rounds.length};
}
function syncWorkspace(args){
 const today=daily.clock(args.scan.started_at).day;
 const dates=[...new Set(Object.values(args.delivery.operational_notes||{}).filter(op=>!op.timeline?.summary_verified&&daily.clock(op.started_at).day!==today).map(op=>daily.clock(op.started_at).day))].sort();
 for(const date of dates){const op=Object.values(args.delivery.operational_notes).find(op=>daily.clock(op.started_at).day===date);syncOneDay({...args,scan:{started_at:op.started_at,complete:false}});}
 return syncOneDay(args);
}
module.exports={label,titleForNew,leadContent,ordered,opContent,syncSummary,syncWorkspace};
