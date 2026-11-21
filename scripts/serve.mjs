import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'";
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const assets = new Set([
  'index.html', 'styles.css', 'favicon.svg', 'sw.js', 'src/app.js', 'src/data.js', 'src/engine.js',
  'src/exchange.js', 'src/fixtures.js', 'src/worksheet.js',
]);
const root = new URL('../', import.meta.url);

export async function serve(port = 0) {
  const intercepted = { count: 0, offline: false };
  const server = createServer(async (request, response) => {
    if (intercepted.offline) {
      intercepted.count++;
      request.socket.destroy();
      return;
    }
    const path = request.url?.split('?', 1)[0];
    const headers = {
      'Content-Security-Policy': CSP, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    };
    const method = request.method;
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end();
    } else if (path === '/' || path === '/clearbill') {
      response.writeHead(302, { ...headers, Location: '/clearbill/' }).end();
    } else {
      const name = path === '/clearbill/' ? 'index.html' : path?.startsWith('/clearbill/') ? path.slice(11) : null;
      if (!assets.has(name)) {
        response.writeHead(404, headers).end();
        return;
      }
      try {
        const bytes = await readFile(new URL(name, root));
        response.writeHead(200, { ...headers, 'Content-Type': mime[extname(name)], 'Content-Length': bytes.length });
        response.end(method === 'GET' ? bytes : undefined);
      } catch { response.writeHead(500, headers).end(); }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server, intercepted, origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { origin } = await serve(Number(process.env.PORT || 4173));
  console.log(`ClearBill at ${origin}/clearbill/`);
}
