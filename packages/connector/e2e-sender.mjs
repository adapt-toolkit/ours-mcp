// TEST-ONLY e2e helper: create a sibling sender under an existing root and send the
// target identity a message (to queue content the connector can then drain).
// All wiring comes from env (no hardcoded machine paths):
//   CONNECTOR_CLI, OURS_PORT, OURS_STATE_DIR, OURS_BROKER_URL
//   E2E_ROOT   (root identity to bind, default "Smoke Test Peer")
//   E2E_SENDER (sibling sender to create,  default "SmokeSender")
//   E2E_TARGET (contact to message,        default "SmokePeer")
//   E2E_TEXT   (message body,              default "CONNECTOR-E2E: hello via ours")
import { spawn } from 'node:child_process';
const CLI=process.env.CONNECTOR_CLI||'ours-mcp';
const ROOT=process.env.E2E_ROOT||'Smoke Test Peer';
const SENDER=process.env.E2E_SENDER||'SmokeSender';
const TARGET=process.env.E2E_TARGET||'SmokePeer';
const TEXT=process.env.E2E_TEXT||'CONNECTOR-E2E: hello via ours';
const env={...process.env,
  OURS_PORT:process.env.OURS_PORT||'3050',
  OURS_STATE_DIR:process.env.OURS_STATE_DIR||`${process.env.HOME}/.ours`,
  OURS_BROKER_URL:process.env.OURS_BROKER_URL||'wss://broker1.ours.network',
  CLAUDE_CODE_SESSION_ID:process.env.CONNECTOR_SESSION_ID||'e2e-sender'};
const p=spawn(CLI,['proxy'],{env,stdio:['pipe','pipe','ignore']});
let buf='';const pend=new Map();let id=1;
p.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l.trim())continue;let m;try{m=JSON.parse(l);}catch{continue;}if(m.id!=null&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}}});
const send=(method,params)=>new Promise(r=>{const i=id++;pend.set(i,r);p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:i,method,params})+'\n');});
const tool=(n,a={})=>send('tools/call',{name:n,arguments:a});
try{
  await send('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'s',version:'0'}});
  p.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized',params:{}})+'\n');
  await new Promise(r=>setTimeout(r,300));
  await tool('choose_identity',{name:ROOT,force:true});
  await tool('create_identity',{name:SENDER});
  await tool('choose_identity',{name:SENDER,force:true});
  const r=await tool('send_message',{contact:TARGET,text:TEXT});
  console.log('sent:',(r.result?.content??[]).map(c=>c.text).join('').slice(0,90));
}finally{p.stdin.end();setTimeout(()=>p.kill('SIGTERM'),300);}
