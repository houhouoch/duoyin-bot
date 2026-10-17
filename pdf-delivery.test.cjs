const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildDocument}=require('./document-delivery.cjs');
const {html,preparePdf}=require('./pdf-delivery.cjs');
const config=require('./monitor-config.json');
test('automatic PDF contains every selected record and original-post link',t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-pdf-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 fs.copyFileSync(path.join(__dirname,'validate-pdf.py'),path.join(base,'validate-pdf.py'));
 const started_at='2026-10-02T08:00:00Z',rows=[1,2].map(i=>({key:'note:'+i,type:'note',note_id:'n'+i,title:'求租相机'+i,desc:'求租相机'+i,url:'https://www.xiaohongshu.com/explore/n'+i,author:'测试',published_at_ms:Date.parse(started_at)}));
 const doc=buildDocument(rows,{started_at,complete:true},config,Date.parse(started_at));
 const batch=preparePdf(doc,base);
 assert.deepEqual(batch.keys,doc.keys);assert.equal(batch.attachment_sha256.length,64);
 assert(fs.readFileSync(batch.attachment_path).subarray(0,5).toString()==='%PDF-');
 const manifest=JSON.parse(fs.readFileSync(batch.attachment_path.replace(/\.pdf$/,'.manifest.json')));
 assert.equal(manifest.count,2);assert.equal(manifest.validation.links,2);assert(manifest.validation.pages>=1);
});
test('PDF HTML escapes untrusted source text',()=>{
 const output=html('plain <script>alert(1)</script> & done');
 assert(!output.includes('<script>'));assert(output.includes('&lt;script&gt;'));assert(output.includes('&amp; done'));
});
test('unified sender delivers PDF once without calling smartpage',t=>{
 const {execFileSync}=require('node:child_process'),base=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-pdf-sender-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 for(const name of ['notify-four-hour.cjs','pdf-delivery.cjs','validate-pdf.py','attachment-delivery.cjs','document-delivery.cjs','lead-timeliness.cjs','lead-presentation.cjs','delivery-integrity.cjs','concise-message.cjs','demand-validity.cjs','deepseek-review.cjs','lead-fields.cjs','rental-strategy.cjs','hot-pools.cjs','camera-catalog.json'])fs.copyFileSync(path.join(__dirname,name),path.join(base,name));
 fs.writeFileSync(path.join(base,'monitor-config.json'),JSON.stringify({...config,deepseek_review:{enabled:false},document_delivery:{enabled:true,mode:'pdf',join:'public'}}));
 const now=Date.now(),rows=[1,2].map(i=>({key:'note:'+i,type:'note',note_id:'n'+i,title:'求租相机'+i,desc:'求租相机'+i,url:'https://www.xiaohongshu.com/explore/n'+i,author:'测试',published_at_ms:now-1000}));
 fs.writeFileSync(path.join(base,'watchlist.json'),JSON.stringify({outbox:Object.fromEntries(rows.map(x=>[x.key,x]))}));
 const mock=`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const base=process.env.TEST_ROOT,a=process.argv.slice(2),i=a.indexOf('--json'),cmd=a.slice(0,i<0?a.length:i).join(' '),data=i<0?{}:JSON.parse(a[i+1]),file=path.join(base,'cloud.json'),s=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{uploads:0,messages:0};let r;if(cmd==='--version')r='1.2.1';else if(cmd==='auth show --status')r='authorized';else if(cmd==='message aibot sessions list')r={sessions:[{chat_id:'fixture',chat_name:'测试线索群',chat_type:'group'}]};else if(cmd==='media upload'){if(!fs.readFileSync(data.file_path).subarray(0,5).equals(Buffer.from('%PDF-')))throw Error('not a PDF');s.uploads++;r={type:'file',media_id:'fixture-file'};}else if(cmd==='message aibot send'){if(data.msg_type!=='file'||data.file?.media_id!=='fixture-file')throw Error('wrong payload');s.messages++;r={success:true};}else throw Error('unexpected command '+cmd);fs.writeFileSync(file,JSON.stringify(s));console.log(typeof r==='string'?r:JSON.stringify(r));`;
 fs.writeFileSync(path.join(base,'wecom-cli'),mock,{mode:0o700});
 const scan=path.join(base,'scan.json');fs.writeFileSync(scan,JSON.stringify({started_at:new Date(now).toISOString(),complete:true}));
 const run=()=>execFileSync(process.execPath,[path.join(base,'notify-four-hour.cjs'),'--scan',scan],{env:{...process.env,PATH:base+':/usr/bin:/bin',TEST_ROOT:base},encoding:'utf8',timeout:30000});
 run();const cloud=JSON.parse(fs.readFileSync(path.join(base,'cloud.json'))),receipt=JSON.parse(fs.readFileSync(path.join(base,'four-hour-last-delivery.json')));
 assert.equal(cloud.uploads,1);assert.equal(cloud.messages,1);assert.equal(receipt.format,'file');assert.equal(receipt.accepted,2);
 run();const again=JSON.parse(fs.readFileSync(path.join(base,'cloud.json')));assert.equal(again.uploads,1);assert.equal(again.messages,1);
});
