// =============================================================================
// tcp-echo/server.js — a tiny server that speaks a made-up, NON-HTTP protocol.
//
// Why does this exist? To prove that a Layer 4 load balancer does not care
// what protocol you speak. It just moves TCP bytes. This server doesn't
// understand HTTP at all: you send it a line of text, it sends a line back.
//
// We use Node's built-in `net` module (raw TCP sockets) instead of Express,
// because Express only speaks HTTP. No dependencies needed.
// =============================================================================

const net = require('net');

const SERVER_NAME = process.env.SERVER_NAME || 'tcp-echo';
const PORT = Number(process.env.PORT || 7000);

let connectionCount = 0;

// net.createServer gives us a callback for every new TCP CONNECTION.
// Notice there are no "requests", "URLs" or "headers" here — those are HTTP
// (Layer 7) ideas. At Layer 4 there are only connections and bytes.
const server = net.createServer((socket) => {
  connectionCount += 1;
  const id = connectionCount;
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[${SERVER_NAME}] connection #${id} from ${peer}`);

  // Treat incoming bytes as UTF-8 text.
  socket.setEncoding('utf8');

  // A simple line-based protocol: collect bytes until we see a newline, then
  // reply to that line. TCP is a stream, so one "message" may arrive split
  // across several 'data' events — buffering handles that.
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      console.log(`[${SERVER_NAME}] #${id} received: ${line}`);
      socket.write(`[${SERVER_NAME}] you said: ${line}\n`);
    }
  });

  socket.on('error', (err) => {
    // A client vanishing mid-conversation is normal; just note it.
    console.log(`[${SERVER_NAME}] #${id} socket error: ${err.message}`);
  });

  socket.on('close', () => {
    console.log(`[${SERVER_NAME}] connection #${id} closed`);
  });
});

// 0.0.0.0 = accept connections from other containers, not just localhost.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[${SERVER_NAME}] TCP echo server listening on port ${PORT}`);
});
