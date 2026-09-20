// Daily smartpage transport. The caller holds the patrol lock and owns sent-key updates.
const fs=require('node:fs'),path=require('node:path');
const {fingerprint}=require('./concise-message.cjs');
const {verifyDocument}=require('./document-delivery.cjs');
const SUMMARY_PREFIX='今日收录：';
const norm=s=>String(s).replace(/\\/g,'').replace(/\s/g,'');
function clock(started){
 const date=new Date(started);if(!Number.isFinite(date.getTime()))throw Error('缺少真实轮次开始时间');
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
 return {day:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}:${parts.second}`,name:`${parts.hour}时${parts.minute}分${parts.second}秒`,short:`${Number(parts.month)}/${Number(parts.day)} ${parts.hour}:${parts.minute}`};
}
function safe(content){if(/<(?:script|iframe|object|embed|svg)\b|\bon\w+\s*=|javascript:|data:text\/html|vbscript:/i.test(content))throw Error('文档内容安全检查未通过');}
function decode(s){if(typeof s!=='string')return s;if(s.startsWith('"'))try{return JSON.parse(s);}catch{}return s;}
function smartpageId(url){
 const u=new URL(url),match=u.pathname.match(/^\/smartpage\/(a1_[A-Za-z0-9_-]+)$/);
 if(u.protocol!=='https:'||u.hostname!=='doc.weixin.qq.com'||!match)throw Error('每日文档链接异常');
 return match[1];
}
function response(cli,args,data){
 let r,error;
 try{r=JSON.parse(cli([...args,'--json',JSON.stringify(data)]));}
 catch(e){error=e;try{r=JSON.parse(String(e.stdout));}catch{}}
 const code=r?.error?.code??r?.errcode;
 if(r?.error||(Number.isInteger(code)&&code!==0)||r?.status==='failed'||r?.task_status==='fail'){
  throw Object.assign(Error('企业微信文档接口拒绝请求（错误码 '+(Number.isInteger(code)?code:'未知')+'）'),{definite:true});
 }
 if(error||!r)throw Error('企业微信文档接口结果不确定，已停止自动重复写入');
 return r;
}
function pageLink(url,id){const u=new URL(url);if(u.hostname!=='doc.weixin.qq.com'||!u.pathname.startsWith('/smartpage/a1_'))throw Error('文档链接不符合预期');u.searchParams.set('p',id);return u.href;}
function verifyRound(doc,body){
 // Native inline links serialize as △. Preserve the accepted Markdown input;
 // validate record multiplicity and heading order separately from client clicks.
 verifyDocument({...doc,links:[]},body);
 const expected=[...doc.content.matchAll(/^\*\*(\d+)\. \[.*\]\(https:\/\/www\.xiaohongshu\.com\/[^\s)]+\)\*\*$/gm)];
 for(const [i,m] of expected.entries()){
  const heading=new RegExp('^\\s*(?:\\*\\*)?'+m[1]+'\\. (?:△|\\[)', 'gm');
  if((body.match(heading)||[]).length!==1)throw Error('文档标题分组遗漏或重复');
  if(i+1!==Number(m[1]))throw Error('文档标题顺序错误');
 }
 if(expected.length!==doc.links.length)throw Error('文档标题链接数量不符');
 if(/<linkcard\b/i.test(body))throw Error('原标题链接被转换为卡片');
 return true;
}
function counts(doc){
 const stats=doc?.statistics||[];
 return {records:doc?.keys.length||0,notes:stats.reduce((n,s)=>n+s.notes,0),comments:stats.reduce((n,s)=>n+s.comments,0),changes:stats.reduce((n,s)=>n+s.updates+s.corrections,0),posts:doc?.links.length||0};
}
function shortCount(c){return `新增${c.notes+c.comments}条需求／${c.posts}个帖子${c.changes?`，另有${c.changes}条状态更新或更正`:''}`;}
function summary(day){
 const rounds=Object.values(day.rounds).filter(r=>r.status==='verified');
 const n=rounds.reduce((a,r)=>({notes:a.notes+r.counts.notes,comments:a.comments+r.counts.comments,changes:a.changes+r.counts.changes}),{notes:0,comments:0,changes:0});
 const urls=new Set(rounds.flatMap(r=>r.note_paths||[]));
 return `${SUMMARY_PREFIX}${n.notes+n.comments}条求租需求，来自${urls.size}个原帖；帖子需求${n.notes}条、评论需求${n.comments}条${n.changes?`，另有${n.changes}条状态更新或更正`:''}。已归档${rounds.length}轮。仅统计本日文档已完整保存的记录，不等于独立客户人数，也不表示所有查询或群消息均成功。`;
}
function resumeDailyDocuments(pending,delivery,base){
 const keys=new Set(pending.map(x=>x.key)),reserved=new Set(),documents=[];
 for(const day of Object.values(delivery.daily_documents||{}))for(const r of Object.values(day.rounds||{})){
  if(!(r.keys||[]).some(k=>keys.has(k)))continue;
  if(r.status!=='verified')continue;
  if(!r.keys.every(k=>keys.has(k)))throw Error('既有轮次只有部分记录仍可发送，停止整页重发以免发送过期内容');
  if(r.keys.some(k=>reserved.has(k)))throw Error('既有轮次包含重复线索编号');
  const root=path.join(base,'smartpage')+path.sep,p=r.source_doc_file&&path.resolve(r.source_doc_file);
  if(!p||!p.startsWith(root))throw Error('既有轮次缺少受控原文快照，未重新建页');
  const doc=JSON.parse(fs.readFileSync(p,'utf8'));
  if(doc.id!==fingerprint(doc.content,doc.keys)||doc.keys.length!==r.keys.length||doc.keys.some(k=>!r.keys.includes(k)))throw Error('既有轮次原文快照校验失败');
  documents.push({doc,scan:{started_at:r.started_at,complete:!r.description.includes('未完成')}});r.keys.forEach(k=>reserved.add(k));
 }
 return {documents,fresh:pending.filter(x=>!reserved.has(x.key))};
}
function publishDailyDocument(doc,{cli,delivery,save,base,join='apply',scan,awaiting=0,blocked=0}){
 const stamp=clock(scan.started_at),runKey=doc?.id||fingerprint('daily-empty:'+scan.started_at,[]);
 delivery.daily_documents||={};delivery.documents||={};
 // A new scan must not copy keys from an existing daily page into another page,
 // even when its group notification has not yet been accepted.
 if(doc)for(const priorDay of Object.values(delivery.daily_documents))for(const [id,r] of Object.entries(priorDay.rounds||{})){
  if(id!==doc.id&&(r.keys||[]).some(k=>doc.keys.includes(k)))throw Error('已有轮次收录相同待发记录，需沿原轮次回执恢复，未重复建页');
 }
 if(doc)for(const [id,prior] of Object.entries(delivery.documents)){
  if(id!==doc.id&&['creating','writing','written'].includes(prior.status)&&(prior.keys||[]).some(k=>doc.keys.includes(k)))throw Error('此前文档结果待核实，未重复建页或发送');
 }
 const call=(args,data)=>response(cli,args,data),folder=path.join(base,'smartpage');fs.mkdirSync(folder,{recursive:true,mode:0o700});
 const file=(name,content)=>{safe(content);const p=path.join(folder,name+'.md');fs.writeFileSync(p,content,{mode:0o600});return p;};
 let day=delivery.daily_documents[stamp.day];
 if(!day||day.status==='create_failed'){
  const name=`小红书求租线索（${stamp.day}）`;
  day=delivery.daily_documents[stamp.day]={name,status:'creating',rounds:{},created_at:new Date().toISOString()};save();
  const seed=`# ${name}\n\n${summary(day)}\n\n定时计划：北京时间00:00、04:00、08:00、12:00、16:00、20:00。下方仅展示实际归档轮次，手动补跑按实际开始时间单独留档。未出现的轮次不代表没有新线索。\n\n每个标题链接下标明求租信号数量、原话和评论位置。每轮只收录未推送记录；群内只发送本轮和今日总览链接。\n\n## 轮次目录\n`;
  let r;try{r=call(['smartpage','import'],{name,file_path:file('今日总览-'+stamp.day,seed)});}catch(e){if(e.definite){day.status='create_failed';save();}throw e;}
  if(r.task_status!=='succ'||!r.url)throw Error('每日文档创建未确认完成，停止重复创建');
  // Import may return an internal id different from the editable a1_ pad id.
  // The validated editable URL is canonical for all smartpage page calls.
  Object.assign(day,{docid:smartpageId(r.url),url:r.url,status:'created'});save();
 }else if(!day.docid)throw Error('每日文档此前创建结果不确定，停止重复创建');
 const tree=()=>call(['smartpage','pages','get'],{docid:day.docid});
 let structure=tree();
 // Smartpage import historically used the first H1 as doc_title even when the
 // import request supplied a different name. Accept only that exact legacy
 // title for a pre-fix document, then remember the observed title.
 const legacyTitle=`${stamp.day}｜今日总览`;
 if(![day.name,legacyTitle].includes(structure.doc_title))throw Error('每日文档标题发生变化，未写入');
 if(day.doc_title!==structure.doc_title){day.doc_title=structure.doc_title;save();}
 if(!day.overview_id){if(structure.pages?.length!==1)throw Error('新文档首页不唯一');day.overview_id=structure.pages[0].page_id;day.overview_url=pageLink(day.url,day.overview_id);save();}
 if(!structure.pages.some(p=>p.page_id===day.overview_id))throw Error('每日总览页面不存在');
 const read=(page,type='markdown')=>{
  const p=call(['smartpage','pages','get'],{docid:day.docid,page_id:page,content_type:type}).pages?.[0];
  if(p?.page_id!==page)throw Error('文档读回页面不匹配');
  let content=p.content_file_inner??(p.file_path?fs.readFileSync(p.file_path,'utf8'):null);if(content===null)throw Error('文档正文未返回');
  content=decode(content);if(type==='block')while(typeof content==='string')content=JSON.parse(content);return content;
 };
 if(!day.rules_set){call(['doc','rules','update'],{docid:day.docid,enable_member_join_admin_check:false,corp_internal_join_auth:['read','public'].includes(join)?'read':'apply',corp_external_join_auth:join==='public'?'read':'deny'});day.rules_set=true;day.join=join;save();}
 let round=day.rounds[runKey];
 const incomplete=scan.complete===false||Boolean(scan.warnings?.length)||Boolean(scan.searches?.some(s=>s.error))||awaiting>0||blocked>0;
 const status=doc?shortCount(counts(doc)):(incomplete?'本轮未完成查询或仍有待处理内容，暂无可推送新增':'本轮查询已结束，暂无可推送新增');
 if(!round){
  const ordinal=Object.values(day.rounds).filter(r=>r.time===stamp.time).length+1;
  round=day.rounds[runKey]={status:'planned',time:stamp.time,title:stamp.name+(ordinal>1?`（补充${ordinal}）`:''),keys:doc?.keys||[],counts:counts(doc),note_paths:(doc?.links||[]).map(u=>new URL(u).pathname),description:status+(doc&&incomplete?'；本轮另有未完成项':''),started_at:scan.started_at};save();
 }
 if(doc&&!round.source_doc_file){
  const p=path.join(folder,'轮次原文-'+doc.id+'.json');fs.writeFileSync(p,JSON.stringify(doc),{mode:0o600});round.source_doc_file=p;save();
 }
 // Preserve the original document-level uncertainty barrier for pending lead keys.
 if(doc&&!delivery.documents[doc.id]){delivery.documents[doc.id]={status:'creating',keys:doc.keys,daily_date:stamp.day,at:new Date().toISOString()};save();}
 structure=tree();
 if(!round.page_id){
  const matches=structure.pages.filter(p=>p.page_title===round.title&&p.parent_id===day.overview_id);
  if(matches.length>1)throw Error('轮次页面不唯一，未重复创建');
  if(matches.length===1&&round.creating){round.page_id=matches[0].page_id;round.url=pageLink(day.url,round.page_id);save();}
  else {
   if(round.creating)throw Error('轮次页面创建结果不确定，停止重复创建');
   if(matches.length)throw Error('已有同名页面，未接管或覆盖');
   round.creating=true;save();
   let r;try{r=call(['smartpage','pages','update'],{docid:day.docid,create_page:{page_name:round.title,parent_page_id:day.overview_id}});}catch(e){if(e.definite){round.creating=false;save();}throw e;}
   structure=tree();const p=structure.pages.find(p=>p.page_id===r.page_id);
   if(!p||p.parent_id!==day.overview_id||p.page_title!==round.title)throw Error('轮次页面层级未确认');
   round.page_id=p.page_id;round.url=r.page_url||pageLink(day.url,p.page_id);save();
  }
 }
 if(!structure.pages.some(p=>p.page_id===round.page_id&&p.parent_id===day.overview_id))throw Error('轮次页面被移动或删除，未写入');
 const emptyText=`本轮状态：${round.description}。`;
 const content=doc?`${doc.content}\n\n[返回今日总览](${day.overview_url})\n`:`# ${stamp.day} ${stamp.time}\n\n${emptyText}\n\n[返回今日总览](${day.overview_url})\n`;
 const check=body=>{if(doc)return verifyRound(doc,body);if(!body.includes(emptyText))throw Error('空轮次状态未完整保存');return true;};
 let current=read(round.page_id);
 if(round.writing){check(current);}
 else {
  if(current.trim())throw Error('轮次页面已有内容，未重复追加');
  round.writing=true;if(doc)delivery.documents[doc.id].status='writing';save();
  try{call(['smartpage','pages','append'],{docid:day.docid,page_id:round.page_id,content_type:'markdown',file_path:file(`轮次-${stamp.day}-${runKey.slice(0,12)}`,content)});}catch(e){if(e.definite){round.writing=false;if(doc)delivery.documents[doc.id].status='created';save();}throw e;}
  current=read(round.page_id);check(current);
 }
 round.status='verified';round.verified_at=new Date().toISOString();round.inline_link_verification='accepted-native-markdown-template; client clicks not re-tested';
 if(doc)Object.assign(delivery.documents[doc.id],{status:'verified',docid:day.docid,url:round.url,verified_at:round.verified_at,count:doc.keys.length});save();
 const entry=`${round.title}轮次｜${round.description}。`;
 let overview=read(day.overview_id);
 if(!overview.includes(entry)){
  if(round.index_writing)throw Error('总览目录追加结果不确定，停止重复追加');
  round.index_writing=true;save();
  try{call(['smartpage','pages','append'],{docid:day.docid,page_id:day.overview_id,content_type:'markdown',file_path:file(`轮次目录-${runKey.slice(0,12)}`,`${entry}\n\n[查看${stamp.time}本轮内容](${round.url})\n`)});}catch(e){if(e.definite){round.index_writing=false;save();}throw e;}
  overview=read(day.overview_id);if(!overview.includes(entry))throw Error('总览目录未完整读回');
 }
 round.index_verified=true;save();
 const desired=summary(day),blocks=read(day.overview_id,'block');
 const matches=blocks.filter(b=>b.property?.title?.text?.startsWith(SUMMARY_PREFIX));
 if(matches.length!==1)throw Error('总览统计块不唯一，未覆盖其他内容');
 if(norm(matches[0].property.title.text)!==norm(desired))call(['smartpage','blocks','update'],{docid:day.docid,page_id:day.overview_id,method:'replace',block_id:matches[0].id,mdx:desired});
 overview=read(day.overview_id);if(!norm(overview).includes(norm(desired)))throw Error('总览统计读回不符');
 day.status='verified';day.updated_at=new Date().toISOString();save();
 if(!doc)return {quiet:true,document_url:round.url,overview_url:day.overview_url,document_verified:true};
 const message=`### 求租线索｜${stamp.short}\n\n${shortCount(round.counts)}\n\n[查看本轮](${round.url})｜[今日总览](${day.overview_url})`;
 return {content:message,keys:doc.keys,hash:fingerprint(message,doc.keys),document_url:round.url,overview_url:day.overview_url,document_id:doc.id};
}
module.exports={clock,summary,verifyRound,publishDailyDocument,response,resumeDailyDocuments,smartpageId};
