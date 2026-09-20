// Document transport only: selection, DS review and sent-key ownership stay in the existing sender.
const fs=require('node:fs'),path=require('node:path');
const {render,fingerprint}=require('./concise-message.cjs');
const {assertSameKeys}=require('./delivery-integrity.cjs');
const norm=s=>String(s).replace(/\\/g,'').replace(/\s/g,'');
function smartpageId(url){
 const u=new URL(url),match=u.pathname.match(/^\/smartpage\/(a1_[A-Za-z0-9_-]+)$/);
 if(u.protocol!=='https:'||u.hostname!=='doc.weixin.qq.com'||!match)throw Error('文档链接不符合预期');
 return match[1];
}
function buildDocument(pending,scan,config,now=Date.now(),blocked=0){
 const groups=render({pending,scan,config,now,maxItems:100000,maxBytes:1024*1024});
 assertSameKeys(pending.map(x=>x.key),groups.flatMap(x=>x.keys));
 let body=groups.map(x=>x.content).join('\n');
 const rows=body.split('\n').filter(x=>/^- (正文|主评论|楼中楼|更正|状态更新)｜/.test(x));
 if(rows.length!==pending.length)throw Error('文档线索数量核对失败');
 // Follow the renderer's stable group order, but calculate counts from real records.
 const byKey=new Map(pending.map(x=>[x.key,x])),byPost=new Map();
 for(const key of groups.flatMap(x=>x.keys)){
  const x=byKey.get(key);if(!byPost.has(x.note_id))byPost.set(x.note_id,{notes:0,comments:0,updates:0,corrections:0});
  const s=byPost.get(x.note_id),field={note:'notes',comment:'comments',resolved:'updates',correction:'corrections'}[x.type];
  if(!field)throw Error('未知记录类型，未生成文档统计');s[field]++;
 }
 const statistics=[...byPost.values()].map(s=>{
  const demands=s.notes+s.comments,total=demands+s.updates+s.corrections;
  const parts=[s.notes?`帖子需求${s.notes}条`:'',s.comments?`评论需求${s.comments}条（含主评论、楼中楼）`:'',s.updates?`状态更新${s.updates}条`:'',s.corrections?`更正${s.corrections}条`:''].filter(Boolean);
  return {...s,total,label:`本帖共${total}条${total===demands?'求租线索':'记录'}｜${parts.join('＋')}`};
 });
 const totals=statistics.reduce((a,s)=>({notes:a.notes+s.notes,comments:a.comments+s.comments,updates:a.updates+s.updates,corrections:a.corrections+s.corrections}),{notes:0,comments:0,updates:0,corrections:0});
 let headings=0;
 body=body.replace(/^\*\*(\d+)\. \[.*\]\(https:\/\/www\.xiaohongshu\.com\/[^\s)]+\)\*\*$/gm,(heading,number)=>{
  if(Number(number)!==++headings||!statistics[headings-1])throw Error('文档分组统计与标题不一致');
  return heading+'\n\n**'+statistics[headings-1].label+'**';
 });
 if(headings!==statistics.length)throw Error('文档分组统计数量不一致');
 const demandCount=totals.notes+totals.comments;
 const summary=`统计说明：本页共${statistics.length}个原帖链接、${demandCount}条求租线索，其中帖子需求${totals.notes}条、评论需求${totals.comments}条。${totals.updates||totals.corrections?`另有状态更新${totals.updates}条、更正${totals.corrections}条，不计入求租线索。`:''}一个链接下可包含多条需求，数量按收录的需求记录统计，不等于${demandCount}位独立客户，也不代表该帖全部评论。`;
 const stamp=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'}).format(new Date(scan.started_at||now));
 const name=`小红书求租线索（${stamp}）`;
 const end=`本批文档整理完毕，共${pending.length}条；不代表全平台已覆盖。`;
 const content=`# ${name}\n\n本次新增推送 ${pending.length} 条，按原帖归组。日期为原文发布日期，历史需求及意图待确认标记保留。\n\n${body}\n${end}\n\n### 线索数量说明\n\n${summary}\n${blocked?'\n另有消息发送结果待确认，已停止自动重发。\n':''}`;
 if(/<(?:script|iframe|object|embed|svg)\b|\bon\w+\s*=|javascript:|data:text\/html|vbscript:/i.test(content))throw Error('文档内容安全检查未通过，未写入');
 const keys=pending.map(x=>x.key),id=fingerprint(content,keys);
 return {name,content,keys,rows,end,id,statistics,summary,links:[...content.matchAll(/\]\((https:\/\/www\.xiaohongshu\.com\/[^\s)]+)\)/g)].map(x=>x[1])};
}
function verifyDocument(doc,content){
 const text=norm(content),counts=new Map();
 for(const line of doc.rows){const key=norm(line.slice(2));counts.set(key,(counts.get(key)||0)+1);}
 for(const [line,count] of counts)if(text.split(line).length-1!==count)throw Error('文档读回原文遗漏或重复，未发群');
 for(const line of doc.content.split('\n').filter(x=>/^\s+位置：/.test(x)))if(!text.includes(norm(line)))throw Error('文档父评论定位缺失，未发群');
 if(!text.includes(norm(doc.end)))throw Error('文档末尾不完整，未发群');
 const labels=new Map();for(const stat of doc.statistics||[])labels.set(norm(stat.label),(labels.get(norm(stat.label))||0)+1);
 for(const [label,count] of labels)if(text.split(label).length-1!==count)throw Error('文档分组统计遗漏或重复，未发群');
 if(doc.summary&&!text.includes(norm(doc.summary)))throw Error('文档总数说明缺失，未发群');
 for(const link of doc.links)if(!text.includes(norm(link).replaceAll('&','&amp;'))&&!text.includes(norm(link)))throw Error('文档原帖链接缺失，未发群');
 return true;
}
function publishDocument(doc,{cli,delivery,save,base,join='apply'}){
 delivery.documents ||= {};
 for(const [id,prior] of Object.entries(delivery.documents))if(id!==doc.id&&['creating','writing','written'].includes(prior.status)&&prior.keys.some(k=>doc.keys.includes(k)))throw Error('此前文档写入结果待核实，未重复建文档或发群');
 let d=delivery.documents[doc.id];
 const persist=()=>save();
 const call=(args,data)=>{
  let r;try{r=JSON.parse(cli([...args,'--json',JSON.stringify(data)]));}catch(e){
   const kind=e.code==='ETIMEDOUT'?'超时':e.name==='SyntaxError'?'回包不是有效JSON':'连接或执行异常';
   throw Error('文档接口'+kind+'，记录已保留');
  }
  if(r.errcode!==0||r.status==='failed')throw Object.assign(Error('文档接口未明确成功，未发群（错误码 '+(Number.isInteger(r.errcode)?r.errcode:'未知')+'）'),{definite:Number.isInteger(r.errcode)&&r.errcode!==0});
  return r;
 };
 if(d&&!d.docid&&d.status!=='create_failed')throw Error('文档创建结果待核实，停止自动重复创建');
 if(!d||d.status==='create_failed'){
  d=delivery.documents[doc.id]={status:'creating',keys:doc.keys,at:new Date().toISOString()};persist();
  let r;try{r=call(['smartpage','create'],{name:doc.name});}catch(e){if(e.definite){d.status='create_failed';persist();}throw e;}
  if(!r.url)throw Error('文档创建结果缺少链接，需人工核实');
  Object.assign(d,{docid:smartpageId(r.url),url:r.url,status:'created'});persist();
 }
 if(!d.rules_set){
  call(['doc','rules','update'],{docid:d.docid,enable_member_join_admin_check:false,corp_internal_join_auth:['read','public'].includes(join)?'read':'apply',corp_external_join_auth:join==='public'?'read':'deny'});
  d.rules_set=true;d.join=join;persist();
 }
 const tree=call(['smartpage','pages','get'],{docid:d.docid});
 if(tree.doc_title!==doc.name||tree.pages?.length!==1)throw Error('文档标题或页面数量变化，停止自动写入');
 const page=tree.pages[0].page_id;
 const read=()=>{
  const r=call(['smartpage','pages','get'],{docid:d.docid,page_id:page,content_type:'markdown'});
  const p=r.pages?.[0];
  if(p?.page_id!==page)throw Error('文档读回页面不匹配');
  if(typeof p.content_file_inner==='string')return p.content_file_inner;
  if(p.file_path)return fs.readFileSync(p.file_path,'utf8');
  throw Error('文档正文无法读回');
 };
 let current=read();
 if(['writing','written','verified'].includes(d.status))verifyDocument(doc,current);
 else {
  // Only this freshly created, known-empty document can be appended to.
  if(current.trim()&&!/^<[^>]+>\s*<\/[^>]+>$/.test(current.trim()))throw Error('新文档已有内容，停止追加');
  const folder=path.join(base,'smartpage');fs.mkdirSync(folder,{recursive:true,mode:0o700});
  const file=path.join(folder,doc.name+'（'+doc.id.slice(0,8)+'）.md');fs.writeFileSync(file,doc.content,{mode:0o600});
  d.status='writing';persist();
  try{call(['smartpage','pages','append'],{docid:d.docid,page_id:page,content_type:'markdown',file_path:file});}catch(e){if(e.definite){d.status='created';persist();}throw e;}
  d.status='written';persist();current=read();verifyDocument(doc,current);
 }
 d.status='verified';d.verified_at=new Date().toISOString();d.count=doc.keys.length;persist();
 const content=`### 求租线索\n\n新增 ${doc.keys.length} 条｜[查看完整文档](${d.url})\n\n${['read','public'].includes(d.join)?'':'首次打开如需权限，请申请访问。\n'}本批文档整理完毕。`;
 return {content,keys:doc.keys,hash:fingerprint(content,doc.keys),document_url:d.url,document_id:doc.id};
}
module.exports={buildDocument,verifyDocument,publishDocument,smartpageId};
