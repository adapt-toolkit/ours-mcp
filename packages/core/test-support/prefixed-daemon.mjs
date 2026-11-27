// Separate process: native session tests also exercise synchronous CLI hooks.
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
const [port, upstream, faultPath] = process.argv.slice(2);
createServer((req, res) => {
  if (!req.url.startsWith('/base/daemon/')) { res.writeHead(404).end(); return; }
  let faults={};try{if(faultPath)faults=JSON.parse(readFileSync(faultPath,'utf8'));}catch{}
  if (faults.selection && req.url.endsWith('/selection')) { if(faults.selection==='once')writeFileSync(faultPath,'{}');req.socket.destroy(); return; }
  if (faults.release && req.url.endsWith('/releaseLease')) {res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({error:'Injected release failure',code:'DELETE_PARTIAL'}));return;}
  const forwarded = request(upstream + req.url.slice('/base/daemon'.length), {
    method: req.method, headers: req.headers,
  }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  forwarded.on('error', () => res.writeHead(502).end());
  req.pipe(forwarded);
}).listen(Number(port), '127.0.0.1', () => process.stdout.write('ready\n'));
