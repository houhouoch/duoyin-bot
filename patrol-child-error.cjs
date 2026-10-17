// Return only known application errors or numeric codes, never raw stderr.
const path=require('node:path');
const known=[
 '文档读回原文遗漏或重复，未发群',
 '已有轮次收录相同待发记录，需沿原轮次回执恢复，未重复建页',
 '既有轮次写入结果待核实，需读回原页恢复',
 '文档读回页面不匹配',
 '既有轮次原文快照校验失败',
 '发送结果待核实，未自动重试',
 '企业微信明确返回发送失败，线索保留待重试',
 '既有轮次部分记录状态不明，停止整页重发'
];
function failure(script,code,stderr){
 const child=path.basename(script),notify=child==='notify-four-hour.cjs';
 let reason=known.find(s=>stderr.includes('Error: '+s)),category=reason?'application':'child_exit';
 const api=stderr.match(/错误码 (\d+)/)?.[1];
 if(notify&&(/"errcode"\s*:\s*850003/.test(stderr)||api==='850003'||stderr.includes('authorization expired'))){
  reason='企业微信机器人「'+(stderr.includes('daily-document-delivery.cjs')?'文档':'消息')+'」使用权限已过期，需创建者重新授权';category='authorization_expired';
 }else if(notify&&api){reason='企业微信文档接口拒绝请求（错误码 '+api+'）';category='document_api';}
 const error=new Error(reason?reason+'（'+child+'退出码 '+code+'）':'子进程失败，退出码 '+code);
 return Object.assign(error,{child,exit_code:code,category});
}
module.exports={failure};
