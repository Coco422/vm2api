import { EventEmitter } from 'node:events'
import readline from 'node:readline'

// docker start -ai supplies an operator-only control stream. A fresh nonce
// distinguishes acknowledgements from application output and previous boots.
export function stdioChannel() {
  const channel = new EventEmitter()
  const lines = readline.createInterface({ input: process.stdin })
  let session
  let ready
  channel.send = (msg) => {
    if (msg.type === 'ready') ready = msg
    if (session) console.log('VM2API_ROLLING ' + JSON.stringify({ session, ...msg }))
  }
  lines.on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (!session && msg.type === 'hello' && /^[0-9a-f-]{36}$/.test(msg.session)) {
      session = msg.session
      if (ready) channel.send(ready)
    } else if (session && msg.session === session) channel.emit('message', msg)
  })
  lines.on('close', () => channel.emit('disconnect'))
  return channel
}
