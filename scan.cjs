/**
 * 小红书求租线索采集 v3（定时复用版）
 * 只读：仅调用 /api/v1/feeds/search 与 /api/v1/feeds/detail。不做点赞/评论/关注/收藏/发布/私信。
 *
 * v3 相比 v2 新增：
 *   1) 老帖回访：对 watchlist.json 里已看过的帖子重新拉详情
 *   2) 新增评论识别：以 watchlist 的 seen 集合为基线，标出「上次之后新出现的评论」
 *   3) 评论求租意图判定：poster(帖主仍在求) / consumer(他人求租) / supply(同行) / resolved(已解决)
 *
 * 用法:
 *   node scan.cjs [--days 3] [--out PATH] [--max-detail 12] [--recheck-max 25] [--no-recheck]
 */
const fs = require('node:fs');
const path = require('node:path');
const {fields,config,merchant,insufficientComment}=require('./lead-fields.cjs');
const strategy=require('./rental-strategy.cjs');
const hot=require('./hot-pools.cjs');
const {read:readMcp}=require('./mcp-readonly.cjs');
const requestEvents=[];
let requestDeadline=Infinity;
const REVIEW_VERSION='inventory-intent-v4-ten-days';

const BASE = __dirname;
const TOOLS = process.env.XHS_MCP_HOME || path.join(require('node:os').homedir(), '.local/share/duoyin-bot/xiaohongshu-mcp-v2.5.0');

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const DAYS = Number(arg('days', String(config.freshness_calendar_days)));
const OUT = arg('out', path.join(BASE, 'scan-latest.json'));
const MAX_DETAIL = Number(arg('max-detail', String(config.max_new_details_per_run)));
const RECHECK_MAX = Number(arg('recheck-max', String(config.max_rechecks_per_run)));
const RECHECK = !process.argv.includes('--no-recheck');
const WATCH_PATH = arg('watchlist', path.join(BASE, 'watchlist.json'));

const token = fs.readFileSync(path.join(TOOLS, 'private/api-token'), 'utf8').trim();

const START = Math.floor((Date.now()+8*3600000)/86400000)*86400000-8*3600000-(DAYS-1)*86400000;
const END = Date.now();
const inWin = t => Number.isFinite(t) && t >= START && t <= Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

// ---------- 词表 ----------
const LEGACY_KEYWORDS = (arg('keywords', '') || [
  // ① 需求侧直给
  '求租 相机', '想租相机', '租相机 推荐', '求租 拍立得', '同城 租相机',
  '十一 租相机', '国庆 租相机', '租相机 多少钱',
  // ② 客户常用口径（用户补充）——这些词既找帖，也用来挖评论区里的需求者
  '免押 租相机', '相机 租金', '租相机 自提', '租相机 邮寄',
  '周末 租相机', '旅游 租相机', '演唱会 租相机', '租 镜头', '租 机身',
].join(',')).split(',').map(s => s.trim()).filter(Boolean);
let KEYWORDS=[];

// 帖子级：是否"求租帖"（要求明确的求租口吻；**不能只因为标题里有"租相机"就算**）
const RE_DEMAND = /求租|想租|要租|需要租|想要租|求推荐.{0,10}(相机|租|机)|求.{0,4}租|哪里(能|可以|有).{0,6}租|在哪.{0,4}租|哪儿.{0,4}租|有没有.{0,8}租|想找.{0,8}(相机|机子|设备)|租.{0,4}(一台|一个|一部|几天|一天)|蹲.{0,6}(相机|机)|求带|(急|求|想|需要|请问)[^，。！？]{0,8}租|租[^，。！？]{0,6}(急|加急)/i;
// 明确求租措辞 —— 优先级**高于**商家标记（正文写了"求租拍摄设备"就是真需求，哪怕标题带 #相机租赁#）
const RE_DEMAND_EXPLICIT = /求租|求推荐.{0,6}(相机|租|设备)|哪里(能|可以|有).{0,4}租|有没有.{0,4}租|求带|蹲.{0,4}(相机|机)/;
// 裸标题求租：标题就是「租相机」「想租相机」这种极短形态（不含广告词）
const RE_TITLE_BARE_RENT = /^(想租|要租|求租|租)[\u4e00-\u9fa5a-zA-Z0-9]{0,5}$/;
// 商家/广告特征（**要看标题+正文**，不能只看标题 —— 有商家把广告全写在正文里）
const RE_MERCHANT = /出租|租赁|租机|档期|免押|包邮|门店|实体店|实体|现货|接单|仓库|店铺|租赁店|专业出租|平价|看这里|我只来这家|可租可买|抓紧|先到先得|早订|提前预定|特价|优惠|学生证|机型大合集|自用.{0,6}可租|可租|跟拍报价/i;
// 「已解决」——必须区分「已经租到」和「还没租到」（后者是需求，不是失效）
const RE_RESOLVED = /已经租到|租到了|已租到|租到合适|租好啦|已经租了|已经租好|已租好|买到了|已经买了|不用了|不用啦|找到合适的|已解决|搞定啦/i;
const resolved=t=>!/(还没|没|没有|尚未|未能).{0,5}(租到|租好|找到|解决)/.test(t)&&RE_RESOLVED.test(t);
function demandPost(title,desc,author='',authorId=null){
 const text=title+'\n'+desc;
 if(merchant(author,authorId,text))return false;
 if(/有没有想租|谁要租|想租.*抓紧|有没有.*宝子.*租/.test(title))return false;
 const explicit=/求租|想租一|想租个|想租相机|要租一|需要租|求一个相机|在哪租|哪里.{0,4}租|什么平台租|租.{0,3}实测|会好好爱护相机/.test(text);
 const supply=/实体门店|联系我们|找我租|租给你|我有.{0,8}(相机|设备)|可以滴滴我|档期充足|全套配件|机型大合集|一站式|现货|来租不|日租.*[0-9]|先到先得/.test(text)||RE_MERCHANT_NAME.test(author);
 if(supply)return false;
 if(/出租|租赁/.test(title)&&!explicit)return false;
 return explicit||/^求租|^租相机$|^租大疆$/.test(title)||(/想租|求.{0,6}租/.test(text)&&!supply);
}
// 短促求租口吻，如「租大疆」「租个pocket3」
// 负向先行断言必须带上「个人/可租/自用」等供给前置词，否则「个人可租4p免押」会被当成求租
const RE_SHORT_DEMAND = /^(?!租金|租赁|租期|租约|出租|租房|个人|可租|自用)[^，。！？]{0,8}租[^赁金约]/;

// 评论侧：明确求租意图（强）
const RE_INTENT_STRONG = /求租|想租|要租|需要租|想找.{0,8}(相机|机子|设备)|求一个|求个|求台|求一台|求一部|蹲一个|蹲个|求推荐|求带|求借|想借|有没有.{0,8}租|哪里.{0,6}租|在哪租|哪儿租|找.{0,6}租|租.{0,4}(一台|一个|一部|几天)|还没租到|没租到/i;
// 评论侧：询价/问档期/问流程（弱，但仍是需求信号）—— 客户才会问这些
const RE_INTENT_ASK = /多少钱|怎么租|怎么弄|怎么约|怎么订|怎么下|价格|贵吗|多钱|啥价|什么价|问价|报价|有吗|有么|有没有|还有吗|能租吗|可以租吗|可以吗|行吗|日租|几天|一天|哪天|几号|押金|问下|问问|蹲|推荐|档期|机位|预约|预定|下单|联系/i;
// 评论侧：同行供给特征（第一人称招揽，命中即判供给）
const RE_SUPPLY_FIRSTPERSON = /我有|我都有|我也有|我这边|我们(家|店)|可以租给|租给你|帮你留|找我|私聊|私信|丝我|思我|私我|加我|dd我|滴滴|走\s*pt|走\s*平台|发货|现货|门店|实体|自提点|档期充足|可安排|支持邮寄|发全国|全国可发|次日达|隔天到|价格便宜|押金便宜|小磕小碰|全新|机子|优惠|个人可租|自用.{0,6}可租|可租给/i;
// 同行"反问式"话术：商家套客户机型/档期，如「宝宝想租什么机型呀」「租期几号到几号呢」
const RE_MERCHANT_COUNTER = /(想|要|需要)[^，。！？]{0,3}租[^，。！？]{0,4}(什么|哪)(型号|机型|机子|相机)|(宝宝|宝子|亲|姐妹|小宝)[^，。！？]{0,6}(想租|要租|需要)[^，。！？]{0,8}(呀|呢|吗|嘛|\?|？)|(租期|几号到几号|什么时候用|什么时候使)/i;
// 评论侧：在问「租的条件」，这是需求者才会问的（免押/自提/邮寄/租金…）
const RE_ASK_TERMS = /(免押|押金|自提|邮寄|包邮|租金|价格|运费|快递|能送|到付)[^，。！？]{0,6}(吗|嘛|么|多少|怎么|如何|\?|？)|(能|可以|能不能|可不可以|支持|接受)[^，。！？]{0,4}(免押|自提|邮寄|包邮|送货|到付)|租金(多少|怎么算)|押金(多少|怎么)/i;
// 评论侧：一般供给/商家话术（非第一人称，作为辅助判定）
const RE_SUPPLY = /我有|我都有|我也有|可以租给|租给你|帮你|门店|实体|出租|租赁|顺丰|包邮|免押|自提|发货|现货|档期充足|找我|私聊|私信|丝我|思我|私我|加我|dd我|滴滴|走平台|走pt|日租\s*\d|全新|机子|押金便宜|优惠|价格便宜|小磕小碰|发全国|全国可发|可安排|支持邮寄|次日达|隔天到/i;
const RE_MERCHANT_NAME = /租赁|出租|租机|租相机|相机铺|数码|影像|陪拍|装备|驿站|摄影|ccd|相机店|租乐|免押|租物/i;
// 「报机型」型同行：简短的机型 + 可以吗/行吗
const RE_OFFER_MODEL = /(佳能|索尼|尼康|富士|理光|松下|大疆|影石|insta|pocket|ccd|ixus|g7x|g11|r50|r62|r7|r8|r10|a7|z50|z62|sx70|x100|gr3|gr2)[^，。]{0,10}(可以吗|行吗|可以嘛|要不|考虑吗|需要吗)/i;

// ---------- 请求 ----------
async function call(endpoint, body) {
  return readMcp(endpoint,body,{token,deadline:requestDeadline,interval_ms:config.request_interval_ms,onAttempt:event=>{
    requestEvents.push(event);
    fs.appendFileSync(path.join(BASE,'mcp-requests.jsonl'),JSON.stringify(event)+'\n',{mode:0o600});
    if(event.status==='failed')console.log(`[MCP ${endpoint}] 第${event.attempt}次失败：${event.code} / ${event.details}`);
    else if(event.attempt>1)console.log(`[MCP ${endpoint}] 有限重试后恢复成功`);
  }});
}

function flatten(list, parent = null, out = []) {
  for (const it of list || []) {
    const ui = it.userInfo || it.user_info || {};
    out.push({
      id: it.id, parent_id: parent,
      author: ui.nickname, author_id: ui.userId || ui.user_id,
      ip: it.ipLocation || it.ip_location || '',
      text: it.content, published_at_ms: it.createTime || it.create_time,
      parent_text: parent ? out.find(c=>c.id===parent)?.text||'' : '',
      in_window: inWin(it.createTime || it.create_time),
    });
    flatten(it.subComments || it.sub_comments, it.id, out);
  }
  return out;
}

// 帖主自己的话也要带需求特征才算（否则「来啦」「还有宝丽来go3哦」这种闲聊/带货会被当成求租）
const RE_POSTER_DEMAND = /\d|求租|想租|要租|需要|还没|没租|有推荐|推荐|哪里|有没有|多少钱|怎么|档期|几天|一天|几号|[\?？]/;

/** 帖子级双标记：是否求租帖 / 是否商家广告帖（判定只写一处，扫描与复核共用） */
function postFlags(title, desc) {
  const body = (title || '') + '\n' + (desc || '');
  const isMerchantPost = RE_MERCHANT.test(body);
  const demandCue = RE_DEMAND.test(body) || RE_TITLE_BARE_RENT.test((title || '').trim());
  const isDemandPost = RE_DEMAND_EXPLICIT.test(body) || (demandCue && !isMerchantPost);
  return { isDemandPost, isMerchantPost };
}

/** 评论的求租意图判定
 *  顺序很关键：先排同行（第一人称招揽 / 商家账号名 / 报机型），
 *  再识别「在问租的条件」（免押/自提/邮寄/租金 —— 这是需求者才会问的），
 *  最后才是泛问句。顺序错了会把商家的反问当成需求方（踩过坑）。
 */
function classifyComment(c, isAuthor, isDemandPost) {
  const t = (c.text || '').trim();
  const author = c.author || '';
  if(merchant(author,c.author_id,t))return 'supply';
  if(insufficientComment(t))return 'other';
  if (resolved(t)) return 'resolved';
  // 1) 同行：第一人称招揽最硬，先排
  if (RE_SUPPLY_FIRSTPERSON.test(t)) return 'supply';
  // 2) 商家账号名 / 报机型 / 反问式套话
  if (RE_MERCHANT_NAME.test(author)) return 'supply';
  if (RE_OFFER_MODEL.test(t)||/(?:M200|M50|SX740|IXUS\d+|R\d+|XT\d+).{0,6}(可以吗|要吗|考虑吗)/i.test(t)||/(还有档期|可免押|相机租赁|全新|配件配齐)/.test(t)) return 'supply';
  if (RE_MERCHANT_COUNTER.test(t)) return 'supply';
  // 3) 帖主在自家求租帖下继续追问 —— 需求明确
  if (isAuthor && isDemandPost) return 'poster';
  if (!isAuthor && /(?:有|问问|求).{0,24}(?:吗|么|\?|？)|how\s*much/i.test(t) && !RE_SUPPLY_FIRSTPERSON.test(t)) return 'demand-weak';
  // 4) 明确求租口吻（含「租大疆」这类短促求租）
  if (RE_INTENT_STRONG.test(t)) return 'demand-strong';
  if (RE_SHORT_DEMAND.test(t) && t.length <= 10) return 'demand-strong';
  // 5) 在问租赁条件（免押/自提/邮寄/租金）或询价、问档期
  if (RE_ASK_TERMS.test(t) || RE_INTENT_ASK.test(t)) return 'demand-weak';
  // 6) 兜底：非第一人称的供给话术
  if (RE_SUPPLY.test(t)) return 'supply';
  return 'other';
}

// ---------- 复核模式：规则改了，拿已有结果重新判定（不用重新爬）----------
// node scan.cjs --reclassify [--scan PATH]
if (process.argv.includes('--reclassify')) {
  const file = arg('scan', path.join(BASE, 'scan-latest.json'));
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = 0, total = 0;
  for (const n of d.notes || []) {
    if (n.error) continue;
    n.is_demand_post = RE_DEMAND.test((n.title || '') + '\n' + (n.desc || ''));
    n.is_merchant_post = RE_MERCHANT.test(n.title || '');
    for (const s of n.signals || []) {
      total++;
      const k = classifyComment(s, s.is_author, n.is_demand_post);
      if (k !== s.kind) changed++;
      s.kind = k;
    }
  }
  d.reclassified_at = nowIso();
  fs.writeFileSync(file, JSON.stringify(d, null, 2), { mode: 0o600 });
  console.log(`复核完成：${total} 条评论重判，${changed} 条分类变化 → ${file}`);
  process.exit(0);
}

// ---------- 自测：评论求租意图判定回归 ----------
// node scan.cjs --selftest
if (process.argv.includes('--selftest')) {
  const CASES = [
    // [评论内容, 评论者昵称, 是否帖主, 帖主是否求租帖, 期望意图]
    ['租大疆', '小红薯6881E012', false, false, 'demand-strong'],
    ['周末想租个相机拍娃', '小鱼', false, false, 'demand-strong'],
    ['多少钱一天呀', 'momo', false, false, 'demand-weak'],
    ['可以免押吗', '奶糖', false, false, 'demand-weak'],
    ['能邮寄吗 我在哈尔滨', '阿远', false, false, 'demand-weak'],
    ['支持自提吗', '可可', false, false, 'demand-weak'],
    ['租金怎么算', '小周', false, false, 'demand-weak'],
    ['25-27租三天4p', '帖主本人', true, true, 'poster'],
    ['还没租到，有推荐吗', '帖主本人', true, true, 'poster'],
    ['租到合适的了谢谢大家', '帖主本人', true, true, 'resolved'],
    ['我这边有机子 免押顺丰', '相机租赁铺', false, false, 'supply'],
    ['佳能r50可以吗', '数码影像店', false, false, 'supply'],
    ['宝宝什么想租什么机型呀', '租赁驿站', false, false, 'supply'],
    ['我有货 可以租给你', 'Xwxn888', false, false, 'supply'],
    ['哈哈哈哈', 'momo', false, false, 'other'],
    ['还没租到，谢谢大家', '帖主本人', true, true, 'poster'],
    ['谢谢大家，还是想租广州的', '帖主本人', true, true, 'poster'],
    ['M200可以吗', '咪哆咪哆', false, false, 'supply'],
    ['x3还有档期', '悦肯', false, false, 'supply'],
    // —— 以下为 2026-09-18 首轮 3 小时巡检中实际踩到的硬骨头 ——
    ['怎么预约呀', '小能', false, false, 'demand-weak'],          // 客户问流程 = 需求
    ['问价', '无面不活', false, false, 'demand-weak'],            // 问价 = 需求
    ['个人可租4p免押', 'Tokkau', false, false, 'supply'],         // "个人可租" 是供给
    ['南三环可租，走 pt', '布丁', false, false, 'supply'],         // 走pt（带空格）
    ['宝宝想租什么机型呀', '大敏星租个相机去看海', false, false, 'supply'], // 商家反问
    ['顺丰邮寄接受吗', '金喜派送中', false, false, 'demand-weak'],  // 客户问邮寄
    ['M200可以吗', '咪哆咪哆', false, false, 'supply'],           // 已核对原帖：在求租帖下提供其他型号
    ['x3还有档期', '悦肯', false, false, 'supply'],               // 已核对原帖：提供空余档期
    ['想租相机吗，自用相机可租', '芝士小鱼饼🧀', false, false, 'supply'],
    ['求租相机', '小屿📸租赁', false, false, 'supply'],
    ['我的自用全能套装，169一天219两天哦', 'loel', false, false, 'supply'],
    ['我租的10.2 160一天vivox300u', 'qqw', false, false, 'other'],
    ['蹲蹲', '鸭梨', false, false, 'other'],
    ['有大疆4p吗', '普通客户', false, false, 'demand-weak'],
    ['19号有rf400的镜头吗', '普通客户', false, false, 'demand-weak'],
    ['how much', '普通客户', false, false, 'demand-weak'],
    ['周末想租手机演唱会用', '普通客户', false, false, 'demand-strong'],
  ];
  let ok = 0;
  for (const [text, author, isAuthor, isDemandPost, expect] of CASES) {
    const got = classifyComment({ text, author }, isAuthor, isDemandPost);
    const pass = got === expect;
    if (pass) ok++;
    console.log(`  ${pass ? '✅' : '❌'} 期望 ${expect.padEnd(14)} 实际 ${got.padEnd(14)} ${author}｜${text}`);
  }
  console.log(`回归通过 ${ok}/${CASES.length}`);
  const ads=[['温州附近有没有想租相机的','全程走pt','炭酸日和',false],['求租大疆','24号拿到27号送回','小鱼',true],['厦门租相机巨平价','信用免押','小屿租赁',false],['会好好爱护相机 有意出租','9.29收到 10.7归还','momo',true],['想租相机？','自用相机可租✅','芝士小鱼饼🧀',false]];
  for(const [title,desc,author,expect] of ads){if(demandPost(title,desc,author)!==expect){console.error('帖子分类回归失败：'+title);process.exit(1);}}
  process.exit(ok === CASES.length ? 0 : 1);
}

// ---------- 主流程 ----------
(async () => {
  const watch = fs.existsSync(WATCH_PATH) ? JSON.parse(fs.readFileSync(WATCH_PATH, 'utf8')) : { notes: {} };
  const wnotes = watch.notes || (watch.notes = {});
  watch.outbox ||= {};
  watch.query_cursor ||= 0;
  const history=JSON.parse(fs.readFileSync(path.join(BASE,'leads-history.json'),'utf8'));
  const restored=hot.restoreExpired(watch,history,{...config,freshness_calendar_days:DAYS});
  const queryPlan=process.argv.includes('--keywords')?LEGACY_KEYWORDS.map(keyword=>({keyword,kind:'manual'})):strategy.queries(watch);
  KEYWORDS=queryPlan.map(x=>x.keyword);
  const searchPlan=strategy.searchOrder(queryPlan.map(x=>({...x,query_kind:x.kind,kind:'latest',sort_by:config.sort_by,publish_time:config.publish_time})),hot.plans(watch,config));

  const state = {
    window_days: DAYS, started_at: nowIso(),
    searches: [], notes: [], requests:requestEvents,complete: false,
    rechecked: 0, new_comments_found: 0,window_start:new Date(START).toISOString(),warnings:[],restored_expired:restored,search_plan:searchPlan,
  };
  const save = () => fs.writeFileSync(OUT, JSON.stringify(state, null, 2), { mode: 0o600 });
  const deadline=Date.now()+(config.max_scan_seconds||900)*1000;
  const searchDeadline=Math.min(deadline,Date.now()+(config.max_search_seconds||config.max_scan_seconds||900)*1000);
  requestDeadline=searchDeadline;
  save();

  // ---- 阶段 1：搜索新候选 ----
  const uniq = new Map();
  for (const plan of searchPlan) {
    const {keyword}=plan;
    if(Date.now()+125000>searchDeadline){state.warnings.push('本轮搜索时间预算已达上限，剩余搜索未执行；保留时间读取详情与评论');break;}
    try {
      const res = await call('search', { keyword, filters: { sort_by: plan.sort_by, publish_time: plan.publish_time } });
      const feeds = res.feeds || [];
      state.searches.push({ ...plan, count: feeds.length, feeds });
      for (const f of feeds) {
        if (plan.kind==='latest'&&!uniq.has(f.id)) uniq.set(f.id, {...f,search_category:plan.category});
        if(wnotes[f.id]&&f.xsecToken)wnotes[f.id].token=f.xsecToken;
      }
      console.log(`[search] ${keyword} → ${feeds.length} 条 (累计唯一 ${uniq.size})`);
    } catch (e) {
      state.searches.push({ ...plan, error: String(e.message) });
      console.log(`[search] ${keyword} → 放弃 ${e.message}`);
      if(e.restricted){watch.paused={reason:'访问限制或验证码',at:nowIso()};fs.writeFileSync(WATCH_PATH,JSON.stringify(watch,null,2),{mode:0o600});throw e;}
      state.warnings.push('搜索失败：'+keyword+' / '+e.message);
      if(e.backend_unavailable){save();throw e;}
    }
    save();
  }
  state.search_unique = uniq.size;
  requestDeadline=deadline;
  if(config.hot_pool?.enabled)hot.update(watch,config,state.searches);
  fs.writeFileSync(WATCH_PATH,JSON.stringify(watch,null,2),{mode:0o600});
  watch.query_cursor=(watch.query_cursor+KEYWORDS.length)%config.queries.length;

  const items = [...uniq.values()].map(f => {
    const nc = f.noteCard || {};
    return {
      id: f.id, token: f.xsecToken, title: nc.displayTitle || '',
      author: nc.user?.nickname || '',
      demand: demandPost(nc.displayTitle||'','',nc.user?.nickname||'',nc.user?.userId),
      known: !!wnotes[f.id],
      inventory_match:strategy.inventoryMatches(nc.displayTitle||'').length>0,
      category:f.search_category,
      merchant:RE_MERCHANT.test(nc.displayTitle||''),
    };
  });
  state.pool = {
    total: items.length,
    demand: items.filter(i => i.demand).length,
    merchant: items.filter(i => !i.demand && RE_MERCHANT.test(i.title)).length,
    already_watched: items.filter(i => i.known).length,
  };
  console.log(`[pool] 唯一 ${items.length}｜求租帖 ${state.pool.demand}｜商家帖 ${state.pool.merchant}｜已回访过 ${state.pool.already_watched}`);
  save();

  // 首次发现的帖子：优先求租帖
  const picked = strategy.freshPicks(items,MAX_DETAIL);
  const seenPick = new Set();

  // ---- 阶段 2：老帖回访（按"最近发布"优先，求租帖优先）----
  let recheckList = [];
  if (RECHECK) {
    const hotIds=new Set(Object.values(watch.hot_pools||{}).flatMap(p=>p.member_ids));
    recheckList = strategy.rechecks(Object.fromEntries(Object.entries(wnotes).filter(([id])=>!hotIds.has(id))),RECHECK_MAX);
    console.log(`[recheck] 待回访 ${recheckList.length} 篇（清单共 ${Object.keys(wnotes).length} 篇）`);
  }

  const jobs=strategy.detailOrder(picked,hot.jobs(watch,config),recheckList);
  state.detail_plan=jobs.map(({id,phase,category})=>({id,phase,category}));
  state.hot_pools=hot.coverage(watch,config,state.notes);save();

  for (const it of jobs) {
    if(Date.now()+125000>deadline){state.warnings.push('本轮采集时间预算已达上限，剩余帖子未读取；下轮按回访轮换继续');break;}
    if (seenPick.has(it.id)) continue;
    seenPick.add(it.id);
    if (!it.token) {
      state.notes.push({ note_id: it.id, title: it.title, error: 'NO_TOKEN' });
      console.log(`[${it.phase}] ${(it.title || it.id).slice(0, 22)} → 缺 xsec_token，跳过`);
      continue;
    }
    // 新帖里已经在本轮回访中处理过的，不重复
    const already = state.notes.find(n => n.note_id === it.id);
    if (already) continue;

    try {
      if(wnotes[it.id])wnotes[it.id].last_attempted=nowIso();
      if(watch.hot_candidates?.[it.id])watch.hot_candidates[it.id].last_attempted=nowIso();
      const commentLimit=hot.commentLimit(wnotes[it.id],config);
      const res = await call('detail', {
        feed_id: it.id, xsec_token: it.token, load_all_comments: true,
        comment_config: { click_more_replies: true, max_replies_threshold: config.max_replies_threshold, max_comment_items: commentLimit, scroll_speed: 'normal' },
      });
      const payload = res.data || res;
      const note = payload.note;
      if (!note) throw new Error('NO_NOTE');
      const cm = payload.comments || {};
      const comments = flatten(cm.list);
      const title = note.title || '';
      const body = title + '\n' + (note.desc || '');
      const isDemand = demandPost(title,note.desc||'',note.user?.nickname||'',note.user?.userId);

      const prev = wnotes[note.noteId];
      const prevSeen = prev?.seen || {};
      const isRecheck = !!prev;                 // 之前看过 = 回访
      let newCount = 0;

      const signals = comments.map(c => {
        const isAuthor = c.author_id === (note.user && note.user.userId);
        const isNew = !prevSeen[c.id];           // 基线里没有 = 新出现的评论
        if (isNew) newCount++;
        return {
          ...c, is_author: isAuthor, is_new: isNew,
          kind: classifyComment(c, isAuthor, isDemand),
        };
      });
      const isResolved=signals.some(s=>s.is_author&&s.kind==='resolved')||resolved(body);
      const ownText=signals.filter(s=>s.is_author&&s.kind==='poster').map(s=>s.text).join('\n');
      const extracted=fields(body+'\n'+ownText);
      const url='https://www.xiaohongshu.com/explore/'+note.noteId+'?xsec_token='+encodeURIComponent(note.xsecToken||it.token)+'&xsec_source=pc_search';
      const sourceIsMerchant=!isDemand&&(merchant(note.user?.nickname,note.user?.userId,body)||RE_MERCHANT.test(body));
      const base={note_id:note.noteId,title,author:note.user?.nickname,author_id:note.user?.userId,published_at_ms:note.time,url,desc:note.desc,source_is_merchant:sourceIsMerchant,...extracted};
      const noteKey='note:'+note.noteId;
      const noteCandidate=isDemand||(!merchant(base.author,base.author_id,body)&&strategy.broadCandidate(body));
      if((!prev||prev.review_version!==REVIEW_VERSION)&&noteCandidate&&inWin(note.time)&&!isResolved&&!watch.suppressed?.[noteKey])watch.outbox[noteKey] ||= {key:noteKey,type:'note',...base,first_discovered_at:prev?.first_seen||nowIso(),classification:isDemand?'明确求租（规则判定）':'宽筛候选，待AI复核'};
      for(const s of signals.filter(s=>(s.is_new||prev?.review_version!==REVIEW_VERSION)&&s.in_window&&!s.is_author&&(/^demand-/.test(s.kind)||(s.kind==='other'&&strategy.broadCandidate(s.text))))){
        const key='comment:'+note.noteId+':'+s.id;
        if(!watch.suppressed?.[key])watch.outbox[key] ||= {key,type:'comment',...base,comment:s,...fields(s.text),first_discovered_at:prev?.comment_first_seen?.[s.id]||(prevSeen[s.id]?null:nowIso()),rechecked:!!prev,old_post_comment:!inWin(note.time),classification:s.kind==='demand-strong'?'明确求租（规则判定）':'询价／档期，待核实'};
      }
      if(prev&&!prev.resolved&&isResolved){const key='resolved:'+note.noteId;watch.outbox[key]={key,type:'resolved',...base,evidence:signals.filter(s=>s.is_author&&s.kind==='resolved').map(s=>s.text).join('\n')||body};}
      if(isResolved)delete watch.outbox['note:'+note.noteId];
      if(cm.hasMore)state.warnings.push('评论未完整加载：'+(title||note.user?.nickname));
      const missingReplies=(cm.list||[]).filter(c=>Number(c.subCommentCount)>(c.subComments||[]).length).length;
      if(missingReplies)state.warnings.push('仍有未展开楼中楼：'+(title||note.user?.nickname)+' / '+missingReplies+'组');
      const reportedComments=hot.count(note.interactInfo?.commentCount);
      const partial=cm.hasMore!==false||missingReplies>0||(reportedComments!==null&&reportedComments>comments.length);
      const commentCoverage={partial,request_limit:commentLimit,loaded:comments.length,reported:reportedComments,missing_reply_groups:missingReplies,checked_at:nowIso()};
      if(partial&&!cm.hasMore&&!missingReplies)state.warnings.push('评论覆盖未确认完整：'+title);

      state.notes.push({
        note_id: note.noteId, title, author: note.user?.nickname, author_id: note.user?.userId,
        ip: note.ipLocation || '', desc: note.desc, published_at_ms: note.time,
        in_window: inWin(note.time),
        is_demand_post: isDemand, is_merchant_post: sourceIsMerchant,
        url: 'https://www.xiaohongshu.com/explore/' + note.noteId +
             '?xsec_token=' + encodeURIComponent(note.xsecToken || it.token || '') + '&xsec_source=pc_search',
        comments_has_more: cm.hasMore, comment_count: comments.length,comment_coverage:commentCoverage,
        rechecked: isRecheck, phase: it.phase, new_comment_count: newCount,
        signals, resolved:isResolved,fields:extracted,
      });

      // 更新回访清单
      const rec = wnotes[note.noteId] || (wnotes[note.noteId] = {
        token: note.xsecToken || it.token, title, author: note.user?.nickname || '',
        ip: note.ipLocation || '', url: '', published_at_ms: note.time, desc: note.desc || '',
        is_demand_post: isDemand, is_merchant_post: sourceIsMerchant,
        first_seen: nowIso(), seen: {},
      });
      rec.token = note.xsecToken || rec.token;
      rec.title = title; rec.desc = note.desc || rec.desc;
      rec.is_demand_post=isDemand;rec.is_merchant_post=sourceIsMerchant;rec.resolved=isResolved;
      rec.comment_count = comments.length;
      rec.comment_coverage=commentCoverage;
      rec.comment_first_seen ||= {};
      for(const s of signals)if(!prevSeen[s.id])rec.comment_first_seen[s.id] ||= nowIso();
      rec.last_checked = nowIso();
      rec.review_version=REVIEW_VERSION;
      if(signals.some(s=>s.is_new&&s.in_window))rec.last_activity_at=nowIso();
      rec.url = 'https://www.xiaohongshu.com/explore/' + note.noteId;
      for (const s of signals) if (!rec.seen[s.id]) rec.seen[s.id] = s.published_at_ms || nowIso();
      fs.writeFileSync(WATCH_PATH,JSON.stringify(watch,null,2),{mode:0o600});

      if (isRecheck) state.rechecked++;
      state.new_comments_found += newCount;

      const nd = signals.filter(s => s.is_new && (s.kind === 'demand-strong' || s.kind === 'demand-weak' || s.kind === 'poster')).length;
      console.log(`[${it.phase}] ${title.slice(0, 22) || '(无标题)'}｜窗口:${inWin(note.time) ? 'Y' : 'N'}｜评论${comments.length}（新增${newCount}）｜其中需求向${nd}`);
    } catch (e) {
      state.notes.push({ note_id: it.id, title: it.title, error: String(e.message), phase: it.phase });
      console.log(`[${it.phase}] ${(it.title || it.id).slice(0, 22)} → 放弃 ${e.message}`);
      state.warnings.push('详情读取失败：'+(it.title||'已跟踪帖子')+' / '+e.message);
      if(e.backend_unavailable){save();throw e;}
      if(e.restricted){watch.paused={reason:'访问限制或验证码',at:nowIso()};fs.writeFileSync(WATCH_PATH,JSON.stringify(watch,null,2),{mode:0o600});throw e;}
    }
    state.hot_pools=hot.coverage(watch,config,state.notes);
    save();
  }

  watch.updated_at = nowIso();
  fs.writeFileSync(WATCH_PATH, JSON.stringify(watch, null, 2), { mode: 0o600 });

  state.hot_pools=hot.coverage(watch,config,state.notes);
  for(const p of state.hot_pools)if(p.selected<p.target||p.never_read||p.partial_comments||p.stale)state.warnings.push(`热门池 ${p.category}：入池${p.selected}/${p.target}，尚未读详情${p.never_read}，评论覆盖不完整${p.partial_comments}${p.stale?'，热度刷新未完成':''}`);
  state.complete = state.searches.length===searchPlan.length&&state.searches.every(s=>!s.error)&&state.notes.every(n=>!n.error)&&!state.warnings.length;
  state.completed_at = nowIso();
  state.watchlist_size = Object.keys(wnotes).length;
  save();
  console.log(`完成 → ${OUT}（回访 ${state.rechecked} 篇｜发现新增评论 ${state.new_comments_found} 条｜清单累计 ${state.watchlist_size} 篇）`);
})().catch(e => { console.error('中断：' + e.message); process.exitCode = 1; });
