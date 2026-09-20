// Heat is a transparent proxy within returned search results, not a global ranking.
// Pools are part of the existing watchlist; adding a card does not mark its comments read.
const DAY=86400000;
function count(value){
 const s=String(value??'').trim().replace(/[,，+]/g,'');
 const m=s.match(/^(\d+(?:\.\d+)?)\s*(万|亿|[wk])?$/i);
 return m?Number(m[1])*({万:1e4,亿:1e8,w:1e4,k:1e3}[m[2]?.toLowerCase()]||1):null;
}
function plans(watch,config,now=Date.now()){
 if(!config.hot_pool?.enabled)return [];
 const h=config.hot_pool,plans=[];
 const lastAttempt=category=>{const p=watch.hot_pools?.[category];return Math.max(Date.parse(p?.last_attempted_at||'')||0,Date.parse(p?.refresh_error_at||'')||0);};
 let selected=0;
 for(const category of [...config.discovery_categories].sort((a,b)=>lastAttempt(a)-lastAttempt(b))){
  const p=watch.hot_pools?.[category];
  if(p&&p.member_ids.length>=h.per_category&&now-Date.parse(p.refreshed_at)<h.refresh_hours*3600000)continue;
  if(selected++>=(h.max_refresh_categories_per_run||3))break;
  const terms=h.queries[category],round=p?.refresh_round||0;
  for(const sort_by of h.sorts)plans.push({kind:'hot',category,keyword:terms[round%terms.length],sort_by,publish_time:'不限'});
 }
 // Each category receives its first query before any category gets a second query.
 return plans.sort((a,b)=>h.sorts.indexOf(a.sort_by)-h.sorts.indexOf(b.sort_by));
}
function card(feed,plan,now){
 const n=feed.noteCard||{},i=n.interactInfo||{};
 if(!feed.id||!feed.xsecToken||!feed.noteCard)return null;
 return {id:feed.id,token:feed.xsecToken,title:n.displayTitle||'',observed_at:new Date(now).toISOString(),
  metrics:{comments:count(i.commentCount),likes:count(i.likedCount),collects:count(i.collectedCount)},
  source:{keyword:plan.keyword,sort_by:plan.sort_by,category:plan.category}};
}
function rank(a,b){return (b.metrics.comments??-1)-(a.metrics.comments??-1)||(b.metrics.likes??-1)-(a.metrics.likes??-1)||(b.metrics.collects??-1)-(a.metrics.collects??-1)||a.id.localeCompare(b.id);}
function update(watch,config,results,now=Date.now()){
 watch.hot_pools ||= {};watch.hot_candidates ||= {};
 for(const category of config.discovery_categories){
  const queried=results.filter(r=>r.kind==='hot'&&r.category===category);
  if(!queried.length)continue;
  const successful=queried.filter(r=>!r.error);
  const old=watch.hot_pools[category],candidates=new Map();
  for(const r of successful)for(const f of r.feeds){const c=card(f,r,now);if(c){
   const prev=candidates.get(c.id);if(prev){for(const key of ['comments','likes','collects'])if(c.metrics[key]===null)c.metrics[key]=prev.metrics[key];}
   candidates.set(c.id,c);
  }}
  // A failed refresh must not erase the previous pool. Stale carry-over stays labeled.
  if(successful.length<config.hot_pool.sorts.length)for(const id of old?.member_ids||[]){if(!candidates.has(id)&&watch.hot_candidates[id])candidates.set(id,watch.hot_candidates[id]);}
  const selected=[...candidates.values()].sort(rank).slice(0,config.hot_pool.per_category);
  if(!successful.length){
   watch.hot_pools[category] ||= {member_ids:[],target:config.hot_pool.per_category,refresh_round:0,refresh_partial:true};
   watch.hot_pools[category].refresh_error_at=new Date(now).toISOString();continue;
  }
  for(const c of selected)watch.hot_candidates[c.id]={...watch.hot_candidates[c.id],...c};
  watch.hot_pools[category]={member_ids:selected.map(c=>c.id),target:config.hot_pool.per_category,
   refreshed_at:successful.length===config.hot_pool.sorts.length?new Date(now).toISOString():old?.refreshed_at||null,
   last_attempted_at:new Date(now).toISOString(),refresh_round:(old?.refresh_round||0)+1,
   refresh_partial:successful.length<config.hot_pool.sorts.length,candidate_count:candidates.size};
 }
}
function jobs(watch,config,now=Date.now()){
 if(!config.hot_pool?.enabled)return [];
 const h=config.hot_pool,groups=config.discovery_categories.map(category=>{
  return (watch.hot_pools?.[category]?.member_ids||[]).map(id=>{
   const c=watch.hot_candidates?.[id],n=watch.notes?.[id];if(!c)return null;
   const attempt=Math.max(Date.parse(n?.last_attempted||'')||0,Date.parse(c.last_attempted||'')||0,Date.parse(n?.last_checked||'')||0);
   const active=Date.parse(n?.last_activity_at||'')>now-3*DAY;
   const due=!n?.last_checked||now-attempt>=(active?h.active_recheck_hours:h.inactive_recheck_hours)*3600000;
   // Failed initial reads wait until the next four-hour round rather than looping.
   if(!due||(!n?.last_checked&&attempt&&now-attempt<4*3600000))return null;
   return {...c,category,phase:'hot',recheck:!!n,attempt,unread:!n?.last_checked,active};
  }).filter(Boolean).sort((a,b)=>Number(b.unread)-Number(a.unread)||Number(b.active)-Number(a.active)||a.attempt-b.attempt||rank(a,b));
 });
 const out=[],seen=new Set();
 for(let i=0;groups.some(g=>i<g.length);i++)for(const g of groups){const c=g[i];if(c&&!seen.has(c.id)){seen.add(c.id);out.push(c);}}
 return out.slice(0,h.max_details_per_run);
}
function coverage(watch,config,notes=[],now=Date.now()){
 return config.discovery_categories.map(category=>{
  const p=watch.hot_pools?.[category],ids=p?.member_ids||[],success=notes.filter(n=>!n.error&&ids.includes(n.note_id));
  return {category,target:config.hot_pool.per_category,selected:ids.length,
   read_this_run:success.length,failed_this_run:notes.filter(n=>n.error&&ids.includes(n.note_id)).length,
   never_read:ids.filter(id=>!watch.notes?.[id]?.last_checked).length,
   partial_comments:ids.filter(id=>watch.notes?.[id]?.comment_coverage?.partial).length,
   refreshed_at:p?.refreshed_at||null,refresh_partial:!!p?.refresh_partial,
   stale:!p?.refreshed_at||now-Date.parse(p.refreshed_at)>config.hot_pool.refresh_hours*3600000};
 });
}
function commentLimit(previous,config){
 const base=config.max_comment_items,ceiling=config.max_comment_items_ceiling||base;
 return previous?.comment_coverage?.partial?Math.min(ceiling,(previous.comment_coverage.request_limit||base)+base):base;
}
function start(days,now=Date.now()){return Math.floor((now+8*3600000)/DAY)*DAY-8*3600000-(days-1)*DAY;}
function ageLabel(x,config,now=Date.now()){
 const t=x.comment?.published_at_ms||x.published_at_ms;
 if(!Number.isFinite(t))return '发布时间未知';
 if(t>now||t<start(config.freshness_calendar_days,now))return '不在有效窗口';
 return t>=start(config.recent_priority_calendar_days||3,now)?'近3天需求':'第4—10天历史需求，需确认仍在求租';
}
function restoreExpired(watch,history,config,now=Date.now()){
 let n=0;watch.outbox ||= {};
 for(const [key,x] of Object.entries(watch.suppressed||{})){
  const t=x.comment?.published_at_ms||x.published_at_ms;
  if(x.reason!=='超过近期窗口，未推送'||history.sent?.[key]||!Number.isFinite(t)||t<start(config.freshness_calendar_days,now)||t>now)continue;
  const {reason,suppressed_at,...item}=x;
  watch.outbox[key] ||= {...item,window_reopened_at:new Date(now).toISOString()};delete watch.suppressed[key];n++;
 }
 return n;
}
module.exports={count,plans,update,jobs,coverage,commentLimit,start,ageLabel,restoreExpired};
