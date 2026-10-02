const net = require('node:net');

for (const [listenPort, upstreamPort] of [[1993, 993], [1587, 587]]) {
  net.createServer((client) => {
    const upstream = net.connect(upstreamPort, 'host.containers.internal');
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  }).listen(listenPort, '0.0.0.0');
}
