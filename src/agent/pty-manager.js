'use strict'

const pty = require('node-pty')
const os = require('os')
const fs = require('fs')

const BUFFER_MAX = 500 * 1024 // 500KB per session

const SHELL_MAP = {
  powershell: 'powershell.exe',
  cmd: 'cmd.exe',
  wsl: 'wsl.exe',
  bash: '/bin/bash',
  zsh: '/bin/zsh',
  sh: '/bin/sh',
  fish: 'fish',
}

function createPtyManager(availableShells) {
  const availableShellSet = new Set(Array.isArray(availableShells) ? availableShells : [])
  const sessions = new Map() // sessionId → { ptyProcess, buffer, onData, onExit }

  function spawn(sessionId, shell, cols, rows, cwd, onData, onExit) {
    if (!availableShellSet.has(shell)) {
      onData('[ATerminal] Shell is not available on this agent: ' + shell + '\r\n')
      onExit(126)
      return
    }

    const shellExe = SHELL_MAP[shell] || shell
    let ptyProcess
    try {
      const resolvedCwd = resolveCwd(cwd)
      ptyProcess = pty.spawn(shellExe, [], {
        name: 'xterm-256color',
        cols: clampInt(cols, 20, 500) || 220,
        rows: clampInt(rows, 5, 200) || 50,
        cwd: resolvedCwd,
        env: { ...process.env, TERM: 'xterm-256color' },
      })
    } catch (err) {
      onData('[ATerminal] Failed to spawn shell: ' + err.message + '\r\n')
      onExit(1)
      return
    }

    let buffer = ''

    ptyProcess.onData((data) => {
      buffer += data
      if (buffer.length > BUFFER_MAX) buffer = buffer.slice(-BUFFER_MAX)
      onData(data)
    })

    ptyProcess.onExit(({ exitCode }) => {
      sessions.delete(sessionId)
      onExit(exitCode)
    })

    sessions.set(sessionId, { ptyProcess, buffer, onData, onExit })
    console.log('Spawned session ' + sessionId + ' shell=' + shellExe)
  }

  function write(sessionId, data) {
    const s = sessions.get(sessionId)
    if (!s || typeof data !== 'string') return false
    s.ptyProcess.write(data)
    return true
  }

  function resize(sessionId, cols, rows) {
    const s = sessions.get(sessionId)
    const safeCols = clampInt(cols, 20, 500)
    const safeRows = clampInt(rows, 5, 200)
    if (s && safeCols && safeRows) s.ptyProcess.resize(safeCols, safeRows)
  }

  function kill(sessionId) {
    const s = sessions.get(sessionId)
    if (s) {
      try { s.ptyProcess.kill() } catch {}
      sessions.delete(sessionId)
    }
  }

  function getBuffer(sessionId) {
    return sessions.get(sessionId)?.buffer || ''
  }

  function listSessions() {
    return [...sessions.keys()]
  }

  return { availableShells, spawn, write, resize, kill, getBuffer, listSessions }
}

function clampInt(value, min, max) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return null
  return Math.max(min, Math.min(max, parsed))
}

function resolveCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 2048) {
    return os.homedir()
  }

  try {
    const stat = fs.statSync(cwd)
    if (stat.isDirectory()) return cwd
  } catch {}

  throw new Error('Working directory is not available: ' + cwd)
}

module.exports = { createPtyManager }
