// TEST-ONLY: create a sibling sender under the smoke root + send SmokePeer a message (queue content).
import { spawn } from 'node:child_process';
const env={...process.env,OURS_PORT:'3060',OURS_STATE_DIR:'/home/claw1/data/A2aDev/connector-smoke-state',CLAUDE_CODE_SESSION_ID:'e2e-sender'};
const p=spawn('ours-mcp',['proxy'],{env,stdio:['pipe','pipe','ignore']});
let buf='';const pend=new Map();let id=1;
p.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l.trim())continue;let m;try{m=JSON.parse(l);}catch{continue;}if(m.id!=null&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}}});
const send=(method,params)=>new Promise(r=>{const i=id++;pend.set(i,r);p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:i,method,params})+'\n');});
const tool=(n,a={})=>send('tools/call',{name:n,arguments:a});
try{
  await send('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'s',version:'0'}});
  p.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized',params:{}})+'\n');
  await new Promise(r=>setTimeout(r,300));
  await tool('choose_identity',{name:'Smoke Test Peer',force:true});
  await tool('create_identity',{name:'SmokeSender'});
  await tool('choose_identity',{name:'SmokeSender',force:true});
  const r=await tool('send_message',{contact:'SmokePeer',text:'CONNECTOR-E2E: hello SmokePeer via ours'});
  console.log('sent:',(r.result?.content??[]).map(c=>c.text).join('').slice(0,90));
}finally{p.stdin.end();setTimeout(()=>p.kill('SIGTERM'),300);}
