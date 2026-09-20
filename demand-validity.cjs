// Conservative, source-backed rental dates. Unknown dates remain eligible within ten days.
const DAY=86400000,SHIFT=8*3600000;
const day=t=>Math.floor((t+SHIFT)/DAY);
function validity(x,now=Date.now()){
 if(!['note','comment'].includes(x.type))return {status:'unknown'};
 const published=x.comment?.published_at_ms||x.published_at_ms;
 if(!Number.isFinite(published))return {status:'unknown'};
 const source=x.type==='comment'?x.comment.text:x.title+'\n'+(x.desc||'');
 let evidence=x.ai_review?.rental_period;
 if(!evidence||evidence==='未知'||!source.includes(evidence)){
  // Leading month/day questions are explicit in the user's examples; never parse model numbers.
  const m=source.match(/^\s*((?:\d{4}年)?\d{1,2}(?:月|[./])\d{1,2}[日号]?)(?=\s|[，,])/);
  if(!m||!/(?:问价|有吗|多少钱|租|要用)/.test(source))return {status:'unknown'};
  evidence=m[1];
 }
 // Do not expire partially parsed periods, alternatives, recurrences, or durations.
 if(/每|或者|或|以后|之后|开始|起|周|月底|月初|个月|\d+\s*(?:天|晚|小时)/.test(source))return {status:'unknown',evidence};
 const pub=new Date(published+SHIFT),year=pub.getUTCFullYear();
 const datePattern=/(?<![\w.])(?:(\d{4})[年/-])?(\d{1,2})[月./-](\d{1,2})[日号]?(?![\w.])/g;
 let normalized=evidence.replace(/(\d{1,2})[月./](\d{1,2})[日号]?\s*(?:至|到|[-~～])\s*(\d{1,2})[日号]?(?![\d月./])/g,'$1月$2日至$1月$3日');
 const matches=[...normalized.matchAll(datePattern)],dates=[];
 if(!matches.length||matches.length>2)return {status:'unknown',evidence};
 if([...source.replace(evidence,'').matchAll(datePattern)].length)return {status:'unknown',evidence};
 // Any unparsed digit can be a duration or another date; avoid false expiry.
 if(/\d/.test(normalized.replace(datePattern,'')))return {status:'unknown',evidence};
 for(const m of matches){
  let y=m[1]?Number(m[1]):year;const month=Number(m[2]),d=Number(m[3]);
  if(!m[1]&&pub.getUTCMonth()===11&&month===1)y++;
  if(!m[1]&&pub.getUTCMonth()===0&&month===12)return {status:'unknown',evidence};
  const t=Date.UTC(y,month-1,d)-SHIFT,check=new Date(t+SHIFT);
  if(check.getUTCFullYear()!==y||check.getUTCMonth()!==month-1||check.getUTCDate()!==d)return {status:'unknown',evidence};
  dates.push(t);
 }
 if(dates.length===2&&dates[1]<dates[0])return {status:'unknown',evidence};
 const start=Math.min(...dates),end=Math.max(...dates),today=day(now);
 return {status:day(end)<today?'expired':day(start)===today?'today':day(start)<today?'ongoing':'future',evidence,start,end};
}
module.exports={validity};
