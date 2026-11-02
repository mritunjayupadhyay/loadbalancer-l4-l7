// =============================================================================
// backend/server.js — the "real" web application that sits BEHIND the load
// balancer.
//
// We run THREE copies of this exact same file (app1, app2, app3). That is the
// whole point of load balancing: identical servers, so it doesn't matter which
// one answers. The only difference between the copies is the SERVER_NAME
// environment variable, which lets us SEE which copy answered each request.
// =============================================================================

const express = require('express');
const os = require('os');

// -----------------------------------------------------------------------------
// Configuration comes from environment variables.
// Why env vars? Because we want ONE codebase and ONE Docker image, but several
// differently-named instances. Docker Compose sets these per container.
// -----------------------------------------------------------------------------
const SERVER_NAME = process.env.SERVER_NAME || 'app-unnamed';
const PORT = Number(process.env.PORT || 3000);

// A colour/emoji per server so students can tell them apart at a glance in
// both the JSON responses and the terminal logs.
const LOOKS = {
  app1: { emoji: '🔴', color: 'red', ansi: '\x1b[31m' },
  app2: { emoji: '🟢', color: 'green', ansi: '\x1b[32m' },
  app3: { emoji: '🔵', color: 'blue', ansi: '\x1b[34m' },
  app4: { emoji: '🟡', color: 'yellow', ansi: '\x1b[33m' },
};
const look = LOOKS[SERVER_NAME] || { emoji: '⚪', color: 'white', ansi: '\x1b[37m' };
const RESET = '\x1b[0m';

// Each instance counts ONLY its own requests. This is deliberate: it shows that
// the servers do not share memory. If app1 has served 10 requests, app2 has no
// idea. (This is also why "stateful" apps are hard to load balance — see the
// "sticky sessions" section of the README.)
let requestCount = 0;

// How many requests this instance is working on RIGHT NOW. Useful for
// understanding the least_conn algorithm, which picks the server with the
// fewest active connections.
let inFlight = 0;

const app = express();

// Pretty-print JSON (2-space indent) so responses are readable in a plain
// `curl` without needing extra tools like jq.
app.set('json spaces', 2);

// Hide the "X-Powered-By: Express" response header. It's noise for our
// experiments (and in real life it tells attackers what you run).
app.disable('x-powered-by');

// -----------------------------------------------------------------------------
// Middleware: runs for EVERY request before the route handlers.
// We count the request, log it, and add a response header that names this
// server. Logging to stdout means `docker compose logs -f` shows the traffic
// distribution live.
// -----------------------------------------------------------------------------
app.use((req, res, next) => {
  requestCount += 1;
  inFlight += 1;

  // req.socket.remoteAddress is the IP of whoever opened the TCP connection to
  // us. Behind a load balancer that is the LOAD BALANCER's IP, not the real
  // user's. The real user's IP only reaches us if the balancer adds it in a
  // header such as X-Forwarded-For (which only a Layer 7 balancer can do).
  const peer = req.socket.remoteAddress;
  const xff = req.headers['x-forwarded-for'] || '-';
  console.log(
    `${look.ansi}${look.emoji} [${SERVER_NAME}]${RESET} #${requestCount} ` +
      `${req.method} ${req.originalUrl}  tcp-peer=${peer}  x-forwarded-for=${xff}`
  );

  // Our own "who answered?" header. nginx adds X-Upstream-Server with the
  // backend's IP:port; this one carries the friendly name.
  res.set('X-Served-By', SERVER_NAME);

  // When the response is finished (or the client went away), we are no longer
  // busy with it.
  res.on('close', () => {
    inFlight -= 1;
  });
  next();
});

// -----------------------------------------------------------------------------
// Builds the JSON body that most endpoints return. Keeping it in one function
// means every endpoint shows the same, comparable information.
// -----------------------------------------------------------------------------
function describe(req, tag) {
  return {
    message: `${look.emoji} Hello from ${SERVER_NAME}!`,
    tag, // which "pool" or endpoint this is, e.g. "API pool"
    server: {
      name: SERVER_NAME,
      color: look.color,
      hostname: os.hostname(), // the container ID inside Docker
      port: PORT,
      pid: process.pid,
      requestCount, // requests THIS instance has handled since it started
      inFlight, // requests THIS instance is handling right now
    },
    request: {
      method: req.method,
      // The exact path the backend received. Compare it with the URL you typed
      // to see whether nginx rewrote it (see the proxy_pass trailing-slash
      // gotcha in NGINX_EXPLAINED.md).
      pathReceived: req.originalUrl,
      // Who opened the TCP connection to us (the load balancer, usually).
      tcpPeer: req.socket.remoteAddress,
    },
    // The headers students should look at. If a value is missing we show a
    // clear "(not set)" rather than leaving the key out, so the ABSENCE of a
    // header is just as visible as its presence.
    importantHeaders: {
      host: req.headers['host'] || '(not set)',
      'x-forwarded-for': req.headers['x-forwarded-for'] || '(not set)',
      'x-real-ip': req.headers['x-real-ip'] || '(not set)',
      'x-forwarded-proto': req.headers['x-forwarded-proto'] || '(not set)',
    },
    allHeaders: req.headers,
  };
}

// GET / — the main "who am I and what did I receive?" endpoint.
app.get('/', (req, res) => {
  res.json(describe(req, 'default'));
});

// GET /api/info — used for PATH-BASED routing. nginx sends /api/* to an "API
// pool" of servers, so this tag tells you the request arrived via that rule.
app.get('/api/info', (req, res) => {
  res.json(describe(req, 'API pool'));
});

// GET /static/info — the other half of the path-based routing demo.
app.get('/static/info', (req, res) => {
  res.json(describe(req, 'Static pool'));
});

// GET /slow?ms=3000            -> every server waits 3 s before answering.
// GET /slow?ms=3000&only=app1  -> ONLY app1 is slow; the others answer at once.
//
// The "only" option simulates one overloaded/slow server, which is exactly the
// situation where least_conn beats round robin: round robin keeps sending
// app1 its fair share even though app1 is drowning, while least_conn notices
// app1 has many open connections and sends new work elsewhere.
app.get('/slow', (req, res) => {
  const ms = Math.min(Number(req.query.ms) || 3000, 60000); // cap at 60 s
  const only = req.query.only;
  const delay = !only || only === SERVER_NAME ? ms : 0;
  setTimeout(() => {
    res.json({ ...describe(req, 'slow'), waitedMs: delay });
  }, delay);
});

// GET /health — a cheap endpoint that just says "I'm alive". Load balancers
// (and Docker, and Kubernetes) call endpoints like this to decide whether a
// server should receive traffic. Note: open-source nginx does NOT call it on
// its own (that's an nginx Plus feature); we use it for manual checks.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', server: SERVER_NAME });
});

// POST /crash — kills this instance on purpose, to demonstrate failover.
// It's POST (not GET) so a browser prefetch or a curious click can't trigger
// it by accident. We answer first, then exit a moment later so the caller sees
// a goodbye message instead of a broken connection.
app.post('/crash', (req, res) => {
  console.log(`${look.ansi}${look.emoji} [${SERVER_NAME}]${RESET} 💥 crash requested — exiting!`);
  res.json({ message: `💥 ${SERVER_NAME} is crashing now. Bring it back with: docker compose start ${SERVER_NAME}` });
  setTimeout(() => process.exit(1), 100);
});

// Anything else: return the same info with a 404 status. This is a teaching
// aid — if nginx rewrites a URL in a way you didn't expect, you'll see the
// exact pathReceived here instead of a blank "Cannot GET" page.
app.use((req, res) => {
  res.status(404).json({ ...describe(req, 'no route matched (404)') });
});

// Listen on all network interfaces (0.0.0.0), not just localhost. Inside a
// Docker container, "localhost" means "this container only", so nginx (in a
// different container) could not reach us if we bound to 127.0.0.1.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`${look.ansi}${look.emoji} [${SERVER_NAME}]${RESET} listening on port ${PORT} (pid ${process.pid})`);
});
