// Serves NYC Heroes under /play with Umami's tracker, on one origin with Umami's
// collection endpoints, standing in for the local docker-compose.override.yml (nginx on
// 8060 serving the game export under /play):
//   /                       redirect to /play/
//   /script.js, /api/send   Umami (UMAMI_HOST), so the tracker posts same-origin
//   /play/index.html        the game page with <script data-website-id=...> added
//   anything else           the game's preview server (GAME_SERVER_URL), /play prefix
//                           stripped; WebSocket upgrades (/signal) pass through
import { createServer, request } from 'node:http';
import { connect } from 'node:net';

const PORT = Number(process.env.PORT ?? 8060);
const UMAMI = new URL(process.env.UMAMI_HOST ?? 'http://localhost:3000');
const GAME = new URL(process.env.GAME_SERVER_URL ?? 'http://localhost:8061');
const WEBSITE_ID = process.env.NYC_HEROES_WEBSITE_ID;
const TAG = `<script defer src="/script.js" data-website-id="${WEBSITE_ID}"></script>`;

function forward(req, res, target, path, rewriteHtml) {
  const headers = { ...req.headers, host: target.host };
  if (rewriteHtml) delete headers['accept-encoding'];
  const up = request(
    { host: target.hostname, port: target.port, method: req.method, path, headers },
    (upRes) => {
      const isHtml = rewriteHtml && (upRes.headers['content-type'] ?? '').includes('text/html');
      if (!isHtml) {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
        return;
      }
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8').replace('</head>', `${TAG}</head>`);
        const out = { ...upRes.headers, 'content-length': Buffer.byteLength(html) };
        res.writeHead(upRes.statusCode ?? 200, out).end(req.method === 'HEAD' ? undefined : html);
      });
    },
  );
  up.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`Upstream ${target.host} unavailable: ${err.message}\n`);
  });
  req.pipe(up);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(302, { location: '/play/' }).end();
  } else if (url.pathname === '/script.js' || url.pathname === '/api/send') {
    forward(req, res, UMAMI, req.url, false);
  } else {
    const path = url.pathname.replace(/^\/play(?=\/|$)/, '') || '/';
    const isPage = path === '/' || path === '/index.html';
    forward(req, res, GAME, path + url.search, isPage);
  }
});

server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '/').replace(/^\/play(?=\/|$)/, '') || '/';
  const upstream = connect(Number(GAME.port), GAME.hostname, () => {
    let raw = `${req.method} ${path} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    upstream.write(raw + '\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, () => console.log(`NYC Heroes on :${PORT}/play/ -> ${GAME.href}; tracker -> ${UMAMI.href}`));
