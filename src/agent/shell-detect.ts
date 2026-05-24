'use strict'

const fs = require('fs')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

async function detectShells() {
  const shells = []

  if (process.platform === 'win32') {
    // PowerShell and CMD are always available on Windows
    shells.push('powershell')
    shells.push('cmd')

    // WSL: check if wsl.exe responds
    try {
      await execFileAsync('wsl.exe', ['--status'], { timeout: 3000 })
      shells.push('wsl')
    } catch { /* WSL not available */ }

  } else {
    // macOS / Linux
    const checks = [
      { shell: 'zsh',  path: '/bin/zsh' },
      { shell: 'bash', path: '/bin/bash' },
      { shell: 'sh',   path: '/bin/sh' },
    ]
    for (const { shell, path } of checks) {
      if (fs.existsSync(path)) shells.push(shell)
    }
    // Fish: check via which
    try {
      await execFileAsync('which', ['fish'], { timeout: 2000 })
      shells.push('fish')
    } catch { /* fish not installed */ }
  }

  return shells
}

module.exports = { detectShells }
