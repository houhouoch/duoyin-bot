// Explicit, validated attachment recovery. The original sender owns all receipts.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function prepareAttachment(doc,manifestPath){
 const m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 if(m.content_sha256!==sha(doc.content)||m.count!==doc.keys.length||m.verified!==true)throw Error('附件与当前待发线索不一致，未发送');
 if(!path.isAbsolute(m.file_path)||path.extname(m.file_path)!=='.pdf')throw Error('附件必须是已验证的PDF');
 const bytes=fs.readFileSync(m.file_path);
 if(bytes.subarray(0,5).toString()!=='%PDF-'||sha(bytes)!==m.file_sha256)throw Error('附件内容已变化，未发送');
 return {content:doc.content,keys:doc.keys,hash:sha('attachment:'+m.file_sha256+'\n'+JSON.stringify([...doc.keys].sort())),attachment_path:m.file_path,attachment_sha256:m.file_sha256};
}
function uploadAttachment(batch,cli){
 if(sha(fs.readFileSync(batch.attachment_path))!==batch.attachment_sha256)throw Error('附件上传前完整性检查失败');
 let r;try{r=JSON.parse(cli(['media','upload','--json',JSON.stringify({file_path:batch.attachment_path})]));}catch{throw Error('附件上传结果未确认，未发送群消息');}
 if(r.type!=='file'||typeof r.media_id!=='string'||!r.media_id||(r.errcode!==undefined&&r.errcode!==0))throw Error('附件上传未明确成功，未发送群消息');
 return {msg_type:'file',file:{media_id:r.media_id}};
}
module.exports={prepareAttachment,uploadAttachment};
