// Presentation only. Eligibility, AI review, deduplication and receipts stay in the sender.
const {ageLabel}=require('./hot-pools.cjs');
const {presentationOrder,sourceLane}=require('./rental-strategy.cjs');
const {validity}=require('./demand-validity.cjs');
const crypto=require('node:crypto');
// Distinct comments may have the same visible quote/date; receipt identity includes stable keys.
const fingerprint=(content,keys)=>crypto.createHash('sha256').update(JSON.stringify({format:'concise-v1',content,keys:[...keys].sort()})).digest('hex');
const flat=s=>String(s??'').replace(/[\r\n]+/g,' / ').replace(/[\u0000-\u0008\u000b-\u001f]/g,'').trim();
const escape=s=>flat(s).replace(/[\\`*_\[\]<>]/g,'\\$&');
const date=t=>Number.isFinite(t)?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric'}).format(new Date(t)):'日期未知';
function shortAlert(reason){
 if(/文档/.test(reason))return '本轮文档生成尚未确认成功，线索已保留，核查后再发送。';
 if(reason==='partial')return '本轮巡检未完整完成，仍有查询或候选待处理；已获取的有效线索单独推送，详情保存在本机。';
 if(/发送|会话|企业微信|授权/.test(reason))return '群消息发送异常，请检查企业微信授权与会话；未确认成功的消息不会盲目重发。';
 if(/DeepSeek|复核|模型/.test(reason))return '线索复核暂时失败，候选已保留，等待重试。';
 if(/登录|扫码/.test(reason))return '小红书巡检已暂停，请重新扫码登录。';
 if(/验证码|访问限制|风控/.test(reason))return '小红书巡检已暂停，请先处理验证码或访问限制。';
 return '小红书巡检暂时中断，结果未更新，请检查本机任务。';
}
function link(x){
 const u=new URL(x.url);
 if(u.protocol!=='https:'||u.hostname!=='www.xiaohongshu.com'||u.pathname!=='/explore/'+x.note_id||u.username||u.password)throw Error('原帖链接校验失败，未发送');
 return u.href.replaceAll('(','%28').replaceAll(')','%29');
}
function parentOf(x,scan){
 const c=x.comment,n=scan.notes?.find(n=>n.note_id===x.note_id);
 const parent=(n?.signals||[]).find(p=>p.id===c.parent_id);
 return {author:parent?.author||c.parent_author||'',text:parent?.text||c.parent_text||''};
}
function row(x,scan,config,now){
 if(x.type==='correction')return `- 更正｜${escape(x.author)}：此前误列为客户，现已确认是同行出租／推广。\n`;
 if(x.type==='resolved')return `- 状态更新｜${escape(x.author)}：“${escape(x.evidence||'原记录标记已解决')}”\n`;
 const c=x.comment,kind=c?(c.parent_id?'楼中楼':'主评论'):'正文';
 const source=c?c.text:(x.desc||x.evidence||x.title||'');
 // Remove only explicit platform hashtag markup; do not summarize or invent source text.
 const quote=c?source:String(source).replace(/#[^#\n]*\[话题\]#/g,'').trim();
 const tags=[];
 const timing=validity(x,now);
 if(timing.status==='today')tags.push('今日用机');
 else if(ageLabel(x,config,now).startsWith('第4'))tags.push('历史需求，待确认');
 if(x.ai_review?.decision==='uncertain')tags.push('意图待确认');
 let text=`- ${kind}｜${escape(c?.author||x.author||'昵称未知')}｜${date(c?.published_at_ms||x.published_at_ms)}：“${escape(quote)}”${tags.length?'（'+tags.join('；')+'）':''}\n`;
 if(c?.parent_id){
  const p=parentOf(x,scan);
  text+=p.text?`  位置：${p.author?'「'+escape(p.author)+'」的':''}“${escape(p.text)}”评论下。\n`:'  位置：楼中楼，父评论原文未取得。\n';
 }
 return text;
}
function render({pending=[],scan={},config,alert=null,awaiting=0,blocked=0,now=Date.now(),maxBytes=18000,maxItems=6}){
 if(!Number.isInteger(maxItems)||maxItems<1)throw Error('每条消息的线索数量必须为正整数');
 const header=`### 求租线索｜${date(now)}\n\n`;
 if(alert)return [{content:header+shortAlert(alert)+'\n',keys:[]}];
 const grouped=new Map();
 const ordered=presentationOrder(pending);
 for(const x of ordered){const rows=grouped.get(x.note_id)||[];rows.push(x);grouped.set(x.note_id,rows);}
 const sectionName=rows=>{
  const lanes=new Set(rows.map(sourceLane));
  if(lanes.has('direct'))return '客户直接求租帖';
  if(lanes.has('organic'))return '非同行帖子评论';
  if(lanes.has('peer'))return '同行帖子评论';
  return '状态更新';
 };
 const groups=[];let current={content:header,keys:[]},currentSections=new Set(),index=0;
 for(const rows of grouped.values()){
  index++;
  const x=rows[0],section=sectionName(rows),sectionHeading=`### ${section}\n\n`,heading=`**${index}. [${escape(x.title||'原帖')}${rows.some(x=>x.type==='note')?'':'｜评论区'}](${link(x)})**\n\n`;
  let needsHeading=true;
  for(const item of rows){
   const line=row(item,scan,config,now);
   if(Buffer.byteLength(header+sectionHeading+heading+line+'\n')>maxBytes)throw Error('单条线索正文过长，已保留待处理，未截断发送');
   let prefix=needsHeading?(currentSections.has(section)?'':sectionHeading)+heading:'';
   let text=prefix+line;
   if(current.keys.length>=maxItems||Buffer.byteLength(current.content+text+'\n')>maxBytes){groups.push(current);current={content:header,keys:[]};currentSections=new Set();needsHeading=true;prefix=sectionHeading+heading;text=prefix+line;}
   current.content+=text;current.keys.push(item.key);currentSections.add(section);needsHeading=false;
  }
  current.content+='\n';
 }
 if(!pending.length){
  const failed=scan.searches?.some(s=>s.error)||scan.warnings?.length;
  current.content+=blocked?'有消息发送结果待确认，已停止自动重发。\n':failed?'本轮查询尚未完成，暂无可推送结果。\n':awaiting?'本轮暂无线索通过复核，待处理内容已保留。\n':'本轮暂无新增求租线索。\n';
 }else if(blocked){
  const notice='有消息发送结果待确认，已停止自动重发。\n';
  if(Buffer.byteLength(current.content+notice)>maxBytes){groups.push(current);current={content:header,keys:[]};}
  current.content+=notice;
 }
 groups.push(current);return groups;
}
module.exports={render,row,shortAlert,fingerprint};
