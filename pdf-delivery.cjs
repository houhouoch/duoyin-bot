// Deterministic PDF transport for the existing locked sender. No queue or
// receipt state is changed until WeCom accepts the file message.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {fingerprint}=require('./concise-message.cjs');
const {prepareAttachment}=require('./attachment-delivery.cjs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const plain=s=>s.replace(/\*\*(.*?)\*\*/g,'$1').replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g,'$1');
function html(content){
 const paragraphs=content.split('\n').filter(Boolean).map(line=>{
  const link=line.match(/^\*\*(\d+\. )\[(.*)\]\((https:\/\/www\.xiaohongshu\.com\/[^\s)]+)\)\*\*$/);
  if(link)return `<h2><a href="${esc(link[3])}">${esc(link[1]+plain(link[2]))}</a></h2>`;
  if(line.startsWith('# '))return `<h1>${esc(line.slice(2))}</h1>`;
  if(line.startsWith('### '))return `<h3>${esc(line.slice(4))}</h3>`;
  const cls=line.startsWith('  位置')?'parent':line.startsWith('- ')?'lead':'intro';
  return `<p class="${cls}">${esc(plain(line.replace(/^- /,'')))}</p>`;
 }).join('\n');
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
@page{size:A4;margin:17mm 16mm 18mm}body{font-family:'PingFang SC','Arial Unicode MS',sans-serif;font-size:10.5pt;line-height:1.6;color:#17212b}h1{font-size:19pt;line-height:1.35;margin:0 0 13pt}h2{font-size:11.5pt;line-height:1.45;margin:15pt 0 6pt;break-after:avoid}h3{font-size:10.5pt;margin:14pt 0 6pt}a{color:#1554a2;text-decoration:none}p{margin:4pt 0;white-space:pre-wrap;overflow-wrap:anywhere;break-inside:avoid}.parent{font-size:9.5pt;color:#536071;margin-left:11pt}.intro{font-size:9.5pt;color:#536071}.lead{padding-left:8pt;border-left:2pt solid #e5ecf3}</style><body>${paragraphs}</body></html>`;
}
async function render(source,target){
 const {chromium}=require('playwright');
 const browser=await chromium.launch({...(process.env.PDF_CHROME_PATH?{executablePath:process.env.PDF_CHROME_PATH}:{}),headless:true});
 try{
  const page=await browser.newPage();await page.route('**/*',route=>route.abort());
  await page.setContent(html(fs.readFileSync(source,'utf8')));await page.evaluate(()=>document.fonts.ready);
  await page.pdf({path:target,format:'A4',printBackground:true,displayHeaderFooter:true,headerTemplate:'<span></span>',footerTemplate:'<div style="font-size:9px;text-align:center;width:100%;color:#667085"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',preferCSSPageSize:true});
  fs.chmodSync(target,0o600);
 }finally{await browser.close();}
}
function preparePdf(doc,base){
 if(!doc?.keys?.length||doc.id!==fingerprint(doc.content,doc.keys))throw Error('PDF源内容指纹不一致');
 const out=path.join(base,'output/pdf');fs.mkdirSync(out,{recursive:true,mode:0o700});
 const stem=path.join(out,`小红书求租线索-${doc.id.slice(0,16)}`),source=stem+'.md',pdf=stem+'.pdf',manifest=stem+'.manifest.json';
 fs.writeFileSync(source,doc.content,{mode:0o600});
 execFileSync(process.execPath,[__filename,'--render',source,pdf],{timeout:120000,maxBuffer:1024*1024});
 const bytes=fs.readFileSync(pdf);
 if(bytes.length<1000||bytes.length>18*1024*1024||bytes.subarray(0,5).toString()!=='%PDF-')throw Error('PDF文件大小或格式校验失败');
 const python=process.env.DUOYIN_PYTHON||path.join(base,'.venv/bin/python3');
 const result=JSON.parse(execFileSync(python,[path.join(base,'validate-pdf.py'),pdf,String(doc.links.length),String(doc.keys.length)],{encoding:'utf8',timeout:30000}));
 if(result.pages<1||result.links!==doc.links.length)throw Error('PDF页面或原帖链接校验失败');
 fs.writeFileSync(manifest,JSON.stringify({file_path:pdf,file_sha256:sha(bytes),content_sha256:sha(doc.content),count:doc.keys.length,verified:true,validation:result},null,2),{mode:0o600});
 return prepareAttachment(doc,manifest);
}
if(require.main===module){
 if(process.argv[2]!=='--render'||!process.argv[3]||!process.argv[4])throw Error('PDF渲染参数不完整');
 render(process.argv[3],process.argv[4]).catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={html,preparePdf};
