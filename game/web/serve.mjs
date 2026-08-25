import { createReadStream, statSync } from 'node:fs';
import { createServer, request as upstreamRequest } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const host = process.env.DOUJOY_WEB_HOST || '127.0.0.1';
const port = Number(process.env.DOUJOY_WEB_PORT || 8081);
const upstream = new URL(process.env.DOUJOY_WEB_UPSTREAM || 'http://127.0.0.1:4321');
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml' };

function proxy(req, res, pathname, search) {
  const headers = { ...req.headers, host: upstream.host };
  delete headers.origin;
  const sessionToken = headers['x-doujoy-token'];
  if (!headers.authorization && typeof sessionToken === 'string' && sessionToken) {
    headers.authorization = `Bearer ${sessionToken}`;
  }
  delete headers['x-doujoy-token'];
  const proxied = upstreamRequest({ protocol:upstream.protocol, hostname:upstream.hostname, port:upstream.port, method:req.method, path:`${pathname.slice(4) || '/'}${search}`, headers }, response => {
    res.writeHead(response.statusCode || 502, { ...response.headers, 'cache-control':'no-store' });
    response.pipe(res);
  });
  proxied.on('error', () => { if (!res.headersSent) res.writeHead(502, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:false,error:{code:'PREVIEW_UPSTREAM_UNAVAILABLE',message:'公司服务器连接暂不可用，请刷新重试。'}})); });
  req.pipe(proxied);
}

createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return proxy(req, res, url.pathname, url.search);
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const safe = normalize(requested).replace(/^(\.\.(\\|\/|$))+/, '');
  const file = join(root, safe);
  try {
    if (!statSync(file).isFile()) throw new Error('not file');
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control':'no-cache' });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, {'content-type':'text/plain; charset=utf-8'}); res.end('Not found');
  }
}).listen(port, host, () => console.log(`DouJoy web preview listening on http://${host}:${port}; upstream ${upstream}`));
