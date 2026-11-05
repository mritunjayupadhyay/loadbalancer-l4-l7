#!/usr/bin/env node
// =============================================================================
// scripts/load-test.js — fire N HTTP requests at a URL and show which backend
// server answered each one, as a bar chart in the terminal.
//
// Usage:
//   node scripts/load-test.js <url> [count] [options]
//
// Examples:
//   node scripts/load-test.js http://localhost:8080/rr/ 30
//   node scripts/load-test.js http://localhost:8080/weighted/ 50
//   node scripts/load-test.js "http://localhost:8080/least/slow?ms=2000&only=app1" 30 -c 10
//   node scripts/load-test.js http://localhost:8080/version/ 10 -H "X-Version: beta"
//   node scripts/load-test.js http://localhost:9090/ 30 --keep-alive
//
// Options:
//   -c, --concurrency N   how many requests are in flight at once (default 1)
//   -H, --header "K: V"   add a request header (can be repeated)
//   --keep-alive          reuse TCP connections between requests (default: a
//                         NEW connection for every request)
//
// Zero dependencies: only Node built-ins.
//
// Why node:http and not fetch()? fetch always reuses connections behind the
// scenes and gives us no simple switch to turn that off. For Layer 4 that
// detail is the whole story: an L4 balancer picks a server per CONNECTION, so
// we need to control whether each request opens a fresh one.
// =============================================================================

const http = require('node:http');

// ---------------------------------------------------------------------------
// 1. Read the command-line arguments.
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const positional = [];
const headers = {};
let concurrency = 1;
let keepAlive = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-c' || a === '--concurrency') {
    concurrency = Number(args[++i]);
  } else if (a === '-H' || a === '--header') {
    const [key, ...rest] = args[++i].split(':');
    headers[key.trim()] = rest.join(':').trim();
  } else if (a === '--keep-alive') {
    keepAlive = true;
  } else if (a === '-h' || a === '--help') {
    console.log('Usage: node scripts/load-test.js <url> [count] [-c N] [-H "Key: Value"] [--keep-alive]');
    process.exit(0);
  } else {
    positional.push(a);
  }
}

const url = positional[0] || 'http://localhost:8080/';
const total = Number(positional[1] || 30);
if (!Number.isInteger(total) || total < 1 || !Number.isInteger(concurrency) || concurrency < 1) {
  console.error('count and concurrency must be positive whole numbers');
  process.exit(1);
}

// An Agent manages TCP connections. keepAlive:false means "open a new TCP
// connection for every request and close it afterwards".
const agent = new http.Agent({ keepAlive, maxSockets: concurrency });

// ---------------------------------------------------------------------------
// 2. Send ONE request and work out which server answered.
// ---------------------------------------------------------------------------
function sendOne() {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get(url, { agent, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        // Our backend puts its name in the JSON body AND in an X-Served-By
        // header. Prefer the header; fall back to the body.
        let server = res.headers['x-served-by'];
        if (!server) {
          try {
            server = JSON.parse(body).server.name;
          } catch {
            server = `(HTTP ${res.statusCode}, unknown server)`;
          }
        }
        resolve({
          server,
          status: res.statusCode,
          ms: Date.now() - started,
          upstream: res.headers['x-upstream-server'], // only set by the L7 port
        });
      });
    });
    req.on('error', (err) => {
      resolve({ server: `ERROR: ${err.code || err.message}`, status: 0, ms: Date.now() - started });
    });
  });
}

// ---------------------------------------------------------------------------
// 3. Run `total` requests with at most `concurrency` in flight at once.
// We start `concurrency` "workers"; each one keeps taking the next request
// number until none are left.
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n🎯 Target:      ${url}`);
  console.log(`📨 Requests:    ${total}   (concurrency ${concurrency}, ${keepAlive ? 'keep-alive: connections REUSED' : 'new TCP connection per request'})`);
  if (Object.keys(headers).length) console.log(`📎 Headers:     ${JSON.stringify(headers)}`);
  console.log('');

  const results = [];
  let next = 0;
  const startedAll = Date.now();

  async function worker() {
    while (next < total) {
      next += 1;
      const r = await sendOne();
      results.push(r);
      // A compact live trace: one coloured-ish token per finished request.
      process.stdout.write(`${r.server} `);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = Date.now() - startedAll;
  agent.destroy();

  // -------------------------------------------------------------------------
  // 4. Summarise: count per server, average latency, and a bar chart.
  // -------------------------------------------------------------------------
  const stats = new Map();
  for (const r of results) {
    const s = stats.get(r.server) || { count: 0, totalMs: 0, upstreams: new Set() };
    s.count += 1;
    s.totalMs += r.ms;
    if (r.upstream) s.upstreams.add(r.upstream);
    stats.set(r.server, s);
  }

  const rows = [...stats.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const nameWidth = Math.max(8, ...rows.map(([name]) => name.length));
  const BAR_WIDTH = 40;
  const max = Math.max(...rows.map(([, s]) => s.count));

  console.log('\n\n📊 Distribution');
  console.log(`${'server'.padEnd(nameWidth)}  count      %   avg ms  chart`);
  console.log('-'.repeat(nameWidth + 60));
  for (const [name, s] of rows) {
    const pct = ((s.count / total) * 100).toFixed(1).padStart(5);
    const avg = String(Math.round(s.totalMs / s.count)).padStart(7);
    const bar = '█'.repeat(Math.max(1, Math.round((s.count / max) * BAR_WIDTH)));
    console.log(`${name.padEnd(nameWidth)}  ${String(s.count).padStart(5)}  ${pct}%  ${avg}  ${bar}`);
  }
  console.log('-'.repeat(nameWidth + 60));
  console.log(`total time: ${(elapsed / 1000).toFixed(2)} s`);

  // If nginx (L7) told us backend addresses, show them — this makes retries
  // visible, e.g. "10.10.10.11:4000, 10.10.10.12:4000" means the first server
  // failed and nginx retried on the second.
  const seen = new Set(results.map((r) => r.upstream).filter(Boolean));
  if (seen.size) {
    console.log(`X-Upstream-Server values seen: ${[...seen].sort().join('  |  ')}`);
  } else {
    console.log('X-Upstream-Server header: (none — this port did not add it)');
  }
  console.log('');
}

main();
