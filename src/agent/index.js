'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const os = require('os');
const path = require('path');
const { detectShells } = require('./shell-detect');
const { createPtyManager } = require('./pty-manager');
const { createConnector } = require('./connector');
async function startAgent(config) {
    console.log('ATerminal agent starting, connecting to ' + config.serverUrl);
    const shells = await detectShells();
    console.log('Available shells:', shells);
    const ptyManager = createPtyManager(shells);
    const connector = createConnector(config, ptyManager);
    function cleanup() {
        console.log('Shutting down agent...');
        process.exit(0);
    }
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    connector.connect();
}
module.exports = { startAgent };
