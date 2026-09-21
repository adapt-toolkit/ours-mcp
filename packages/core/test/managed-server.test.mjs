import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OursError } from '@ours.network/sdk';
import { createOursMcpServer, createManagedOursMcpServer } from '@ours.network/mcp/server';
const forbidden = ['create_identity','choose_identity','create_temporary_identity','create_root_identity','remove_identity','close_temporary_identity','define_local_identity_file'];
const noFiles = { read: async () => { throw Error('denied'); }, write: async () => { throw Error('denied'); }, canRead: async () => false };
async function connect(sdk, managed, options = {}) {
  const server = managed
    ? createManagedOursMcpServer(sdk,'test',{list:async()=>['Agent']},{fileContext:noFiles,admit:async()=>()=>{},...options})
    : createOursMcpServer(sdk,'test',{list:async()=>['Agent']});
  const client = new Client({name:'test',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  return {client,close:async()=>{await client.close();await server.close();}};
}
test('managed discovery preserves all 27 original schemas and rejects guessed lifecycle dispatch',async()=>{
  const calls=[];
  const sdk=new Proxy({}, { get:(_t,key)=>async()=>{calls.push(key);throw Error('must not dispatch');} });
  const a=await connect(sdk,false),b=await connect(sdk,true);
  try {
    const standalone=(await a.client.listTools()).tools;
    const managed=(await b.client.listTools()).tools;
    assert.equal(standalone.length,34);assert.equal(managed.length,27);
    assert.deepEqual(managed,standalone.filter(t=>!forbidden.includes(t.name)));
    for(const name of forbidden){const r=await b.client.callTool({name,arguments:{name:'Other',path:'/never'}});assert.equal(r.isError,true);}
    assert.deepEqual(calls,[]);
  } finally {await a.close();await b.close();}
});
test('managed failures never secretly bind or retry an unread operation',async()=>{
  let reads=0,binds=0;
  const b=await connect({currentIdentity:async()=>({name:'Agent'}),getMessages:async()=>{reads++;throw new OursError('NOT_BOUND','not bound');},chooseIdentity:async()=>{binds++;}},true);
  try {const r=await b.client.callTool({name:'get_messages',arguments:{}});assert.equal(r.isError,true);assert.equal(reads,1);assert.equal(binds,0);}
  finally{await b.close();}
});
test('file paths, resolution and probes use only the supplied context',async()=>{
  const actions=[];
  const body=()=>new Blob(['sandbox bytes']).stream();
  const b=await connect({
    uploadFile:async(stream,meta)=>{assert.equal(await new Response(stream).text(),'sandbox bytes');assert.equal(meta.filename,'sandbox.txt');return {upload_id:'own'};},
    sendFile:async args=>{assert.equal(args.path,undefined);assert.equal(args.upload_id,'own');return {kind:'e2e',filename:'sandbox.txt',bytes:13,wireId:'ABC'};},
    openFile:async()=>body(),
    getFiles:async()=>({text:'original transcript',files:[{path:'/private/supervisor',wire_id:'ABC',filename:'x'}],mode:'unread',remaining:0}),
  },true,{fileContext:{
    read:async path=>{actions.push(['read',path]);return {filename:'sandbox.txt',size:13,body:body(),close:()=>actions.push(['close'])};},
    write:async(path,stream)=>{actions.push(['write',path]);assert.equal(await new Response(stream).text(),'sandbox bytes');return {path:'/sandbox/out',size:13};},
    canRead:async path=>{actions.push(['probe',path]);return false;},
  }});
  try {
    assert.equal((await b.client.callTool({name:'send_file',arguments:{contact:'Peer',path:'relative-input'}})).isError,false);
    assert.equal((await b.client.callTool({name:'save_file',arguments:{wire_id:'ABC',dest_path:'relative-output'}})).isError,false);
    const r=await b.client.callTool({name:'get_files',arguments:{}});assert.equal(r.structuredContent.files[0].readable,false);assert.match(JSON.stringify(r.content),/original transcript/);
    assert.deepEqual(actions,[['read','relative-input'],['close'],['write','relative-output'],['probe','/private/supervisor']]);
  }finally{await b.close();}
});
test('admission fences special handlers and releases after their result',async()=>{
  let live=true,admitted=0,released=0,calls=0;
  const b=await connect({currentIdentity:async()=>{calls++;return {name:'Agent',cid:'A',described:false};}},true,{admit:async()=>{if(!live)throw Error('retired');admitted++;return()=>{released++;};}});
  try{await b.client.callTool({name:'current_identity',arguments:{}});live=false;assert.equal((await b.client.callTool({name:'current_identity',arguments:{}})).isError,true);assert.equal(calls,1);assert.equal(admitted,1);assert.equal(released,1);}finally{await b.close();}
});
test('failed readability callback preserves committed unread batch and transcript without retry',async()=>{
  let commits=0;
  const b=await connect({getFiles:async()=>{commits++;return {text:'irreplaceable transcript',files:[{path:'/private',wire_id:'ABC',filename:'x'}],mode:'unread',remaining:2};}},true,{fileContext:{...noFiles,canRead:async()=>{throw Error('callback disconnected');}}});
  try{const r=await b.client.callTool({name:'get_files',arguments:{}});assert.equal(r.isError,false);assert.equal(r.structuredContent.remaining,2);assert.equal(r.structuredContent.files[0].readable,false);assert.match(JSON.stringify(r.content),/irreplaceable transcript/);assert.equal(commits,1);}finally{await b.close();}
});
