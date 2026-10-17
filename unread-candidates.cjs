// Unread search cards share the existing watchlist and never count as leads.
const {freshPicks}=require('./rental-strategy.cjs');
const {peerExcluded}=require('./lead-fields.cjs');
function remember(watch,items,now=Date.now(),days=10){
 watch.pending_details||={};let expired=0;
 for(const [id,x] of Object.entries(watch.pending_details)){
  if(watch.notes?.[id]?.last_checked)delete watch.pending_details[id];
  else if(Date.parse(x.first_discovered_at)<now-days*86400000){delete watch.pending_details[id];expired++;}
 }
 for(const item of items){
  if(item.known||watch.notes?.[item.id]?.last_checked)continue;
  const previous=watch.pending_details[item.id];
  watch.pending_details[item.id]={...item,...(previous?{first_discovered_at:previous.first_discovered_at,last_attempted:previous.last_attempted}:{first_discovered_at:new Date(now).toISOString()})};
 }
 return expired;
}
function picks(watch,limit,roundStarted){
 const rows=Object.values(watch.pending_details||{}).filter(x=>!peerExcluded({type:'note',note_id:x.id,...x},watch)).filter(x=>!(Date.parse(watch.detail_health?.[x.id]?.next_attempt_at)>roundStarted)).sort((a,b)=>(Date.parse(a.last_attempted||'')||0)-(Date.parse(b.last_attempted||'')||0)||Date.parse(a.first_discovered_at)-Date.parse(b.first_discovered_at));
 const carried=rows.filter(x=>Date.parse(x.first_discovered_at)<roundStarted),current=rows.filter(x=>Date.parse(x.first_discovered_at)>=roundStarted);
 const selected=new Set();let merchants=0;
 const take=(list,count)=>freshPicks(list.filter(x=>!selected.has(x.id)&&(!x.merchant||x.demand||merchants<2)),list.length).filter(x=>{
  if(count<=0||x.merchant&&!x.demand&&merchants>=2)return false;
  if(x.merchant&&!x.demand)merchants++;selected.add(x.id);count--;return true;
 });
 const old=take(carried,Math.ceil(limit/3)),fresh=take(current,limit-old.length);
 fresh.push(...take(current,limit-old.length-fresh.length));old.push(...take(carried,limit-old.length-fresh.length));
 const result=[];while(fresh.length||old.length){result.push(...fresh.splice(0,2),...old.splice(0,1));}
 return result;
}
module.exports={remember,picks};
