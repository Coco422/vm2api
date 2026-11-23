// The supervisor owns the public listening socket. Only its inherited IPC channel
// can transfer clients or ask this process to retire. Keep application state local.
export function installRollingChild(server, { shutdown, pendingWrites, channel = process }) {
  const sockets = new Set()
  const panelStreams = new Set()
  let handlers = 0
  let drain = null
  let timer = null
  let reported = false

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  function idle() {
    return sockets.size === 0 && handlers === 0 && pendingWrites() === 0
  }
  function closePanelStreams() {
    for (const response of panelStreams) {
      if (response.headersSent && response.statusCode === 200) response.end()
    }
  }
  async function track(fn, ...args) {
    handlers++
    try {
      return await fn(...args)
    } finally {
      handlers--
    }
  }
  function check() {
    closePanelStreams()
    server.closeIdleConnections()
    if (idle() && !reported) {
      reported = true
      channel.send({ type: 'drained', id: drain })
    }
  }
  channel.once('disconnect', () => {
    clearInterval(timer)
    // Existing sockets belong to this child even if the listener dies.
    timer = setInterval(() => {
      closePanelStreams()
      server.closeIdleConnections()
      if (!idle()) return
      clearInterval(timer)
      void shutdown('supervisor-disconnected')
    }, 50)
  })
  channel.on('message', (msg, socket) => {
    if (msg?.type === 'client' && socket) {
      server.emit('connection', socket)
      socket.resume()
    } else if (msg?.type === 'drain' && !drain) {
      drain = msg.id
      reported = false
      timer = setInterval(check, 25)
      check()
    } else if (drain && msg?.id === drain) {
      if (msg.type === 'resume') {
        clearInterval(timer)
        drain = null
      } else if (msg.type === 'retire') {
        if (!idle()) {
          channel.send({ type: 'busy', id: drain })
          return
        }
        clearInterval(timer)
        // Stop admitting even direct loopback connections before teardown.
        void shutdown('rolling-release')
      }
    }
  })
  return {
    request(fn, req, res) {
      if (req.method === 'GET' && req.url?.split('?', 1)[0] === '/api/panel/pool/stream') {
        if (drain) {
          res.writeHead(503, { Connection: 'close', 'Retry-After': '1' })
          return res.end()
        }
        panelStreams.add(res)
        res.once('close', () => panelStreams.delete(res))
        res.once('finish', () => panelStreams.delete(res))
      }
      return track(fn, req, res)
    },
    track,
    ready() {
      channel.send({ type: 'ready', protocol: 1, port: server.address().port, address: server.address().address })
    },
  }
}
