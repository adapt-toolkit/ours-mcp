// Separate process: native session tests also exercise synchronous CLI hooks.
import { createServer, request } from 'node:http';
const [port, upstream] = process.argv.slice(2);
createServer((req, res) => {
  if (!req.url.startsWith('/base/daemon/')) { res.writeHead(404).end(); return; }
  const forwarded = request(upstream + req.url.slice('/base/daemon'.length), {
    method: req.method, headers: req.headers,
  }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  forwarded.on('error', () => res.writeHead(502).end());
  req.pipe(forwarded);
}).listen(Number(port), '127.0.0.1', () => process.stdout.write('ready\n'));
