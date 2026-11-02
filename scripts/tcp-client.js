#!/usr/bin/env node
// =============================================================================
// scripts/tcp-client.js — open several raw TCP connections and send one line
// of text on each, then print the reply. No HTTP involved.
//
// Usage:
//   node scripts/tcp-client.js [port] [connections] [host]
//
// Examples:
//   node scripts/tcp-client.js            # 6 connections to localhost:9000 (L4 -> tcp-echo)
//   node scripts/tcp-client.js 9000 9
//   node scripts/tcp-client.js 8080 1     # try our protocol on the L7 HTTP port (it fails!)
//
// Each connection is opened one after another, so with round robin you should
// see tcp-echo-1, tcp-echo-2, tcp-echo-3, tcp-echo-1, ...
// =============================================================================

const net = require('node:net');

const port = Number(process.argv[2] || 9000);
const connections = Number(process.argv[3] || 6);
const host = process.argv[4] || 'localhost';

// Open ONE connection, send one line, and resolve with whatever comes back.
function talk(n) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let reply = '';
    socket.setEncoding('utf8');

    // Give up after 3 seconds so a silent server can't hang the script.
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(reply || '(no reply within 3 s)');
    });

    socket.on('connect', () => {
      // Our made-up protocol: one line of text ending in "\n".
      socket.write(`hello from connection #${n}\n`);
    });

    socket.on('data', (chunk) => {
      reply += chunk;
      // The echo server answers with exactly one line. Once we have it we're
      // done, so close our side of the connection.
      if (reply.includes('\n')) socket.end();
    });

    socket.on('close', () => resolve(reply.trim() || '(connection closed with no reply)'));
    socket.on('error', (err) => resolve(`ERROR: ${err.code || err.message}`));
  });
}

async function main() {
  console.log(`\n🔌 Opening ${connections} TCP connections to ${host}:${port}\n`);
  for (let n = 1; n <= connections; n++) {
    const reply = await talk(n);
    // Show only the first line: if we hit an HTTP port the reply is a whole
    // HTTP error page and the first line ("HTTP/1.1 400 Bad Request") says it all.
    const firstLine = reply.split('\n')[0];
    console.log(`connection #${n}  ->  ${firstLine}`);
  }
  console.log('');
}

main();
