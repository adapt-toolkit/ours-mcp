import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {prepareAutomaticSession,nativeSessionKey,nativeSessionRecordPath} from '../dist/host-client.js';
const listen=server=>new Promise(r=>server.listen(0,'127.0.0.1',r));
async function fixture(capable=true){
 const home=mkdtempSync(join(tmpdir(),'ours-native-start-')),id=randomUUID(),credentialPath=join(home,'credential');writeFileSync(credentialPath,'a'.repeat(64),{mode:0o600});const owners=new Map(),posts=[];
 const server=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/daemon/selection'){res.end(JSON.stringify({schema:1,instanceId:id,capabilities:['external-sessions-v1',...(capable?['automatic-session-identities-v1','identity-display-name-v1','identity-promotion-v1']:[])]}));return;}
  if(req.url==='/daemon/api/v1/ensureSessionIdentity'){
   let text='';for await(const b of req)text+=b;const args=JSON.parse(text),token=req.headers['x-ours-lease-token'];posts.push({token,args});const created=!owners.has(token);
   if(created)owners.set(token,{name:'session-'+createHash('sha256').update(token).digest('hex').slice(0,24),cid:createHash('sha256').update(token).digest('hex').toUpperCase()});
   const identity=owners.get(token);res.end(JSON.stringify({...identity,displayName:identity.name,temporary:true,created,preserved:false,sessionHandle:args.sessionHandle}));return;
  }
  res.writeHead(404);res.end('{}');
 });await listen(server);const serverUrl=`http://127.0.0.1:${server.address().port}`;
 return{home,server,owners,posts,profile:{serverUrl,endpoint:serverUrl+'/daemon',expectedInstanceId:id,credentialPath},env:{...process.env,HOME:home,OURS_MCP_CONFIG:join(home,'mcp.json'),OURS_SESSION_POLICY:join(home,'policy.json'),OURS_BIND_IDENTITY:'',OURS_AUTO_SESSION_IDENTITIES:''}};
}
const close=f=>new Promise(r=>f.server.close(r));
test('namespace, policy and managed/subagent guards never allocate another identity',async()=>{
 const f=await fixture();try{
  assert.notEqual(await nativeSessionKey(f.profile,'codex','same',f.env),await nativeSessionKey(f.profile,'claude-code','same',f.env));
  assert.equal(await prepareAutomaticSession(f.profile,'codex','a',f.env,{managed:true}),null);
  assert.equal(await prepareAutomaticSession(f.profile,'codex','a',f.env,{subagent:true}),null);
  assert.equal(await prepareAutomaticSession(f.profile,'codex','a',{...f.env,OURS_BIND_IDENTITY:'Existing'}),null);
  assert.equal(await prepareAutomaticSession(f.profile,'codex','a',{...f.env,OURS_AUTO_SESSION_IDENTITIES:'0'}),null);
  assert.equal(f.posts.length,0);assert.equal(existsSync(join(f.home,'sessions')),false);
 }finally{await close(f);}
});
test('missing capability fails before native owner publication or credential-bearing mutation',async()=>{
 const f=await fixture(false);try{await assert.rejects(()=>prepareAutomaticSession(f.profile,'codex','a',f.env),/updated Ours daemon/);assert.equal(f.posts.length,0);assert.equal(existsSync(join(f.home,'sessions')),false);}finally{await close(f);}
});
test('concurrent processes with one exact native selector recover the same durable owner',async()=>{
 const f=await fixture();try{
  const child=(nativeId='same-native')=>new Promise((resolve,reject)=>{
   const p=spawn(process.execPath,['test-support/automatic-session-child.mjs'],{cwd:new URL('..',import.meta.url),env:{...f.env,TEST_SESSION_PROFILE:JSON.stringify(f.profile),TEST_SESSION_ID:nativeId},stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(Error(err)));
  });
  const [a,b]=await Promise.all([child(),child()]);assert.equal(a.cid,b.cid);assert.equal(f.owners.size,1);assert.equal(new Set(f.posts.map(p=>p.token)).size,1);
  const again=await prepareAutomaticSession(f.profile,'codex','same-native',f.env);assert.equal(again.identity.cid,a.cid);assert.equal(again.identity.created,false);
  const other=await prepareAutomaticSession(f.profile,'claude-code','same-native',f.env);assert.notEqual(other.identity.cid,a.cid);
  const records=readdirSync(join(f.home,'sessions',f.profile.expectedInstanceId));assert.equal(records.length,2);
  assert.deepEqual(JSON.parse(readFileSync(join(f.home,'mcp.json'),'utf8')).instances[f.profile.expectedInstanceId].identities.sort(),[a.name,other.identity.name].sort());
  const [third,fourth]=await Promise.all([child('different-a'),child('different-b')]);
  assert.notEqual(third.cid,fourth.cid);
  assert.deepEqual(JSON.parse(readFileSync(join(f.home,'mcp.json'),'utf8')).instances[f.profile.expectedInstanceId].identities.sort(),[a.name,other.identity.name,third.name,fourth.name].sort(),'different concurrent startup rows are not lost');
 }finally{await close(f);}
});

test('retired or pending native owner is not recreated by ordinary tool or compact access',async()=>{
 const f=await fixture();try{
  await prepareAutomaticSession(f.profile,'codex','ended-native',f.env);
  const selector=await nativeSessionKey(f.profile,'codex','ended-native',f.env);
  const path=nativeSessionRecordPath(f.home,f.profile.expectedInstanceId,selector),record=JSON.parse(readFileSync(path,'utf8'));
  const before=f.posts.length;
  for(const state of ['ended','pending']){
   writeFileSync(path,JSON.stringify({...record,state}),{mode:0o600});
   await assert.rejects(()=>prepareAutomaticSession(f.profile,'codex','ended-native',f.env,{source:'compact'}),/owner has ended/);
   assert.equal(f.posts.length,before);assert.equal(JSON.parse(readFileSync(path,'utf8')).ownerInstanceId,record.ownerInstanceId);
  }
 }finally{await close(f);}
});
