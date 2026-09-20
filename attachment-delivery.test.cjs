const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {prepareAttachment,uploadAttachment}=require('./attachment-delivery.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
test('attachment verifies source and bytes; upload alone never marks keys sent',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-attachment-'));
 try{
  const file=path.join(dir,'fixture.pdf'),manifest=path.join(dir,'fixture.json'),doc={content:'complete source',keys:['a','b']};
  fs.writeFileSync(file,'%PDF-test');const m={file_path:file,file_sha256:sha(fs.readFileSync(file)),content_sha256:sha(doc.content),count:2,verified:true};fs.writeFileSync(manifest,JSON.stringify(m));
  const b=prepareAttachment(doc,manifest);assert.deepEqual(b.keys,doc.keys);
  assert.deepEqual(uploadAttachment(b,()=>JSON.stringify({type:'file',media_id:'fixture'})),{msg_type:'file',file:{media_id:'fixture'}});
  assert.throws(()=>uploadAttachment(b,()=>JSON.stringify({type:'image',media_id:'fixture'})));
  assert.throws(()=>prepareAttachment({...doc,content:'changed'},manifest));
  fs.appendFileSync(file,'changed');assert.throws(()=>prepareAttachment(doc,manifest));assert.throws(()=>uploadAttachment(b,()=>{throw Error('must not reach');}));
 }finally{fs.rmSync(dir,{recursive:true});}
});
