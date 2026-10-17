const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync,spawnSync}=require('node:child_process');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'duoyin-deploy-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const repo=path.join(root,'repo & 中文'),home=path.join(root,'new home'),bin=path.join(root,'bin');
 for(const dir of [repo,home,bin])fs.mkdirSync(dir,{recursive:true});
 for(const name of ['scripts','hermes','launchd'])fs.cpSync(path.join(__dirname,name),path.join(repo,name),{recursive:true});
 for(const name of ['monitor-config.example.json','camera-catalog.example.json','merchant-registry.example.json','.gitignore'])fs.copyFileSync(path.join(__dirname,name),path.join(repo,name));
 fs.writeFileSync(path.join(bin,'wecom-cli'),'#!/bin/sh\nexit 99\n',{mode:0o700});
 const env={...process.env,HOME:home,PATH:bin+path.delimiter+process.env.PATH};
 delete env.XHS_MCP_HOME;
 return {repo,home,env};
}
test('new-user templates render spaces and XML safely, preserve existing config, and start no services',t=>{
 const f=fixture(t),script=path.join(f.repo,'scripts/configure-local.py');
 execFileSync('python3',[script],{env:f.env});
 execFileSync(process.env.DUOYIN_PYTHON,['-c','import pathlib,sys,yaml; [yaml.safe_load(p.read_text()) for p in pathlib.Path(sys.argv[1]).glob("*.yaml")]',path.join(f.repo,'hermes')]);
 const monitor=path.join(f.home,'.hermes/profiles/xhs-rental-monitor');
 const wrapper=path.join(monitor,'scripts/xhs-rental-four-hour.sh');
 execFileSync('/bin/bash',['-n',wrapper]);
 const plist=path.join(f.home,'Library/LaunchAgents/ai.duoyin.xhs-readonly-backend.plist');
 const rendered=JSON.parse(execFileSync('python3',['-c','import json,plistlib,sys;print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))',plist],{encoding:'utf8'}));
 assert.equal(rendered.WorkingDirectory,fs.realpathSync(f.repo));assert.equal(rendered.EnvironmentVariables.XHS_MCP_HOME,path.join(fs.realpathSync(f.home),'.local/share/duoyin-bot/xiaohongshu-mcp-v2.5.0'));
 assert(!fs.existsSync(path.join(monitor,'cron')));assert(!fs.existsSync(path.join(f.home,'.local/share/duoyin-bot')));
 const config=path.join(monitor,'config.yaml');fs.writeFileSync(config,'user-managed-config');
 execFileSync('python3',[script],{env:f.env});assert.equal(fs.readFileSync(config,'utf8'),'user-managed-config');
 assert.equal(fs.statSync(path.join(monitor,'.env')).mode&0o777,0o600);
});
test('initialization preserves user state and uses peer-excluded chronological defaults',t=>{
 const f=fixture(t),run=()=>execFileSync('bash',[path.join(f.repo,'scripts/init-example-state.sh')],{env:f.env});run();
 const config=JSON.parse(fs.readFileSync(path.join(f.repo,'monitor-config.json')));
 assert.equal(config.delivery_priority.include_peer_leads,false);assert.equal(config.delivery_priority.supplemental_enabled,false);
 assert.equal(config.notification_policy.operational_issues,'document_only');assert.equal(config.document_layout.followup_enabled,false);
 const ledger=path.join(f.repo,'watchlist.json');fs.writeFileSync(ledger,'{"user_state":"preserved"}');run();
 assert.equal(fs.readFileSync(ledger,'utf8'),'{"user_state":"preserved"}');
 execFileSync('git',['init','-q'],{cwd:f.repo});
 for(const file of ['watchlist.json','monitor-config.json','private/key','output/report.pdf','collaboration/reports/test.md','.env'])assert.equal(spawnSync('git',['check-ignore','-q',file],{cwd:f.repo}).status,0,file);
});
test('publish scan rejects newly staged secrets and private files without echoing their contents',t=>{
 const f=fixture(t);execFileSync('git',['init','-q'],{cwd:f.repo});
 const run=()=>spawnSync('bash',[path.join(f.repo,'scripts/secret-scan.sh')],{encoding:'utf8'});
 assert.equal(run().status,0);
 const secret='sk-'+'Z'.repeat(32);fs.writeFileSync(path.join(f.repo,'bad.cjs'),'const key="'+secret+'";');
 execFileSync('git',['add','bad.cjs'],{cwd:f.repo});fs.writeFileSync(path.join(f.repo,'bad.cjs'),'// cleaned working tree');
 const rejected=run();assert.equal(rejected.status,1);assert(!rejected.stderr.includes(secret));assert(rejected.stderr.includes('index'));
 execFileSync('git',['rm','-f','--cached','bad.cjs'],{cwd:f.repo});fs.rmSync(path.join(f.repo,'bad.cjs'));
 fs.writeFileSync(path.join(f.repo,'watchlist.json'),'{}');execFileSync('git',['add','-f','watchlist.json'],{cwd:f.repo});
 assert.equal(run().status,1);
});
