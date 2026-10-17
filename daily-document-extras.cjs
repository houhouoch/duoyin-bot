const fs=require('node:fs'),path=require('node:path');
const daily=require('./daily-document-delivery.cjs');
const {CATEGORIES,legacy}=require('./lead-presentation.cjs');
const {row}=require('./concise-message.cjs');
const {subject}=require('./rental-strategy.cjs');
const crypto=require('node:crypto');
const norm=s=>String(s).replace(/\\/g,'').replace(/\s/g,'');
function syncWorkspace({cli,delivery,save,base,scan,join='public',allowFollowupEditing=false}){
 if(JSON.parse(fs.readFileSync(path.join(base,'monitor-config.json'),'utf8')).document_layout?.structure==='chronological')return require('./chronological-document.cjs').syncWorkspace({cli,delivery,save,base,scan,join,allowFollowupEditing});
 const stamp=daily.clock(scan.started_at);
 if(!delivery.daily_documents?.[stamp.day])daily.publishDailyDocument(null,{cli,delivery,save,base,scan:{...scan,complete:false},join});
 const day=delivery.daily_documents[stamp.day];
 if(!day?.docid||!day.overview_id)throw Error('今日文档尚未确认创建，运行记录保留待归档');
 const call=(args,data)=>daily.response(cli,args,data);
 const tree=()=>call(['smartpage','pages','get'],{docid:day.docid});
 let structureCache=null;
 const read=id=>{
  const p=call(['smartpage','pages','get'],{docid:day.docid,page_id:id,content_type:'markdown'}).pages?.[0];
  if(p?.page_id!==id)throw Error('分类页读取不匹配');
  let value=p.content_file_inner??(p.file_path?fs.readFileSync(p.file_path,'utf8'):null);
  if(typeof value!=='string')throw Error('分类页正文未返回');
  if(value.startsWith('"'))try{value=JSON.parse(value);}catch{}
  return value;
 };
 const link=id=>{const u=new URL(day.url);u.searchParams.set('p',id);return u.href;};
 const append=(id,content,marker,state)=>{
  // Verified owned entries stay untouched, including any later user edits.
  if(state.verified_at&&!state.writing)return;
  const current=read(id);
  if(norm(current).includes(norm(marker))){state.writing=false;state.verified_at=new Date().toISOString();save();return;}
  if(state.writing)throw Error('文档追加结果待核实，未重复追加');
  if(/<(?:script|iframe|object|embed|svg)\b|\bon\w+\s*=|javascript:|data:text\/html|vbscript:/i.test(content))throw Error('分类内容安全检查失败');
  const folder=path.join(base,'smartpage');fs.mkdirSync(folder,{recursive:true,mode:0o700});
  const file=path.join(folder,'分类归档-'+stamp.day+'-'+Date.now()+'.md');fs.writeFileSync(file,content,{mode:0o600});
  state.writing=true;save();
  try{call(['smartpage','pages','append'],{docid:day.docid,page_id:id,content_type:'markdown',file_path:file});}catch(e){if(e.definite){state.writing=false;save();}throw e;}
  if(!norm(read(id)).includes(norm(marker)))throw Error('分类内容未完整读回');
  state.writing=false;state.verified_at=new Date().toISOString();save();
 };
 day.workspace||={pages:{}};
 if(allowFollowupEditing&&!day.workspace.followup_editor_granted){
  const identity=JSON.parse(cli(['identity','whoami']));
  const user=String(identity.extra_identity_context||'').match(/授权真人用户身份：[\s\S]*?\nID：([^\s]+)/)?.[1];
  if(!user||!/^[A-Za-z0-9_-]+$/.test(user))throw Error('无法确定授权真人身份，未扩大编辑权限');
  call(['doc','members','update'],{docid:day.docid,add_member_list:{items:[{userid:user,user_type:'user',user_auth:'edit'}]}});
  day.workspace.followup_editor_granted=true;day.workspace.followup_editor_permission='accepted_by_wecom';save();
 }

 const ensurePage=name=>{
  let s=day.workspace.pages[name];const structure=structureCache||=(tree());
  if(![day.name,day.doc_title].includes(structure.doc_title))throw Error('今日文档标题变更，停止分类写入');
  const matches=structure.pages.filter(p=>p.parent_id===day.overview_id&&p.page_title===name);
  if(s?.page_id){if(!matches.some(p=>p.page_id===s.page_id))throw Error('分类页面发生变化');return s;}
  if(matches.length>1)throw Error('分类页面不唯一');
  if(s?.creating){if(matches.length!==1)throw Error('分类页面创建结果待核实');s.page_id=matches[0].page_id;s.url=link(s.page_id);s.creating=false;save();return s;}
  if(matches.length)throw Error('已有同名分类页面，未接管');
  s=day.workspace.pages[name]={creating:true,entries:{}};save();
  try{call(['smartpage','pages','update'],{docid:day.docid,create_page:{page_name:name,parent_page_id:day.overview_id}});}catch(e){if(e.definite){s.creating=false;save();}throw e;}
  structureCache=tree();const fresh=structureCache.pages.filter(p=>p.parent_id===day.overview_id&&p.page_title===name);
  if(fresh.length!==1)throw Error('分类页面创建结果待核实');
  s.page_id=fresh[0].page_id;s.url=link(s.page_id);s.creating=false;save();return s;
 };
 const names=[...CATEGORIES,'补充线索','人工待核','运行记录'];
 for(const name of names){const p=ensurePage(name);p.entries||={};}
 day.workspace.navigation||={};
 const navigation='## 分类入口\n\n'+names.map(name=>`[${name}](${day.workspace.pages[name].url})`).join('｜')+'\n\n分类页面只提供轮次入口，完整原话保留在本轮页面。跟进表在各轮次的“分类与跟进索引”中，初始状态为未登记。\n';
 append(day.overview_id,navigation,'分类入口',day.workspace.navigation);
 for(const [roundKey,r] of Object.entries(day.rounds||{})){
  if(r.status!=='verified'||!r.keys?.length||!r.source_doc_file)continue;
  const root=path.join(base,'smartpage')+path.sep,source=path.resolve(r.source_doc_file);
  if(!source.startsWith(root))throw Error('既有轮次原文路径异常');
  const doc=JSON.parse(fs.readFileSync(source,'utf8'));
  if(doc.id!==roundKey)throw Error('既有轮次快照不匹配');
  if(!doc.category_counts){
   const layout=legacy(doc);r.layout_upgrade||={};
   append(r.page_id,'\n'+layout.intro+'\n\n'+layout.followup+'\n','分类与跟进索引',r.layout_upgrade);
   r.category_counts=layout.category_counts;r.supplemental_count=0;save();
  }
  for(const name of [...CATEGORIES,'补充线索']){
   const count=name==='补充线索'?r.supplemental_count||0:r.category_counts?.[name]||0;
   if(!count)continue;const page=day.workspace.pages[name],marker=`${r.title}｜${name}${count}条`;
   page.entries[roundKey]||={};append(page.page_id,`\n${marker}\n\n[查看本轮原话及跟进表](${r.url})\n`,marker,page.entries[roundKey]);
  }
 }
 const operations=day.workspace.pages['运行记录'];
 for(const op of Object.values(delivery.operational_notes||{})){
  if(op.status==='archived')continue;
  const clock=daily.clock(op.started_at),marker=`${clock.day} ${clock.name}运行记录`;
  const lines=[`## ${marker}`,`线索已确认推送${op.accepted}条。`];
  if(op.error)lines.push('本轮执行中断：'+issueText(op.error));
  if(op.searches_planned)lines.push(`搜索完成${op.searches_completed}/${op.searches_planned}项；未执行部分保留至后续轮次。`);
  if(op.detail_failures)lines.push(`有${op.detail_failures}个帖子未成功读取。`);
  if(op.review_pending)lines.push(`待核实候选${op.review_pending}条${op.manual_review_pending?`，其中${op.manual_review_pending}条转人工待核`:''}；尚未作为有效线索推送。`);
  if(op.warnings?.length)lines.push('本轮未完成项目：\n'+op.warnings.map(w=>'- '+String(w).replaceAll('MCP请求超时','读取超时').replaceAll('<','&lt;').replaceAll('>','&gt;')).join('\n'));
  if(op.schedule_missing?.length)lines.push('以下计划时段没有运行记录：'+op.schedule_missing.map(x=>{const c=daily.clock(x);return c.day+' '+c.time.slice(0,5);}).join('、')+'。仅按现有日志判断，未推断具体原因。');
  if(!op.error&&!op.warnings?.length&&!op.review_pending)lines.push('本轮交付核对完成。');
  const manual=day.workspace.pages['人工待核'];manual.candidates||={};
  const candidates=(op.manual_candidates||[]).map(x=>({x,id:x.ai_review_error?.input_hash||crypto.createHash('sha256').update(x.key+'|'+subject(x)).digest('hex')})).filter(c=>!manual.candidates[c.id]);
  if(candidates.length){
   const pendingMarker=`${clock.day} ${clock.name}首次待核${candidates.length}条`;
   const config=JSON.parse(fs.readFileSync(path.join(base,'monitor-config.json'),'utf8'));
   const body=`## ${pendingMarker}\n\n以下是当时未通过原文校验的候选，尚未作为有效线索推送；仅供人工核实，不计入新增需求数量。\n\n`+candidates.map(({x},i)=>{
    const raw=new URL(x.url);if(raw.protocol!=='https:'||raw.hostname!=='www.xiaohongshu.com')throw Error('候选原帖链接异常');
    const reason=String(x.ai_review_error?.code||'').startsWith('INVALID_DEVICE')?'设备字段不能从本人原文逐字核对':String(x.ai_review_error?.code||'').startsWith('INVALID_RENTAL_PERIOD')?'租期字段不能从本人原文逐字核对':'模型输出未通过原文校验';
    return `**${i+1}. [查看原帖](${raw.href})**\n\n`+row(x,{},config,Date.now())+'\n待核原因：'+reason+'。\n';
   }).join('\n');
   manual.entries[op.id]||={};append(manual.page_id,body,pendingMarker,manual.entries[op.id]);
   for(const c of candidates)manual.candidates[c.id]={archived_at:new Date().toISOString()};save();
  }
  operations.entries[op.id]||={};append(operations.page_id,lines.join('\n\n')+'\n',marker,operations.entries[op.id]);
  op.status='archived';op.archived_at=new Date().toISOString();op.document_url=operations.url;save();
 }
 day.workspace.verified_at=new Date().toISOString();save();
 return {status:'verified',overview_url:day.overview_url,operations_url:operations.url,category_urls:Object.fromEntries(CATEGORIES.map(n=>[n,day.workspace.pages[n].url]))};
}
function issueText(error){
 if(/文档.*(权限|授权)|文档读取/.test(error))return '企业微信文档权限检查未通过，待恢复后补归档。';
 if(/企业微信|消息|会话|授权/.test(error))return '企业微信交付检查未通过，未确认发送的线索保留。';
 if(/登录|扫码/.test(error))return '小红书登录失效，需要重新登录。';
 if(/验证码|访问限制|风控/.test(error))return '小红书访问受限，任务已暂停。';
 if(/库存/.test(error))return '库存源文件读取失败。';
 if(/复核|DeepSeek/.test(error))return '线索复核未完成，候选保留待处理。';
 return '任务未完整结束，具体诊断保存在本机。';
}
module.exports={syncWorkspace,issueText};
