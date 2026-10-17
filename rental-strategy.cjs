const fs=require('node:fs'),path=require('node:path');
const config=JSON.parse(fs.readFileSync(path.join(__dirname,'monitor-config.json')));
const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'camera-catalog.json')));
const devices=catalog.devices||config.devices;
const normalize=s=>String(s||'').toLowerCase().replace(/[\s+＋➕\-—_（）()]/g,'');
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// Search exclusions survive the daily read-only inventory refresh.
// They do not erase historical records or reinterpret collected quotations.
function searchAliases(model){
 const value=normalize(model).replace(/^(?:苹果|iphone|富士|fujifilm)/,'');
 if(['17pm','17promax'].includes(value))return ['17pm','17promax','iphone17pm','iphone17promax','苹果17pm','苹果17promax'];
 return value==='x100v'?['x100v','fujifilmx100v']:[value];
}
function excludedSearchModel(text,settings=config.retrieval||{}){
 const value=normalize(text);
 return (settings.excluded_search_models||[]).some(model=>searchAliases(model).some(alias=>alias&&new RegExp('(?<![a-z0-9])'+escape(alias)+'(?![a-z0-9])','i').test(value)));
}
function excludedFamilyHeading(text,settings=config.retrieval||{}){
 const value=normalize(text).replace(/^(?:苹果|iphone|富士|fujifilm)/,'');
 return value.length>=3&&(settings.excluded_search_models||[]).some(model=>searchAliases(model).some(alias=>alias!==value&&alias.startsWith(value)));
}
const aliases={rx100m7:['黑卡7'],rx10m4:['胖卡4'],r62:['r6ii','r6二代'],r52:['r5ii','r5二代'],x200u:['x200ultra'],x300u:['x300ultra'],x300pro:['x300p'],pocket3:['p3'],pocket4:['p4'],pocket4pro:['4p','pocket4p']};
function terms(row){
 const raw=[row.category,...row.combination.split(/[+＋➕/]/)].map(s=>s.replace(/（[^）]*）|\([^)]*\)/g,'').replace(/单租|机身|镜头|超长焦|多种卡口|系列/g,'').trim());
 const found=raw.flatMap(s=>[s,...(s.match(/(?:RF|XF|AF|Z)?\d{2,3}[-—]\d{2,3}|(?:[a-z]+[\s-]*\d[a-z0-9. -]*|\d{4,6}[a-z]*)/ig)||[]).map(t=>t.trim())]);
 return [...new Set(found.flatMap(s=>[s,...(aliases[normalize(s).replace(/^(佳能|索尼|尼康|富士|vivo|三星)/,'')]||[])]).filter(s=>/[a-z0-9]/i.test(s)&&normalize(s).length>=2&&!/^\d{1,3}(?:\.\d+)?$/.test(s)))];
}
const indexed=devices.map(row=>({...row,terms:terms(row)}));
const queryModels=[...new Set(indexed.flatMap(row=>{
 const category=row.category.replace(/（[^）]*）/g,'').replace(/系列|多种卡口|超长焦/g,'').trim();
 return /[a-z0-9]/i.test(category)?[category]:row.terms.filter(t=>t.length>=3).slice(0,2);
}))].filter(model=>!excludedSearchModel(model)&&!excludedFamilyHeading(model));
function inventoryMatches(text){
 const n=String(text||'').toLowerCase().replace(/[\s\-—_（）()]/g,'');
 return indexed.filter(row=>row.terms.some(t=>{const v=normalize(t);return new RegExp('(?<![a-z0-9])'+escape(v)+'(?![a-z0-9])','i').test(n);})).slice(0,5).map(({category,combination,source_row})=>({category,combination,source_row}));
}
function subject(x){return x.type==='comment'?x.comment?.text||'':x.evidence||x.title+'\n'+(x.desc||'');}
function tier(x){return inventoryMatches(subject(x)).length?'inventory':'other';}
function compare(a,b){
 const age=x=>Math.floor(Math.max(0,Date.now()-(x.comment?.published_at_ms||x.published_at_ms||0))/(12*3600000));
 return age(a)-age(b)||(tier(a)==='inventory'?0:1)-(tier(b)==='inventory'?0:1)||Number(/待核实|uncertain/.test(a.classification||''))-Number(/待核实|uncertain/.test(b.classification||''))||(b.comment?.published_at_ms||b.published_at_ms||0)-(a.comment?.published_at_ms||a.published_at_ms||0);
}
function queries(state){
 const plan=[],settings=config.retrieval||{},round=state.diversity_round||0;
 const categories=['相机','手机','镜头'];
 const ordered=categories.slice(round%3).concat(categories.slice(0,round%3));
 for(const category of ordered){
  const pool=modelPools[category],templates=settings.inventory_templates||['求租 {model}','{model} 哪里租','想租 {model}'];
  // Prefer two different model families in the same round. Short pools may
  // reuse a family across rounds, but never spend both phone slots on X300
  // when a Samsung or other family is available.
  const first=pool[(round*2)%pool.length]||category,firstFamily=familyOf(first);
  const second=pool.find((model,index)=>index>=(round*2+1)%pool.length&&familyOf(model)!==firstFamily)||pool.find(model=>familyOf(model)!==firstFamily)||pool[(round*2+1)%pool.length]||category;
  for(const [slot,model] of [first,second].entries()){
   const template=templates[(Math.floor(round/Math.max(1,pool.length))+slot)%templates.length];
   plan.push({keyword:template.replace('{model}',model),kind:'inventory',category,model,slot});
  }
 }
 for(const category of ordered){
  const words=settings.direct_discovery_queries?.[category]||settings.discovery_queries?.[category]||['求租 '+category];
  plan.push({keyword:words[round%words.length],kind:'discovery',category});
 }
 state.diversity_round=round+1;
 return plan.filter((x,i,a)=>!excludedSearchModel(x.keyword)&&a.findIndex(y=>y.keyword===x.keyword)===i).slice(0,config.max_searches_per_run||6);
}

// Categories are scheduling hints, never inferred customer equipment fields.
function categoryOf(text){
 if(/vivo|iphone|苹果|三星|手机|x(?:200|300)\s*(?:u|ultra|p|pro)|s23u/i.test(text))return '手机';
 if(/镜头|增距|(?:rf|xf|xc)\s*\d|\d{2,3}[-—]\d{2,3}|100400|100500|200600|200800|70350|400800|180600|70300|150600|1655|适马|腾龙/i.test(text))return '镜头';
 if(/相机|机身|佳能|索尼|尼康|富士|理光|松下|大疆|拍立得|pocket|g7x|\bgr[34]|\br[567]|\bxt[345]|\bxs[12]|\bz30|\ba6|zve10|黑卡|胖卡|luna|mini\d|sq\d|wide\d/i.test(text))return '相机';
 return null;
}
function familyOf(text){
 if(/g7x|g12/i.test(text))return '佳能卡片';
 if(/x200(?:p|pro|u|ultra)?/i.test(text))return 'vivo X200';
 if(/x300(?:p|pro|u|ultra)?/i.test(text))return 'vivo X300';
 if(/佳能|\br[567]|\brf\d/i.test(text))return /sx|g7x|g12/i.test(text)?'佳能卡片':'佳能';
 if(/索尼|\ba6|zve|rx\d|黑卡|胖卡/i.test(text))return '索尼';
 if(/富士|\bxt|\bxs|\bxf|\bxc|x100/i.test(text))return '富士';
 if(/尼康|\bz\d/i.test(text))return '尼康';
 if(/大疆|pocket/i.test(text))return '大疆';
 if(/理光|\bgr[34]/i.test(text))return '理光';
 if(/拍立得|mini\d|sq\d|wide\d/i.test(text))return '拍立得';
 return text.match(/vivo|三星|iphone|苹果|松下|适马|腾龙|Luna/i)?.[0].toLowerCase()||'其他';
}
function roundRobin(rows,key,order=[]){
 const groups=new Map(order.map(k=>[k,[]]));
 for(const row of rows){const k=key(row);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(row);}
 const out=[];for(let i=0;[...groups.values()].some(g=>g.length>i);i++)for(const g of groups.values())if(g[i])out.push(g[i]);
 return out;
}
function buildModelPools(rows,settings=config.retrieval||{}){
 const pools={'相机':[],'手机':[],'镜头':[]},seen=new Set();
 for(const row of rows){
  if(excludedSearchModel(row.combination,settings))continue;
  // Include each combination's body, not just a shared heading (e.g. 旅拍系列).
  const headings=row.category.split('/'),candidates=[...headings,row.combination.split(/[+＋➕]/)[0]];
  for(const [index,raw] of candidates.entries()){
   let t=raw;
   t=t.replace(/（[^）]*）|\([^)]*\)/g,'').replace(/单租|单机身|机身|镜头|超长焦|系列/g,'').trim();
   t=t.replace(/\s*(?:套装|套机头|需要内存卡|富士口|索尼口|佳能RF口|多种卡口|外变焦|内变焦).*$/,'').trim();
   if(excludedSearchModel(t,settings)||(index<headings.length&&excludedFamilyHeading(t,settings)))continue;
   if(/支架|云台|补光|神牛|^V\d|^AD\d|优篮子|^FY\d|多款|多种/i.test(t)||!/[a-z].*\d|\d.*[a-z]|Luna Ultra|(?:适马|腾龙)\d/i.test(t))continue;
   const category=categoryOf(t)||categoryOf(row.category);if(!category)continue;
   const n=normalize(t).replace(/^(佳能|索尼|尼康|富士|理光|松下|大疆|vivo|三星)/,'').replace(/^x300p$/,'x300pro').replace(/^(x[23]00)ultra$/,'$1u');
   if(seen.has(category+n))continue;seen.add(category+n);pools[category].push(t);
  }
 }
 for(const k of Object.keys(pools))pools[k]=roundRobin(pools[k],familyOf,k==='相机'?['佳能','索尼','富士','大疆','理光','尼康','佳能卡片','松下','拍立得','其他']:[]);
 return pools;
}
const modelPools=buildModelPools(devices);
function freshPicks(items,limit,settings=config.delivery_priority||{}){
 const rows=items.filter(x=>!x.known&&(settings.include_peer_leads!==false||!x.merchant)).sort((a,b)=>Number(b.demand)-Number(a.demand)||Number(b.inventory_match)-Number(a.inventory_match));
 // Merchant posts are only limited comment sources; they are not customer leads.
 let merchants=0;const eligible=rows.filter(x=>!x.merchant||x.demand||merchants++<2);
 return roundRobin(eligible,x=>categoryOf(x.title)||x.category||'未知',['相机','手机','镜头']).slice(0,limit);
}
function searchOrder(latest,hotPlans,stats={}){
 if(config.retrieval?.prefer_direct_discovery&&latest.some(x=>x.category)){
  const categories=[...new Set(latest.map(x=>x.category))],first=[],used=new Set();
  const discovery=latest.filter(x=>(x.query_kind||x.kind)==='discovery');
  const score=x=>{const s=stats[x.keyword];return s?.attempts?(s.demand_candidates||0)/Math.max(1,s.details_read||0)-Math.min(1,(s.elapsed_ms||0)/s.attempts/120000):0;};
  discovery.sort((a,b)=>score(b)-score(a));for(const x of discovery){first.push(x);used.add(x.keyword);}
  for(const category of categories){const x=latest.find(p=>p.category===category&&(p.query_kind||p.kind)==='inventory');if(x){first.push(x);used.add(x.keyword);}}
  return [...first,...latest.filter(x=>!used.has(x.keyword)),...hotPlans];
 }
 // Each category's inventory search precedes refresh work. At most one hot
 // category refresh per round is configured separately, without raising rate.
 return [...latest.slice(0,3),...hotPlans,...latest.slice(3)];
}
function detailOrder(fresh,hotJobs,old){
 const queues=[fresh.map(x=>({...x,phase:'new'})),hotJobs,old.map(x=>({...x,phase:'recheck'}))];
 const out=[],seen=new Set(),weights=config.retrieval?.detail_mix||[3,3,1];
 while(queues.some(q=>q.length)){
  for(let slot=0;slot<Math.max(...weights);slot++)for(let k=0;k<queues.length;k++)if(slot<weights[k]){
   const item=queues[k].shift();if(item&&!seen.has(item.id)){seen.add(item.id);out.push(item);}
  }
 }
 return out;
}
function deliveryText(x){return [subject(x),x.title||'',x.desc||''].join('\n');}
function diversityOrder(rows){
 const sorted=[...rows].sort(compare),categories=['相机','手机','镜头','未知'];
 const byCategory=new Map(categories.map(k=>[k,[]]));
 for(const row of sorted){const category=categoryOf(deliveryText(row))||'未知';if(!byCategory.has(category))byCategory.set(category,[]);byCategory.get(category).push(row);}
 const queues=[...byCategory.values()].filter(x=>x.length).map(group=>roundRobin(group,x=>familyOf(deliveryText(x))));
 const out=[];for(let i=0;queues.some(q=>q.length>i);i++)for(const q of queues)if(q[i])out.push(q[i]);
 return out;
}
function sourceLane(x){
 if(x.type==='note')return x.source_is_merchant?'peer-note':'direct';
 if(x.type==='comment')return x.source_is_merchant?'peer':'organic';
 return 'status';
}
function familyCap(rows,settings){
 const share=Number(settings.model_family_soft_share)||0.3,min=Number(settings.family_cap_minimum_candidates)||10;
 if(rows.length<min)return {selected:rows,deferred:[]};
 const groups=new Map();for(const row of rows){const family=familyOf(deliveryText(row));if(family==='其他')continue;const list=groups.get(family)||[];list.push(row);groups.set(family,list);}
 const deferred=new Set();
 for(const group of groups.values()){
  const other=rows.length-group.length;if(!other)continue;
  const cap=Math.max(3,Math.floor(other*share/(1-share)));
  for(const row of group.slice(cap))deferred.add(row.key);
 }
 return {selected:rows.filter(x=>!deferred.has(x.key)),deferred:rows.filter(x=>deferred.has(x.key))};
}
function deliveryPicks(items,settings=config.delivery_priority||{},now=Date.now()){
 const excluded=settings.include_peer_leads===false?items.filter(x=>['peer','peer-note'].includes(sourceLane(x))):[];
 if(excluded.length){const keys=new Set(excluded.map(x=>x.key));items=items.filter(x=>!keys.has(x.key));}
 const maxPerSource=Number(settings.max_records_per_source_per_run)||5;
 const sourceCounts=new Map(),deferred=[];
 const takeSourceLimited=rows=>rows.filter(row=>{
  const count=sourceCounts.get(row.note_id)||0;
  if(count>=maxPerSource){deferred.push(row);return false;}
  sourceCounts.set(row.note_id,count+1);return true;
 });
 const direct=takeSourceLimited(diversityOrder(items.filter(x=>sourceLane(x)==='direct')));
 const organic=takeSourceLimited(diversityOrder(items.filter(x=>sourceLane(x)==='organic')));
 const balanced=familyCap([...direct,...organic],settings);deferred.push(...balanced.deferred);
 const nonPeer=balanced.selected;
 const peerSources=new Set(),peer=[];
 const ratio=Math.min(0.5,Math.max(0,Number(settings.peer_max_share)||0.2));
 const supplementalLimit=Math.max(0,Math.min(100,Number(settings.supplemental_max_per_run)||50));
 const peerLimit=Math.min(ratio<1?Math.floor(nonPeer.length*ratio/(1-ratio)):0,settings.supplemental_enabled?supplementalLimit:Infinity);
 const maxPeerSources=Number(settings.max_peer_sources_per_run)||2;
 for(const row of diversityOrder(items.filter(x=>sourceLane(x)==='peer'&&!settings.supplemental_enabled))){
  if(peer.length>=peerLimit){deferred.push(row);continue;}
  if(!peerSources.has(row.note_id)&&peerSources.size>=maxPeerSources){deferred.push(row);continue;}
  const count=sourceCounts.get(row.note_id)||0;
  if(count>=maxPerSource){deferred.push(row);continue;}
  peerSources.add(row.note_id);sourceCounts.set(row.note_id,count+1);peer.push(row);
 }
 // A merchant's own advertisement is never a customer-demand record. Keep it
 // deferred instead of silently deleting it; the normal suppression path may
 // retain the evidence separately.
 deferred.push(...items.filter(x=>sourceLane(x)==='peer-note'));
 const statuses=items.filter(x=>sourceLane(x)==='status');
 let supplemental=[];
 if(settings.supplemental_enabled){
  const limit=supplementalLimit;
  const selectedKeys=new Set([...nonPeer,...peer,...statuses].map(x=>x.key));
  const oldest=(a,b)=>(a.comment?.published_at_ms||a.published_at_ms||0)-(b.comment?.published_at_ms||b.published_at_ms||0)||String(a.key).localeCompare(String(b.key));
  const start=require('./hot-pools.cjs').start(config.recent_priority_calendar_days||3,now);
  const recent=x=>{const t=x.comment?.published_at_ms||x.published_at_ms;return Number.isFinite(t)&&t>=start&&t<=now;};
  const rows=items.filter(x=>sourceLane(x)==='peer');
  const fresh=diversityOrder(rows.filter(recent)),history=rows.filter(x=>!recent(x)).sort(oldest);
  const recentSlots=Math.ceil(limit*Math.min(1,Math.max(0,settings.recent_supplemental_share??0.7)));
  const take=(queue,count)=>{
   let n=0;for(const row of queue){
    if(n>=count||supplemental.length>=limit)break;
    if(selectedKeys.has(row.key))continue;
    const used=sourceCounts.get(row.note_id)||0;if(used>=maxPerSource)continue;
    sourceCounts.set(row.note_id,used+1);selectedKeys.add(row.key);supplemental.push({...row,delivery_lane:'supplemental'});n++;
   }
  };
  // Reserve both recent and historical capacity; unused slots can be borrowed.
  take(fresh,recentSlots);take(history,limit-recentSlots);take(fresh,limit);take(history,limit);
  deferred.push(...rows.filter(x=>!selectedKeys.has(x.key)));
  const chosen=new Set([...peer,...supplemental].map(x=>x.key));
  for(let i=deferred.length-1;i>=0;i--)if(chosen.has(deferred[i].key))deferred.splice(i,1);
 }
 const peers=settings.supplemental_enabled?peer.map(x=>({...x,delivery_lane:'supplemental'})):peer;
 return {excluded,selected:[...nonPeer,...peers,...supplemental,...statuses],supplemental:peers.length+supplemental.length,deferred:[...new Map(deferred.map(x=>[x.key,x])).values()]};
}
function presentationOrder(items){
 const direct=diversityOrder(items.filter(x=>sourceLane(x)==='direct'));
 const organic=diversityOrder(items.filter(x=>sourceLane(x)==='organic'));
 const peer=diversityOrder(items.filter(x=>sourceLane(x)==='peer'));
 const statuses=items.filter(x=>sourceLane(x)==='status');
 return [...direct,...organic,...peer,...statuses];
}
function rechecks(notes,limit){
 const attempted=v=>Math.max(Date.parse(v.last_checked||'')||0,Date.parse(v.last_attempted||'')||0);
 const rows=Object.entries(notes).filter(([,v])=>v.token),oldest=(a,b)=>attempted(a[1])-attempted(b[1]);
 const active=rows.filter(([,v])=>Date.parse(v.last_activity_at||0)>Date.now()-3*86400000).sort(oldest);
 const picked=active.slice(0,Math.floor(limit/2)),ids=new Set(picked.map(([id])=>id));
 return [...picked,...rows.filter(([id])=>!ids.has(id)).sort(oldest)].slice(0,limit).map(([id,v])=>({id,token:v.token,title:v.title||'',recheck:true}));
}
function broadCandidate(text){return /租|借|求|蹲|有.{0,16}(吗|么)|how\s*much|多少|什么价|问问/i.test(text)&&!/招聘|租房|办公室|汽车租赁/.test(text);}
module.exports={devices,queryModels,inventoryMatches,subject,tier,compare,queries,rechecks,broadCandidate,categoryOf,familyOf,modelPools,buildModelPools,excludedSearchModel,freshPicks,searchOrder,detailOrder,deliveryPicks,presentationOrder,sourceLane};
