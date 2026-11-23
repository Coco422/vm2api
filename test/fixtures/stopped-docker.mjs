import http from 'node:http'
import net from 'node:net'

/** Model Docker's stopped-container inspection without touching a host daemon. */
export async function stoppedDockerFixture(t) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    res.setHeader('content-type', 'application/json')
    if (req.method !== 'GET' || !/^\/containers\/[^/]+\/json$/.test(req.url)) {
      res.writeHead(404)
      res.end('{}')
      return
    }
    res.end(JSON.stringify({ State: { Running: false } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const connect = net.connect
  t.mock.method(net, 'connect', (target, ...args) =>
    connect(
      target === '/var/run/docker.sock' ? { host: '127.0.0.1', port: server.address().port } : target,
      ...args,
    ),
  )
  t.after(async () => {
    t.mock.restoreAll()
    await new Promise((resolve) => server.close(resolve))
  })
  return requests
}
