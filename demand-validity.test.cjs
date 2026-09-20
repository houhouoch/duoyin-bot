const test=require('node:test'),assert=require('node:assert/strict');
const {validity}=require('./demand-validity.cjs');
const {render}=require('./concise-message.cjs'),config=require('./monitor-config.json');
const now=Date.parse('2026-09-20T04:00:00+08:00');
const lead=(text,period='未知')=>({key:'c1',type:'comment',note_id:'fixture',title:'原帖',url:'https://www.xiaohongshu.com/explore/fixture',comment:{author:'测试',text,published_at_ms:Date.parse('2026-09-13T12:00:00+08:00')},ai_review:{rental_period:period}});
test('past explicit use day expires, not merely an old publication',()=>{
 assert.equal(validity(lead('9.19  X300u+400增距镜 问价'),now).status,'expired');
 assert.equal(validity(lead('9.20，4p有吗'),now).status,'today');
 assert.equal(validity(lead('哪里租的'),now).status,'unknown');
 assert.equal(validity(lead('还可以租吗'),now).status,'unknown');
});
test('ranges remain valid until their end; incomplete or ambiguous dates are not guessed',()=>{
 for(const p of ['9.19-9.23','9月19日到23日','9.19-23'])assert.equal(validity(lead('租'+p,p),now).status,'ongoing',p);
 for(const p of ['9.19开始租一个月','19号','下周','9.31','9.19或者9.25'])assert.equal(validity(lead('租'+p,p),now).status,'unknown',p);
 assert.equal(validity(lead('F1.4镜头有吗'),now).status,'unknown');
 assert.equal(validity(lead('9.19开始，结束还没定'),now).status,'unknown');
});
test('today label replaces historical label; older unknown demand remains shown',()=>{
 const today=render({pending:[lead('9.20，4p有吗')],config,now})[0].content;
 assert(today.includes('今日用机'));assert(!today.includes('历史需求'));
 assert(render({pending:[lead('哪里租的')],config,now})[0].content.includes('哪里租的'));
});
