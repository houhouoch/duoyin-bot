const test=require('node:test'),assert=require('node:assert/strict');
const {render,fingerprint}=require('./concise-message.cjs'),config=require('./monitor-config.json');
const now=Date.parse('2026-09-18T13:00:00Z');
function lead(key='one',note='fixture'){
 return {key,type:'comment',note_id:note,title:'相机租赁清单',url:'https://www.xiaohongshu.com/explore/'+note+'?xsec_token=fixture-only',published_at_ms:now-99*86400000,comment:{id:key,author:'测试客户',text:'19号有理光吗',published_at_ms:now-86400000},ai_review:{decision:'inquiry',model:'deepseek-flash'}};
}
const text=args=>render({config,now,...args}).map(g=>g.content).join('\n');
test('default six-lead parts preserve all 22 quotes and repeat their post context',()=>{
 const pending=Array.from({length:22},(_,i)=>{const x=lead('short'+i);x.comment.text='完整原话'+i;return x;});
 const groups=render({pending,config,now});
 assert.deepEqual(groups.map(g=>g.keys.length),[6,6,6,4]);
 assert.deepEqual(groups.flatMap(g=>g.keys),pending.map(x=>x.key));
 for(const x of pending)assert(groups.some(g=>g.keys.includes(x.key)&&g.content.includes('：“'+x.comment.text+'”')));
 assert(groups.every(g=>g.content.includes('https://www.xiaohongshu.com/explore/fixture')));
 assert.throws(()=>render({config,maxItems:0}),/正整数/);
});
test('identical visible messages with distinct comments have distinct receipt identities',()=>{
 assert.notEqual(fingerprint('同一句问价',['comment:a']),fingerprint('同一句问价',['comment:b']));
 assert.equal(fingerprint('同一句问价',['b','a']),fingerprint('同一句问价',['a','b']));
});
test('one link per post with nickname, publication date and exact quote; no diagnostics',()=>{
 const a=lead(),b=lead('two');b.comment.text='10.3问价';
 const s=text({pending:[a,b],scan:{warnings:['评论未完整加载：某帖'],hot_pools:[{selected:20}]},awaiting:29});
 assert.equal((s.match(/https:\/\/www.xiaohongshu.com/g)||[]).length,1);assert(s.includes('主评论｜测试客户｜9/17：“19号有理光吗”'));assert(s.includes('10.3问价'));
 for(const forbidden of ['tokens','AI复核','模型用量','估算','库存重点','缓存复用','评论未完整加载','29','首次发现'])assert(!s.includes(forbidden),forbidden);
});
test('document sections put direct demand first and peer-source comments last',()=>{
 const peer=lead('peer','peer-post');peer.source_is_merchant=true;peer.title='同行租赁清单';
 const organic=lead('organic','organic-post');organic.title='演唱会攻略';
 const direct={...lead('direct','direct-post'),type:'note',title:'求租相机',desc:'明天求租R50',comment:undefined,published_at_ms:now};
 const s=text({pending:[peer,organic,direct]});
 assert(s.indexOf('客户直接求租帖')<s.indexOf('非同行帖子评论'));
 assert(s.indexOf('非同行帖子评论')<s.indexOf('同行帖子评论'));
 assert(s.indexOf('direct-post')<s.indexOf('organic-post'));assert(s.indexOf('organic-post')<s.indexOf('peer-post'));
});
test('reply carries real parent quote and nickname, never a fabricated floor or comment deeplink',()=>{
 const x=lead();x.comment.parent_id='parent';x.comment.parent_text='备用原话';
 const s=text({pending:[x],scan:{notes:[{note_id:x.note_id,signals:[{id:'parent',author:'父评论人',text:'9.26问价'}]}]}});
 assert(s.includes('楼中楼'));assert(s.includes('位置：「父评论人」的“9.26问价”评论下。'));assert(!s.includes('备用原话'));assert(!s.includes('第1楼'));
});
test('backlog reply uses saved parent text; missing context marked without inventing it',()=>{
 const x=lead();x.comment.parent_id='parent';x.comment.parent_text='9.26问价';assert(text({pending:[x]}).includes('位置：“9.26问价”评论下。'));delete x.comment.parent_text;assert(text({pending:[x]}).includes('父评论原文未取得'));
});
test('old parent does not make recent comment old; historical and uncertain labels retained',()=>{
 const x=lead();assert(!text({pending:[x]}).includes('历史需求'));x.comment.published_at_ms=now-7*86400000;x.ai_review.decision='uncertain';const s=text({pending:[x]});assert(s.includes('历史需求，待确认'));assert(s.includes('意图待确认'));
});
test('post body keeps exact words, removes platform hashtag markup, does not infer location',()=>{
 const x={...lead(),type:'note',author:'客户',desc:'10.22-23号租两天拍拍照\n#理光[话题]#',comment:undefined,published_at_ms:now};const s=text({pending:[x]});assert(s.includes('正文｜客户'));assert(s.includes('10.22-23号租两天拍拍照'));assert(!s.includes('[话题]'));assert(!s.includes('地点：'));
});
test('chunking retains every receipt key exactly once and repeats source context on continuation',()=>{
 const pending=Array.from({length:60},(_,i)=>{const x=lead('c'+i);x.comment.text='测试原话'.repeat(12);return x;});
 const groups=render({pending,config,now,maxBytes:1200});assert(groups.length>1);assert.deepEqual(groups.flatMap(g=>g.keys).sort(),pending.map(x=>x.key).sort());assert(groups.every(g=>Buffer.byteLength(g.content)<=1200));assert(groups.every(g=>g.content.includes('https://www.xiaohongshu.com/explore/fixture')));
});
test('oversized record fails closed, never silently truncates then marks sent',()=>{
 const x=lead();x.comment.text='原文'.repeat(10000);assert.throws(()=>text({pending:[x]}),/未截断/);
});
test('technical alert is one short actionable line and never includes pending leads or raw details',()=>{
 const s=text({pending:[lead()],alert:'DeepSeek失败 tokens=123 key=DO_NOT_PRINT'});assert(s.includes('线索复核暂时失败'));assert(!s.includes('DO_NOT_PRINT'));assert(!s.includes('19号'));assert(!s.includes('tokens'));
});
test('empty success, pending review, failed collection and uncertain delivery remain distinct',()=>{
 assert(text({}).includes('暂无新增求租线索'));assert(text({awaiting:4}).includes('待处理内容已保留'));assert(text({scan:{warnings:['部分评论未读']}}).includes('查询尚未完成'));assert(text({blocked:1}).includes('停止自动重发'));
});
test('correction and resolved records are not lost or rendered as new demand',()=>{
 const a={...lead('a'),type:'correction',author:'某店'},b={...lead('b'),type:'resolved',author:'客户',evidence:'已租到'};const groups=render({pending:[a,b],config,now});const s=groups[0].content;assert(s.includes('更正｜某店'));assert(s.includes('状态更新｜客户：“已租到”'));assert.deepEqual(groups.flatMap(g=>g.keys),['a','b']);
});
test('untrusted text cannot inject markdown links and source URL must match the note',()=>{
 const x=lead();x.comment.author='[伪链接](evil)';assert(text({pending:[x]}).includes('\\[伪链接\\]'));x.url='https://evil.invalid/explore/fixture';assert.throws(()=>text({pending:[x]}),/链接校验/);
});
