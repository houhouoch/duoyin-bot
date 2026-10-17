const test=require('node:test'),assert=require('node:assert/strict');
const {failure}=require('./patrol-child-error.cjs');
test('notification error keeps specific safe cause and child stage',()=>{
 const e=failure('/tmp/notify-four-hour.cjs',1,'Error: 文档读回原文遗漏或重复，未发群\n at private/path');
 assert(e.message.includes('文档读回原文遗漏或重复，未发群'));assert.equal(e.child,'notify-four-hour.cjs');assert.equal(e.category,'application');
});
test('authorization failure is explicit while unknown stderr stays private',()=>{
 const e=failure('notify-four-hour.cjs',1,'daily-document-delivery.cjs Error: 企业微信文档接口拒绝请求（错误码 850003）');
 assert(e.message.includes('「文档」使用权限已过期'));assert.equal(e.category,'authorization_expired');
 assert.equal(failure('scan.cjs',1,'Error: Authorization: secret-value').message,'子进程失败，退出码 1');
});
