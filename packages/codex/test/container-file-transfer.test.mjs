import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const plugin of ['codex', 'claude-code']) {
  test(`${plugin} relays host files without changing unrelated MCP messages`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-file-relay-'));
    try {
      const profile = join(dir, 'profile.json');
      const source = join(dir, 'source.bin');
      const destination = join(dir, 'nested', 'saved.bin');
      const transfers = join(dir, 'transfers');
      writeFileSync(source, Buffer.from([0, 1, 2, 255, 10, 13]));
      writeFileSync(profile, JSON.stringify({ composeFile: '/compose.yml', expectedInstanceId: 'daemon' }));
      writeFileSync(join(dir, 'docker'), `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline';
const a=process.argv.slice(2), i=a.indexOf('/opt/ours/node_modules/@ours.network/mcp/dist/container.js'), command=a[i+2], rest=a.slice(i+3), root=process.env.TRANSFERS;
const transfer=(id)=>path.join(root,id), container=(id,name='file')=>'/var/lib/ours/.mcp/transfers/'+id+'/'+name;
if(command==='file-stage'){const [id,name]=rest;fs.mkdirSync(transfer(id),{recursive:true});const out=path.join(transfer(id),name);process.stdin.pipe(fs.createWriteStream(out)).on('finish',()=>console.log(JSON.stringify({path:container(id,name)})));}
else if(command==='file-target'){const [id]=rest;fs.mkdirSync(transfer(id),{recursive:true});console.log(JSON.stringify({path:container(id)}));}
else if(command==='file-read'){const [id]=rest;const p=path.join(transfer(id),'file');if(!fs.existsSync(p))process.exit(44);else fs.createReadStream(p).pipe(process.stdout);}
else if(command==='file-remove'){fs.rmSync(transfer(rest[0]),{recursive:true,force:true});}
else if(command==='proxy'){const rl=readline.createInterface({input:process.stdin});rl.on('line',(line)=>{const m=JSON.parse(line);if(m.method!=='tools/call'){process.stdout.write(line+'\\n');return;}const x=m.params.arguments;if(m.params.name==='send_file'){const p=path.join(transfer(x.path.split('/').at(-2)),x.path.split('/').at(-1));process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'sent'}],structuredContent:{path:x.path,filename:x.filename,bytes:[...fs.readFileSync(p)]},isError:false}})+'\\n');}else if(m.params.name==='save_file'){if(x.wire_id!=='missing')fs.writeFileSync(path.join(transfer(x.dest_path.split('/').at(-2)),'file'),Buffer.from([9,8,7,0,255]));process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'Saved file (wire_id '+x.wire_id+') to '+x.dest_path+' (5 bytes). The bytes were streamed daemon→disk and never entered this result.'}],isError:false}})+'\\n');}});}
`);
      chmodSync(join(dir, 'docker'), 0o755);
      const metadata = '{ "jsonrpc": "2.0", "method": "notifications/initialized", "params": {"native":true} }';
      const calls = [
        metadata,
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_file', arguments: { contact: 'bob', path: source, filename: 'advertised.dat', mime: 'x/test' } } }),
        JSON.stringify({ jsonrpc: '2.0', id: 'save', method: 'tools/call', params: { name: 'save_file', arguments: { wire_id: 'abc123', dest_path: destination } } }),
        JSON.stringify({ jsonrpc: '2.0', id: 'failure', method: 'tools/call', params: { name: 'save_file', arguments: { wire_id: 'missing', dest_path: join(dir, 'must-not-exist') } } }),
      ];
      const proxy = fileURLToPath(new URL(`../../${plugin}/bin/proxy.mjs`, import.meta.url));
      const result = spawnSync(process.execPath, [proxy], { env: { ...process.env, PATH: dir, OURS_CONFIG: profile, TRANSFERS: transfers }, input: calls.join('\n') + '\n', encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      const lines = result.stdout.trimEnd().split('\n');
      assert.equal(lines[0], metadata);
      const sent = JSON.parse(lines[1]);
      assert.deepEqual(sent.result.structuredContent.bytes, [0, 1, 2, 255, 10, 13]);
      assert.equal(sent.result.structuredContent.filename, 'advertised.dat');
      assert.match(sent.result.structuredContent.path, /^\/var\/lib\/ours\/\.mcp\/transfers\/[0-9a-f-]+\/source\.bin$/);
      const saved = JSON.parse(lines[2]);
      assert.equal(saved.id, 'save');
      assert.equal(saved.result.isError, false, JSON.stringify(saved));
      assert.match(saved.result.content[0].text, new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.deepEqual([...readFileSync(destination)], [9, 8, 7, 0, 255]);
      const failed = JSON.parse(lines[3]);
      assert.equal(failed.id, 'failure');
      assert.equal(failed.result.isError, true);
      assert.match(failed.result.content[0].text, /host file transfer failed/);
      assert.deepEqual(existsSync(transfers) ? readdirSync(transfers) : [], []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
