const fs=require('node:fs');
const path=require('node:path');
const config=JSON.parse(fs.readFileSync(path.join(__dirname,'monitor-config.json'),'utf8'));
const {devices,inventoryMatches}=require('./rental-strategy.cjs');
const registryPath=path.join(__dirname,'merchant-registry.json');
const merchantRegistry=fs.existsSync(registryPath)?JSON.parse(fs.readFileSync(registryPath,'utf8')).authors||{}:{};
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const models=[...config.model_terms,'VIVOX300ULTRA','VIVOX200ULTRA','X300ULTRA','X200ULTRA','400增距镜','GR3X HDF','GR3 HDF','GR4 HDF','pocket4 pro','p4','4p','p3','R6II','R6二代','M200','CCD','拍立得','小痰盂'].sort((a,b)=>b.length-a.length);
const modelPattern=new RegExp('(?:'+models.map(escape).join('|')+')(?=$|[^a-z0-9])','ig');
const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g,'');
function fields(text){
 const evidence=String(text||'');
 const matches=[...evidence.matchAll(modelPattern),...evidence.matchAll(/(?:RF|XF|Z)?\d{2,3}\s*[-—]\s*\d{2,3}(?:\s*(?:mm|F[\d.]+))?/ig)].map(m=>m[0]);
 const device=[...new Set(matches)].join('、')||'未知';
 const location=evidence.match(/深圳|广州|昆明|固原|普吉岛|江南大学|川大望江|华西|中山大学深圳|景德镇|许昌|郑州|上海|北京|成都|杭州|南京|无锡|天津|武汉|长沙|厦门|盐城|重庆|济南|苏州|西安|哈尔滨|长春|沈阳|青岛|东莞|佛山|伦敦/);
 const rentalMatches=[...evidence.matchAll(/(?<![\d.])(?:1[0-2]|0?[1-9])[月./](?:3[01]|[12]\d|0?[1-9])(?:日|号)?(?:\s*(?:到|至|[-—~～])\s*(?:(?:1[0-2]|0?[1-9])[月./])?(?:3[01]|[12]\d|0?[1-9])(?:日|号)?)?(?!\d)|(?:\d{1,2}[.、]\d{1,2}号)|(?:\d{1,2}(?:日|号))|(?:\d+\s*天)|(?:三|两|一|四|五|六|七)天|今晚|明天|周末|国庆|十一/g)].map(m=>m[0]);
 const normalized=norm(evidence);
 const matched=inventoryMatches(evidence);
 return {device,location:location?.[0]||'未知',rental_period:[...new Set(rentalMatches)].join('；')||'未知',evidence,matched_catalog:matched};
}
function merchant(author,id,text=''){
 if(id&&merchantRegistry[id])return true;
 if(/^\s*\d+(?:\.\d+)?\s*(?:元|块)?\s*(?:一|两|二|三|\d)天\s*(?:哦|哈|呀|元|块)?\s*[。.!！]?\s*$/.test(text))return true;
 if(/短期出租|接单|想租.{0,8}抓紧|配件全套/.test(text))return true;
 if(!/[?？吗么]|多少|怎么/.test(text)&&/(一|两|二|三|\d)天[^，。]{0,8}(一共|合计|共)\s*\d+/.test(text))return true;
 return (config.merchant_author_ids||[]).includes(id)||(config.merchant_names||[]).includes(author)||/租赁|出租|租机|租相机|相机铺|相机店|免押租/.test(author||'')||/自用.{0,6}可租|个人可租|租给你|找我租|联系我们|档期充足|全套配件|机型大合集|现货|来租不|先到先得/.test(text)||(/我的.{0,6}自用|我有|我这边/.test(text)&&/\d+\s*(?:元|块)?\s*(?:一|两|二|三|\d)天/.test(text));
}
function insufficientComment(text){
 const t=String(text||'').trim();
 if(/^(?:不用|无需|不需要)(?:缴纳|交|缴)?押金[。.!！]?$/.test(t))return true;
 if(/^@[^\s]+(?:\s*@[^\s]+)*$/.test(t))return true;
 if(/我觉得|我认为|我感觉|建议你|推荐你/.test(t)&&!/求租|想租|要租|需要租|能租吗|怎么租/.test(t))return true;
 return /^(?:蹲|蹲蹲|蹲一下|同蹲)(?:\[[^\]]*\]|[\s!！。])*$/u.test(t)||(/我租的|我已经租|我已租到|已经租到了/.test(t)&&!/还没|没租到|还想租|还需要租/.test(t));
}
function sourceMerchant(x,watch={},observed=new Map()){
 const saved=watch.notes?.[x.note_id],seen=observed instanceof Map?observed.get(x.note_id):null;
 if(x.source_is_merchant||x.is_merchant_post||x.manual_merchant||saved?.manual_merchant||saved?.is_merchant_post||seen?.is_merchant_post)return true;
 // A known merchant author remains excluded even when their post asks to rent.
 if(merchant(x.author,x.author_id,'')||merchant(saved?.author,saved?.author_id,'')||merchant(seen?.author,seen?.author_id,''))return true;
 if(x.is_demand_post||x.demand||saved?.is_demand_post||seen?.is_demand_post)return false;
 const title=x.title||saved?.title||seen?.title||'',desc=x.desc||saved?.desc||seen?.desc||'';
 const text=title+'\n'+desc;
 return merchant(x.author||saved?.author||seen?.author,x.author_id||saved?.author_id||seen?.author_id,text)||Boolean(x.merchant)||/出租|租赁|档期充足|免押|包邮|门店|实体店|现货|接单|仓库|店铺|专业出租|平价|可租可买|早订|提前预定|特价|优惠|机型大合集|自用.{0,6}可租/.test(text);
}
function peerExcluded(x,watch={},observed=new Map(),settings=config.delivery_priority||{}){
 return settings.include_peer_leads===false&&['note','comment'].includes(x.type)&&sourceMerchant(x,watch,observed);
}
module.exports={fields,config,merchant,insufficientComment,sourceMerchant,peerExcluded};
