// Bounded recovery for the existing, authenticated local read-only MCP service.
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function sanitize(value,secrets=[]){
 let s=String(value??'');
 for(const secret of secrets)if(secret)s=s.split(secret).join('[REDACTED]');
 return s.replace(/https?:\/\/[^\s"'<>]+/gi,'[URL]')
  .replace(/["']?(?:authorization|cookie|set-cookie|api[_-]?key|xsec[_-]?token|web_session|a1)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n,;}]+)/gi,'[REDACTED_FIELD]')
  .replace(/(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi,'[REDACTED_HEADER]')
  .replace(/(?:bearer\s+|(?:api[_-]?key|xsec[_-]?token|web_session|a1)\s*[:=]\s*)[^\s,;"']+/gi,'[REDACTED]')
  .replace(/[a-f0-9]{24,}/gi,'[REDACTED_ID]').slice(0,700);
}
function failure(status,data={},secrets=[]){
 const raw=JSON.stringify({code:data.code,error:data.error,message:data.message,details:data.details});
 const blocked=[401,403,429,461,471].includes(status)||/captcha|verification|验证码|风控|访问限制|访问频繁|操作频繁|安全验证|risk.control|not.logged.in|login.required|session.expired|未登录|登录失效|登录过期|请.{0,4}登录|300012|300015|"code":\s*-100/i.test(raw);
 const details=typeof data.details==='string'?data.details:data.details?.message||data.details?.error||'';
 const code=sanitize(data.code||'QUERY_FAILED',secrets),reason=sanitize(details||data.error||data.message||'服务未返回详细原因',secrets);
 const e=new Error(code+' / '+reason);
 Object.assign(e,{code,http_status:status,details:reason,restricted:blocked,retryable:!blocked&&(status>=500||['INTERNAL_ERROR','SEARCH_FEEDS_FAILED'].includes(code))});
 return e;
}
async function read(endpoint,body,{token,fetcher=fetch,sleep=delay,now=Date.now,deadline=Infinity,timeout_ms=120000,backoff_ms=15000,interval_ms=5000,onAttempt=()=>{}}={}){
 if(!['search','detail'].includes(endpoint))throw Error('只允许小红书搜索和详情读取');
 // The upstream default is already unrestricted. Sending this redundant option
 // forces a second hover-panel lookup which can disappear after selecting sort.
 // Keep real restrictions and the requested sorting unchanged.
 if(endpoint==='search'&&body.filters?.publish_time==='不限'){
  body={...body,filters:{...body.filters}};delete body.filters.publish_time;
 }
 const limit=endpoint==='search'?2:1;
 for(let attempt=1;attempt<=limit;attempt++){
  const started=now();let result,error,status;
  if(deadline-started<timeout_ms){const e=new Error('采集时间预算不足，未启动下一次请求');e.code='BUDGET_DEFERRED';throw e;}
  try{
   const response=await fetcher((process.env.XHS_BACKEND_URL||'http://127.0.0.1:18061').replace(/\/$/,'')+'/api/v1/feeds/'+endpoint,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout_ms)});
   status=response.status;
   let data;try{data=await response.json();}catch{throw failure(status,{code:'INVALID_RESPONSE',error:'MCP返回非JSON响应'},[token]);}
   if(!response.ok||data.success!==true)throw failure(status,data,[token]);
   if(endpoint==='search'&&!Array.isArray(data.data?.feeds))throw failure(502,{code:'INVALID_SEARCH_DATA',error:'成功响应缺少搜索结果数组'},[token]);
   result=data.data;
  }catch(e){
   if(e.code&&typeof e.retryable==='boolean')error=e;
   else {
    const unavailable=e.cause?.code==='ECONNREFUSED'||e.code==='ECONNREFUSED';
    error=new Error(unavailable?'本机小红书MCP服务已断开，本轮停止，不继续逐帖请求':e.name==='TimeoutError'||e.name==='AbortError'?'MCP请求超时':'MCP连接或读取失败');
    Object.assign(error,{code:unavailable?'BACKEND_UNAVAILABLE':/Timeout|Abort/.test(e.name)?'REQUEST_TIMEOUT':'TRANSPORT_ERROR',http_status:status,retryable:!unavailable,restricted:false,backend_unavailable:unavailable});
   }
  }
  onAttempt({at:new Date(now()).toISOString(),endpoint,...(endpoint==='search'?{keyword:sanitize(body.keyword,[token])}:{}),attempt,elapsed_ms:now()-started,http_status:status,status:error?'failed':'success',...(error?{code:error.code,details:error.details||error.message,restricted:error.restricted}:{count:result?.feeds?.length})});
  if(!error){await sleep(interval_ms);return result;}
  if(error.restricted||!error.retryable||attempt===limit)throw error;
  if(now()+backoff_ms+timeout_ms>deadline){error.message+='；剩余预算不足，未重试';throw error;}
  await sleep(backoff_ms);
 }
}
module.exports={read,failure,sanitize};
