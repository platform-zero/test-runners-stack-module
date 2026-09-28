const dgram = require('node:dgram');
const fs = require('node:fs');

const domain = process.env.DOMAIN;
if (!domain) throw new Error('DOMAIN is required for Android DNS proxy');
const hostGateway = fs.readFileSync('/etc/hosts', 'utf8').split('\n')
  .map((line) => line.trim().split(/\s+/))
  .find((fields) => fields.includes('host.containers.internal'))?.[0];
if (!hostGateway || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostGateway)) {
  throw new Error('Podman host gateway is required for native Android routing');
}
const localHosts = new Map([
  [`mail.${domain}`.toLowerCase(), [10, 0, 2, 2]],
  [`donetick-native.${domain}`.toLowerCase(), hostGateway.split('.').map(Number)],
]);
const upstream = fs.readFileSync('/etc/resolv.conf', 'utf8')
  .match(/^nameserver\s+([^\s]+)$/m)?.[1];
if (!upstream) throw new Error('No upstream DNS server');
const server = dgram.createSocket('udp4');

function question(buffer) {
  const labels = [];
  let offset = 12;
  while (offset < buffer.length) {
    const length = buffer[offset++];
    if (length === 0) break;
    if (length > 63 || offset + length > buffer.length) return null;
    labels.push(buffer.subarray(offset, offset + length).toString('ascii'));
    offset += length;
  }
  if (offset + 4 > buffer.length) return null;
  return { name: labels.join('.').toLowerCase(), type: buffer.readUInt16BE(offset), end: offset + 4 };
}

server.on('message', (request, client) => {
  const q = question(request);
  if (localHosts.has(q?.name) && (q.type === 1 || q.type === 28)) {
    const answer = q.type === 1
      ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...localHosts.get(q.name)])
      : Buffer.alloc(0);
    const reply = Buffer.alloc(q.end + answer.length);
    request.copy(reply, 0, 0, q.end);
    reply.writeUInt16BE(0x8180, 2);
    reply.writeUInt16BE(1, 4);
    reply.writeUInt16BE(q.type === 1 ? 1 : 0, 6);
    reply.writeUInt16BE(0, 8);
    reply.writeUInt16BE(0, 10);
    answer.copy(reply, q.end);
    server.send(reply, client.port, client.address);
    return;
  }
  const forwarded = dgram.createSocket('udp4');
  const timeout = setTimeout(() => forwarded.close(), 5_000);
  forwarded.once('message', (reply) => {
    clearTimeout(timeout);
    server.send(reply, client.port, client.address);
    forwarded.close();
  });
  forwarded.once('error', () => {
    clearTimeout(timeout);
    forwarded.close();
  });
  forwarded.send(request, 53, upstream);
});

server.bind(53, '0.0.0.0');
