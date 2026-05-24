'use strict'

const os = require('os')
const WebSocket = require('ws')
const { assertSecureServerUrl } = require('../url-security')
const { listLocations } = require('./fs-browser')

function createConnector(config, ptyManager) {
  assertSecureServerUrl(config.serverUrl)

  let reconnectDelay = 1000
  const MAX_DELAY = 30000

  function connect() {
    const wsUrl = config.serverUrl
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://')
      + '/ws/agent'

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: 'Bearer ' + config.agentId + ':' + config.agentSecret }
    })

    ws.on('open', () => {
      reconnectDelay = 1000
      ws.send(JSON.stringify({
        type: 'hello',
        agentId: config.agentId,
        hostname: os.hostname(),
        platform: process.platform,
        shells: ptyManager.availableShells,
        sessions: ptyManager.listSessions()
      }))
      console.log('Connected to server at ' + wsUrl)
    })

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }

      switch (msg.type) {
        case 'spawn':
          ptyManager.spawn(
            msg.sessionId,
            msg.shell,
            msg.cols || 220,
            msg.rows || 50,
            msg.cwd,
            (data) => {
              if (ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: 'output', sessionId: msg.sessionId, data }))
            },
            (code) => {
              if (ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: 'exit', sessionId: msg.sessionId, code }))
            }
          )
          break
        case 'input':
          if (!ptyManager.write(msg.sessionId, msg.data) && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'output',
              sessionId: msg.sessionId,
              data: '\r\n[ATerminal] This session is not running on the agent anymore.\r\n'
            }))
            ws.send(JSON.stringify({ type: 'exit', sessionId: msg.sessionId, code: 410 }))
          }
          break
        case 'resize':
          ptyManager.resize(msg.sessionId, msg.cols, msg.rows)
          break
        case 'kill':
          ptyManager.kill(msg.sessionId)
          break
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }))
          break
        case 'fs:list':
          handleRequest(ws, msg, async () => listLocations(msg.path))
          break
        case 'fs:read':
          handleRequest(ws, msg, async () => {
            const filePath = msg.path
            if (!filePath || typeof filePath !== 'string') throw new Error('path is required')
            if (filePath.length > 2048) throw new Error('path too long')
            const resolved = require('path').resolve(filePath)
            const stat = await require('fs/promises').stat(resolved)
            if (!stat.isFile()) throw new Error('Not a file')
            const MAX_SIZE = 50 * 1024 * 1024 // 50MB limit
            if (stat.size > MAX_SIZE) throw new Error('File too large (max 50MB)')
            const data = await require('fs/promises').readFile(resolved)
            return { data: data.toString('base64'), size: stat.size, name: require('path').basename(resolved) }
          })
          break
      }
    })

    ws.on('close', (code, reason) => {
      console.log('Disconnected from server (' + code + '). Reconnecting in ' + reconnectDelay / 1000 + 's...')
      setTimeout(() => connect(), reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY)
    })

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message)
      // close event will follow and handle reconnect
    })
  }

  return { connect }
}

async function handleRequest(ws, msg, handler) {
  if (!msg.requestId) return
  try {
    const data = await handler()
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, ok: true, data }))
    }
  } catch (err) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'response',
        requestId: msg.requestId,
        ok: false,
        error: err.message || 'Request failed',
      }))
    }
  }
}

module.exports = { createConnector }
