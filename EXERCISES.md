# 🧪 Exercises — Load Balancing Lab

Ten guided experiments. Each one has a **goal**, the **commands**, **what to
look at**, a **sample of the expected output**, and a **Why?** explanation.

**Before you start:**

```bash
docker compose up --build -d     # start the lab in the background
docker compose ps                # all 7 containers should be "Up"
```

Keep a second terminal open with live logs, because watching them is half the fun:

```bash
docker compose logs -f nginx app1 app2 app3
```

> 💡 Your numbers can differ slightly from the samples (for example, which
> server comes *first* depends on what earlier requests did). The **pattern** is
> what matters. Your client IP will also differ: on Docker Desktop (Mac/Windows)
> it's usually `192.168.65.1`, while on Linux it's the Docker gateway, `10.10.10.1`.

| # | Experiment | Layer |
|---|---|---|
| 1 | Round robin distribution | L7 |
| 2 | Weighted round robin (3:1:1) | L7 |
| 3 | least_conn vs round robin | L7 + L4 |
| 4 | ip_hash and consistent hashing (stickiness) | L7 + L4 |
| 5 | Crash a server: failover and recovery | L7 + L4 |
| 6 | Path-based routing | L7 |
| 7 | Header-based routing (beta users) | L7 |
| 8 | **L4 vs L7: who adds the headers?** ⭐ | both |
| 9 | Non-HTTP traffic through L4 | L4 |
| 10 | Challenges | — |

---

## Exercise 1 — Round robin

**Goal:** see the default algorithm hand out requests in turn.

```bash
node scripts/load-test.js http://localhost:8080/rr/ 30
```

**Observe:** the live trace line cycles app1 → app2 → app3, and the table is a
perfect three-way split.

**Expected output:**

```
🎯 Target:      http://localhost:8080/rr/
📨 Requests:    30   (concurrency 1, new TCP connection per request)

app3 app1 app2 app3 app1 app2 app3 app1 app2 app3 app1 app2 ... app1 app2

📊 Distribution
server    count      %   avg ms  chart
--------------------------------------------------------------------
app1         10   33.3%        2  ████████████████████████████████████████
app2         10   33.3%        2  ████████████████████████████████████████
app3         10   33.3%        3  ████████████████████████████████████████
--------------------------------------------------------------------
total time: 0.07 s
X-Upstream-Server values seen: 10.10.10.11:4000  |  10.10.10.12:4000  |  10.10.10.13:4000
```

Also try one request by hand and look at the headers:

```bash
curl -i http://localhost:8080/rr/
```

```
HTTP/1.1 200 OK
Server: nginx/1.28.3
...
X-Served-By: app2
X-Upstream-Server: 10.10.10.12:4000
```

**Why?** With no algorithm directive, an nginx `upstream` uses round robin: it
keeps a pointer and moves it one step for every request. `X-Upstream-Server` is
added by nginx (`add_header ... $upstream_addr`) and shows the backend's IP:port
(`.11` = app1, `.12` = app2, `.13` = app3). `X-Served-By` is added by the app
itself.

> 🤔 Think: round robin gives every server the same *number* of requests. Is
> that the same as the same amount of *work*? (Exercise 3 answers this.)

---

## Exercise 2 — Weighted round robin

**Goal:** give app1 three times as much traffic as the others.

```bash
node scripts/load-test.js http://localhost:8080/weighted/ 30
```

**Observe:** app1 gets 60%, app2 and app3 20% each, and the requests are
**interleaved**, not "app1 app1 app1 app2 app3".

**Expected output:**

```
app1 app2 app1 app3 app1 app1 app2 app1 app3 app1 app1 app2 app1 app3 app1 ...

📊 Distribution
server    count      %   avg ms  chart
--------------------------------------------------------------------
app1         18   60.0%        2  ████████████████████████████████████████
app2          6   20.0%        2  █████████████
app3          6   20.0%        1  █████████████
```

**Why?** `server app1:4000 weight=3;` gives app1 3 "tickets" out of 5
(3 + 1 + 1). nginx uses *smooth* weighted round robin, which spreads app1's turns
out (`app1 app2 app1 app3 app1`) so app1 never receives a burst of 3 in a row.
Use weights when servers have different capacity, or to send, say, 10% of
traffic to a new version.

---

## Exercise 3 — least_conn vs round robin

**Goal:** see why "taking turns" is a bad idea when one server is slow.

`/slow?ms=2000&only=app1` makes **only app1** wait 2 seconds; app2 and app3
answer immediately. Pretend app1 is overloaded. We send 30 requests, 6 at a
time (`-c 6`).

```bash
# Round robin
node scripts/load-test.js "http://localhost:8080/rr/slow?ms=2000&only=app1" 30 -c 6

# Least connections
node scripts/load-test.js "http://localhost:8080/least/slow?ms=2000&only=app1" 30 -c 6
```

> ⚠️ Keep the quotes around the URL; otherwise your shell treats `&` as
> "run in background".

**Observe:** the **count** for app1 and the **total time**.

**Expected output — round robin:**

```
server    count      %   avg ms  chart
--------------------------------------------------------------------
app1         10   33.3%     2007  ████████████████████████████████████████
app2         10   33.3%        5  ████████████████████████████████████████
app3         10   33.3%        6  ████████████████████████████████████████
--------------------------------------------------------------------
total time: 4.04 s
```

**Expected output — least_conn:**

```
server    count      %   avg ms  chart
--------------------------------------------------------------------
app1          2    6.7%     2018  ██████
app2         14   46.7%        5  ████████████████████████████████████████
app3         14   46.7%        5  ████████████████████████████████████████
--------------------------------------------------------------------
total time: 2.02 s
```

(app1's exact count under least_conn varies between runs, usually 1–4.)

**Why?** Round robin is blind: it keeps giving app1 every third request even
though app1 is stuck, so a third of your users wait 2 s and the whole batch takes
twice as long. `least_conn` counts **open connections** per server. app1's slow
requests stay open, so app1 always has the most and new requests go to app2/app3.
app1 only gets work when it's tied with the others. No configuration about
"slowness" was needed; the connection count reveals it.

**Same thing at Layer 4:** port 9091 is a `stream` upstream with `least_conn`.
L4 can count TCP connections too:

```bash
node scripts/load-test.js "http://localhost:9091/slow?ms=2000&only=app1" 30 -c 6
```

```
app1          2    6.7%     2011  █████
app2         15   50.0%        3  ████████████████████████████████████████
app3         13   43.3%        3  ███████████████████████████████████
total time: 2.02 s
```

---

## Exercise 4 — ip_hash and consistent hashing (stickiness)

**Goal:** the same client always lands on the same server.

### 4a. ip_hash from your computer

```bash
node scripts/load-test.js http://localhost:8080/iphash/ 12
```

```
server    count      %   avg ms  chart
--------------------------------------------------------------------
app3         12  100.0%        2  ████████████████████████████████████████
```

All 12 go to **one** server (which one depends on your IP). Compare with `/rr/`,
which spreads the same 12 requests three ways. Run it again: same server.

### 4b. ip_hash from "different clients"

Each container has its own IP, so let's make requests from inside them:

```bash
for c in app1 app2 app3 tcp-echo-1; do
  echo -n "$c -> "
  docker compose exec -T $c wget -qO- http://nginx:8080/iphash/ | grep '"name"'
done
```

```
app1 ->     "name": "app1",
app2 ->     "name": "app1",
app3 ->     "name": "app1",
tcp-echo-1 ->     "name": "app1",
```

😮 Four different clients (10.10.10.11, .12, .13, .21) all went to the **same**
server!

**Why?** nginx's `ip_hash` only hashes the **first three octets** of an IPv4
address (`10.10.10`). Every client in the same /24 network counts as "the same
client". The real-world version of this: a whole office behind one NAT IP all
lands on one server. Stickiness by IP is simple but can be very uneven.

### 4c. Consistent hash on a user id (better stickiness)

`/userhash/` hashes the `X-User-Id` header instead of the IP:

```bash
for u in alice bob carol dave erin alice bob; do
  echo -n "$u -> "
  curl -s -H "X-User-Id: $u" http://localhost:8080/userhash/ | grep '"name"'
done
```

```
alice ->     "name": "app2",
bob ->     "name": "app2",
carol ->     "name": "app3",
dave ->     "name": "app3",
erin ->     "name": "app1",
alice ->     "name": "app2",
bob ->     "name": "app2",
```

Different users spread across servers, but **alice always gets app2**.

### 4d. At Layer 4

Port 9092 uses `hash $remote_addr consistent` (the whole IP):

```bash
node scripts/load-test.js http://localhost:9092/ 12
```

```
app3         12  100.0%        3  ████████████████████████████████████████
```

**Why?** Hashing turns a key (IP, user id) into a number that always maps to the
same server. That's "sticky" without storing anything. L4 can only hash things it
can see (IP, port). L7 can hash anything in the request (header, cookie, URL).
Remember the trade-off from the README: stickiness is a workaround for stateful
apps, and stateless apps don't need it.

---

## Exercise 5 — Crash a server: failover and recovery

**Goal:** kill app2 and watch nginx route around it with **zero errors**, then
bring it back.

**Step 1: crash app2.** Send the crash **directly** to app2's own port (4002).
Through nginx you couldn't choose which server gets it.

```bash
curl -X POST http://localhost:4002/crash
docker compose ps -a        # lab-app2 now shows "Exited (1)"
```

```json
{
  "message": "💥 app2 is crashing now. Bring it back with: docker compose start app2"
}
```

**Step 2: send traffic through the L7 balancer.**

```bash
node scripts/load-test.js http://localhost:8080/rr/ 12
```

```
app1 app3 app3 app1 app3 app1 app3 app1 app3 app1 app3 app1

📊 Distribution
server    count      %   avg ms  chart
--------------------------------------------------------------------
app1          6   50.0%        4  ████████████████████████████████████████
app3          6   50.0%      172  ████████████████████████████████████████
--------------------------------------------------------------------
total time: 1.05 s
X-Upstream-Server values seen: 10.10.10.11:4000  |  10.10.10.12:4000, 10.10.10.13:4000  |  10.10.10.13:4000
```

**Observe:**
- **No errors.** All 12 requests succeeded.
- One `X-Upstream-Server` value is `10.10.10.12:4000, 10.10.10.13:4000`: nginx
  **tried app2, failed, and retried on app3** within the same request.
- That one request took ~1 s (the `proxy_connect_timeout`). That's why app3's
  *average* is higher. After that, app2 is skipped entirely.

**Step 3: read nginx's side of the story:**

```bash
docker compose logs nginx | grep -E 'warn|error|10.10.10.12:4000, '
```

```
[warn] ... upstream server temporarily disabled while connecting to upstream ... upstream: "http://10.10.10.12:4000/"
[error] ... upstream timed out (110: Operation timed out) while connecting to upstream ... upstream: "http://10.10.10.12:4000/"
L7 192.168.65.1 "GET /rr/ HTTP/1.1" status=200 upstream=10.10.10.12:4000, 10.10.10.13:4000 upstream_status=504, 200 time=1.006, 0.003s
```

**Step 4: the same at Layer 4:**

```bash
node scripts/load-test.js http://localhost:9090/ 6
```

```
app1          2   33.3%        4  ████████████████████
app3          4   66.7%      258  ████████████████████████████████████████
```

L4 fails over too, because the **TCP connect** to app2 fails and nginx tries
the next server. (But L4 can only detect "can't connect". If app2 were alive and
returning HTTP 500 errors, the L4 balancer would never know, since it can't read
status codes. The L7 balancer can be told to retry on 502/503/504.)

**Step 5: bring it back.**

```bash
docker compose start app2
sleep 10                                     # wait out fail_timeout=10s
node scripts/load-test.js http://localhost:8080/rr/ 9
```

```
app1          3   33.3%        3  ██████████████████████████████
app2          2   22.2%        6  ████████████████████
app3          4   44.4%        5  ████████████████████████████████████████
```

app2 is back in the rotation. Run it once more and it's an even 3/3/3.

**Why?** These are **passive health checks**: `max_fails=1 fail_timeout=10s`
means "after 1 failure, consider the server down for 10 s, then try it again
with a real request". `proxy_next_upstream error timeout ...` makes nginx retry
the failed request on the next server instead of returning an error to the user.
The container is configured with `restart: "no"` so it stays dead until you
start it, which lets you see the failover.

> ⚠️ Don't run `nginx -s reload` while a backend is stopped. nginx will refuse
> the reload with `host not found in upstream "app2:4000"` (Docker removes the
> DNS name of a stopped container). nginx keeps running with its old config, so
> nothing breaks; start the backend and reload again.

---

## Exercise 6 — Path-based routing

**Goal:** send different URLs to different groups of servers.

```bash
node scripts/load-test.js http://localhost:8080/api/info 10
node scripts/load-test.js http://localhost:8080/static/info 10
curl -s http://localhost:8080/api/info | grep -E '"tag"|pathReceived'
```

**Expected output:**

```
# /api/info
app1          5   50.0%        4  ████████████████████████████████████████
app2          5   50.0%        3  ████████████████████████████████████████

# /static/info
app3         10  100.0%        3  ████████████████████████████████████████

# curl
  "tag": "API pool",
    "pathReceived": "/api/info",
```

**Observe:** `/api/` **never** reaches app3, and `/static/` **only** reaches
app3. The backend received `/api/info` unchanged.

**Why?** nginx read the URL (Layer 7!) and matched it against
`location /api/ { proxy_pass http://api_pool; }`. `api_pool` contains only
app1 and app2. This is how one domain can be served by many specialised
services ("microservices"). Note that `proxy_pass http://api_pool;` has **no
trailing slash**, so the path is passed through unchanged. Compare with
`/rr/`, which strips the prefix (see `NGINX_EXPLAINED.md`, "the trailing-slash
gotcha").

**Now try the same at Layer 4:**

```bash
node scripts/load-test.js http://localhost:9090/static/info 9
```

```
app1          3   33.3%        2  ████████████████████████████████████████
app2          3   33.3%        2  ████████████████████████████████████████
app3          3   33.3%        4  ████████████████████████████████████████
```

`/static/` hits **all three** servers. Port 9090 never saw the path.

---

## Exercise 7 — Header-based routing (beta users)

**Goal:** send users with a special header to a different version.

```bash
node scripts/load-test.js http://localhost:8080/version/ 10
node scripts/load-test.js http://localhost:8080/version/ 10 -H "X-Version: beta"
```

Or by hand:

```bash
curl -s http://localhost:8080/version/ | grep '"name"'
curl -s -H "X-Version: beta" http://localhost:8080/version/ | grep '"name"'
```

**Expected output:**

```
# no header ("stable")
app1          5   50.0%        3  ████████████████████████████████████████
app2          5   50.0%        2  ████████████████████████████████████████

# X-Version: beta
app3         10  100.0%        3  ████████████████████████████████████████
```

**Why?** In `l7-http.conf`, a `map` turns the header into an upstream name:

```nginx
map $http_x_version $version_pool {
    default  stable_pool;   # app1 + app2
    beta     beta_pool;     # app3
}
```

and `proxy_pass http://$version_pool;` uses it. This is the basic idea behind
**canary releases** and A/B tests: route a chosen group (testers, 5% of users,
employees) to the new version by header or cookie. A Layer 4 balancer can't do
this because it never reads headers.

---

## Exercise 8 — ⭐ L4 vs L7: who adds the headers?

**Goal:** the key "aha" moment. Send the **same** request to the **same**
backends through L7 (8080) and L4 (9090), and compare what the backend received.

```bash
echo "===== via LAYER 7 (8080) ====="
curl -s http://localhost:8080/ | grep -A5 importantHeaders

echo "===== via LAYER 4 (9090) ====="
curl -s http://localhost:9090/ | grep -A5 importantHeaders
```

**Expected output:**

```
===== via LAYER 7 (8080) =====
  "importantHeaders": {
    "host": "localhost",
    "x-forwarded-for": "192.168.65.1",
    "x-real-ip": "192.168.65.1",
    "x-forwarded-proto": "http"
  },
===== via LAYER 4 (9090) =====
  "importantHeaders": {
    "host": "localhost:9090",
    "x-forwarded-for": "(not set)",
    "x-real-ip": "(not set)",
    "x-forwarded-proto": "(not set)"
  },
```

Now look at who the backend thinks it's talking to:

```bash
curl -s http://localhost:8080/ | grep tcpPeer
curl -s http://localhost:9090/ | grep tcpPeer
```

```
    "tcpPeer": "10.10.10.2"
    "tcpPeer": "10.10.10.2"
```

And compare the **response** headers:

```bash
curl -si http://localhost:8080/ | head -9
curl -si http://localhost:9090/ | head -8
```

```
# 8080 (L7)                                   # 9090 (L4)
HTTP/1.1 200 OK                               HTTP/1.1 200 OK
Server: nginx/1.28.3                          X-Served-By: app1
Date: Sat, 31 Oct 2026 11:00:23 GMT           Content-Type: application/json; charset=utf-8
Content-Type: application/json; charset=utf-8 Content-Length: 586
Content-Length: 710                           ETag: W/"24a-VIv5165nd+wK51GFIQYvg1giJ2Y"
Connection: keep-alive                        Date: Sat, 31 Oct 2026 11:00:23 GMT
X-Served-By: app2                             Connection: keep-alive
ETag: W/"2c6-MfFl4duYndjMTVNRBb/FSIWnyJw"     Keep-Alive: timeout=5
X-Upstream-Server: 10.10.10.12:4000
```

**Observe:**
1. Through **L7**, the backend got `X-Forwarded-For` and `X-Real-IP` with **your**
   IP. Through **L4** it got nothing.
2. In **both** cases the TCP peer (`tcpPeer`) is `10.10.10.2`, **nginx's** IP.
   Without the header, the backend has **no way** of knowing your real IP.
3. Through L4, `Host` is `localhost:9090`, exactly what curl sent. Through L7,
   nginx *rewrote* it to `$host` (`localhost`).
4. Through L4, the response has **no `Server: nginx`** and **no
   `X-Upstream-Server`**. nginx didn't touch the response at all. What you
   received is byte-for-byte what Express sent.

**Why?** To add a header you must **understand HTTP**: find where the headers
end, insert a line, and fix things up. The `http {}` block does exactly that
(`proxy_set_header`). The `stream {}` block sees only an opaque stream of bytes;
it doesn't know those bytes *are* HTTP, so it can't add, remove or route on
anything inside them. In production, L4 balancers solve the "real client IP"
problem with the **PROXY protocol** (nginx: `proxy_protocol on;`), which the
backend must explicitly support.

**Bonus — L4 balances connections, not requests:**

```bash
node scripts/load-test.js http://localhost:9090/ 30 --keep-alive
node scripts/load-test.js http://localhost:8080/rr/ 30 --keep-alive
```

```
# 9090 (L4) with keep-alive
app3         30  100.0%        1  ████████████████████████████████████████

# 8080 (L7) with keep-alive
app1         10   33.3%        1  ████████████████████████████████████████
app2         10   33.3%        1  ████████████████████████████████████████
app3         10   33.3%        0  ████████████████████████████████████████
```

With `--keep-alive`, the script sends all 30 requests over **one** TCP
connection. L4 picked a server when the connection opened, and every request on
it went there. L7 balances **each request** separately, even on one connection.
This matters a lot for gRPC, HTTP/2 and WebSockets, which keep connections
open for a long time.

---

## Exercise 9 — Non-HTTP traffic through Layer 4

**Goal:** prove that L4 can balance **any** TCP protocol, and L7 can't.

```bash
node scripts/tcp-client.js            # 6 connections to port 9000 (L4 -> tcp-echo)
```

```
🔌 Opening 6 TCP connections to localhost:9000

connection #1  ->  [tcp-echo-2] you said: hello from connection #1
connection #2  ->  [tcp-echo-3] you said: hello from connection #2
connection #3  ->  [tcp-echo-1] you said: hello from connection #3
connection #4  ->  [tcp-echo-2] you said: hello from connection #4
connection #5  ->  [tcp-echo-3] you said: hello from connection #5
connection #6  ->  [tcp-echo-1] you said: hello from connection #6
```

Round robin over a protocol nginx has never heard of. ✅ Check the log:

```bash
docker compose logs nginx | grep ':9000' | tail -3
```

```
L4 192.168.65.1 -> :9000 upstream=10.10.10.21:7000 status=200 bytes_in=25 bytes_out=48 session=0.002s
```

The L4 log has **no URL, no method, no HTTP status**, only addresses, bytes and
duration. (`status=200` here is nginx's code for "TCP session ended normally",
not an HTTP status.)

**Now send the same protocol to the L7 port:**

```bash
node scripts/tcp-client.js 8080 2
```

```
connection #1  ->  HTTP/1.1 400 Bad Request
connection #2  ->  HTTP/1.1 400 Bad Request
```

nginx's `http` module tried to parse `hello from connection #1` as an HTTP
request line, failed, and rejected it. It **never reached a backend**:

```bash
docker compose logs nginx | grep '"hello' | tail -1
```

```
L7 192.168.65.1 "hello from connection #2" status=400 upstream=- upstream_status=- time=-s
```

(`upstream=-` means "no backend was contacted".)

**And to the L4 HTTP port, 9090?**

```bash
node scripts/tcp-client.js 9090 3
```

```
connection #1  ->  HTTP/1.1 400 Bad Request
```

Also a 400, but from a **different place!** Here nginx happily forwarded our
bytes (it doesn't care what they are) to an **Express** server, and *Express*
rejected them. The nginx log shows a backend was used and the session was "fine":

```
L4 192.168.65.1 -> :9090 upstream=10.10.10.11:4000 status=200 bytes_in=25 bytes_out=47 session=0.001s
```

**Why?** L7 = "I only speak HTTP; I check and understand every request." L4 =
"I'm a pipe; I'll connect you to *something* and copy bytes." Whether the
protocol makes sense is the backend's problem. That's why databases, message
brokers, mail servers and game servers are balanced at L4.

---

## Exercise 10 — Challenges 🏆

Each one involves editing a file. After editing nginx config:

```bash
docker compose exec nginx nginx -t           # did I break anything?
docker compose exec nginx nginx -s reload    # apply
```

### 10.1 Add a fourth server

1. In `docker-compose.yml`, copy the `app3` block to `app4` with
   `SERVER_NAME: app4`, `container_name: lab-app4`, `ports: ["3004:4000"]` and
   `ipv4_address: 10.10.10.14`.
2. Add `server app4:4000 max_fails=1 fail_timeout=10s;` to `upstream backend_rr`
   in `l7-http.conf`.
3. Run `docker compose up -d` (this starts app4), then
   `docker compose exec nginx nginx -s reload`.
4. Run `node scripts/load-test.js http://localhost:8080/rr/ 40`. Expect 10 each.
   (app4 has a 🟡 already prepared in `server.js`.)

### 10.2 Change an algorithm

Make `/rr/` use `least_conn` by adding `least_conn;` as the first line in
`upstream backend_rr`. Re-run Exercise 3's round-robin command. What changed?

### 10.3 Add a rate limit (L7 only!)

Allow each client IP 5 requests per second on `/rr/`. In `l7-http.conf`, inside
`http { }` (outside `server`):

```nginx
limit_req_zone $binary_remote_addr zone=perip:1m rate=5r/s;
limit_req_status 429;
```

and inside `location /rr/ { }`:

```nginx
limit_req zone=perip;
```

Then `node scripts/load-test.js http://localhost:8080/rr/ 30 -c 10`. Almost
every row is `(HTTP 429, unknown server)`: nginx rejected those requests itself
without bothering a backend. 5 r/s means "one request every 200 ms", so a burst
of 30 at once mostly fails. Now change it to `limit_req zone=perip burst=10 nodelay;`
and run again. How many get through now, and why?
**Question:** could you do this on port 9090? (Hint: what is a "request" at L4?
Look up `limit_conn` in the stream module.)

### 10.4 Route by Host name

Make `curl -H "Host: api.local" http://localhost:8080/` go to `api_pool` and
every other host go to `backend_rr`. (Hint: a second `server { }` block with
`server_name api.local;` that also has `listen 8080;`. **Put it after the
existing server block.** The *first* server block for a port becomes the
default for any Host that doesn't match, so if yours comes first it steals all
the traffic. Try it both ways!)

### 10.5 Weighted canary

Change `upstream backend_weighted` so app3 (the "new version") gets only 10% of
traffic. Verify with 50 requests.

### 10.6 Retry on HTTP errors

Make app1's `/` sometimes return `503` (edit `server.js`, rebuild with
`docker compose up --build -d`). Show that `/rr/` still always returns 200 (L7
retries on `http_503`) but port 9090 passes the 503s straight through to you.
Explain why.

### 10.7 Think and discuss 💬

1. Your company runs PostgreSQL on 3 read replicas. L4 or L7? Why?
2. You want `/admin` only reachable from the office IP. L4 or L7?
3. A user complains that the website "forgets their login" randomly. What is
   probably stored where, and what are two ways to fix it?
4. Why does the app see `tcpPeer: 10.10.10.2` for every request, and why is
   blindly trusting `X-Forwarded-For` from *anyone* a security problem?
5. When would you put an L4 balancer **in front of** L7 balancers?
