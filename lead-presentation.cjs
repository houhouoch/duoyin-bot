const {presentationOrder,categoryOf,subject}=require('./rental-strategy.cjs');
const CATEGORIES=['相机','手机','镜头','其他与待确认'];
const text=s=>String(s??'').replace(/[\r\n]+/g,' ').replace(/[\\`*_\[\]<>|]/g,'\\$&');
function describe(items,now=Date.now()){
 const grouped=new Map();for(const x of presentationOrder(items)){const rows=grouped.get(x.note_id)||[];rows.push(x);grouped.set(x.note_id,rows);}
 const rows=[...grouped.values()].flat().filter(x=>['note','comment'].includes(x.type)).map((x,i)=>{
  // A comment's own words determine equipment. Its parent post is not evidence.
  const quote=subject(x),device=x.ai_review?.device;
  const category=categoryOf(device&&device!=='未知'&&quote.includes(device)?device:quote)||'其他与待确认';
  const intent={demand:'明确求租',inquiry:'询价',uncertain:'待确认'}[x.ai_review?.decision]||'待确认';
  const timestamp=x.comment?.published_at_ms||x.published_at_ms;
  const age=Number.isFinite(timestamp)?Math.floor((now+28800000)/86400000)-Math.floor((timestamp+28800000)/86400000):null;
  return {number:i+1,category,intent,age:age===null?'日期未知':age<=2?'近期需求':'历史需求',source:x.delivery_lane==='supplemental'?'补充线索':'主要线索',quote,key:x.key};
 });
 return describeRows(rows);
}
function describeRows(rows){
 const category_counts=Object.fromEntries(CATEGORIES.map(c=>[c,rows.filter(x=>x.category===c).length]));
 const supplemental_count=rows.filter(x=>x.source==='补充线索').length;
 const intro='## 分类速览\n\n'+CATEGORIES.filter(c=>category_counts[c]).map(c=>`${c}${category_counts[c]}条`).join('｜')+(require('./monitor-config.json').delivery_priority?.include_peer_leads===false&&supplemental_count===0?`\n\n有效线索${rows.length}条。原话和来源保留。`:`\n\n主要线索${rows.length-supplemental_count}条｜补充线索${supplemental_count}条。补充线索来自同行帖子下其他人的求租评论，原话和来源保留。`);
 const table='| 序号 | 设备类别 | 意向 | 时效 | 分组 | 原文定位 | 跟进状态 | 负责人 | 备注 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n'+rows.map(r=>`| ${r.number} | ${r.category} | ${r.intent} | ${r.age} | ${r.source} | ${text(r.quote.slice(0,60))}${r.quote.length>60?'…':''} | 未登记 |  |  |`).join('\n');
 const followup='## 分类与跟进索引\n\n按设备类别、意向、时效和主要／补充分组查找原文。跟进状态由经办人填写：未跟进、已联系、已解决；初始“未登记”表示尚未登记，不推断是否已联系。此表保留在本轮页面，可由具有编辑权限的成员维护。\n\n'+table;
 return {rows,category_counts,supplemental_count,intro,followup};
}
function legacy(doc){
 const rows=(doc.rows||[]).filter(s=>/^- (正文|主评论|楼中楼)｜/.test(s)).map((s,i)=>{
  const quote=(s.match(/：“([\s\S]*)”/)?.[1]||s).replace(/\\([\\`*_\[\]<>])/g,'$1');
  return {number:i+1,quote,category:categoryOf(quote)||'其他与待确认',intent:'待确认',age:s.includes('历史需求')?'历史需求':'见原文日期',source:'已收录线索'};
 });
 const layout=describeRows(rows);layout.supplemental_count=0;layout.intro='## 分类速览\n\n已收录'+rows.length+'条需求。'+CATEGORIES.filter(c=>layout.category_counts[c]).map(c=>c+layout.category_counts[c]+'条').join('｜')+'。历史跟进情况未登记，不推断是否已联系。';return layout;
}
module.exports={CATEGORIES,describe,describeRows,legacy};
