'use strict';

const { openDb } = require('../db');
const { createAuditLogger } = require('./audit');
const { createHttpServer } = require('./http');
const { createAgentGateway } = require('./agent-gateway');
const { createBrowserWs } = require('./browser-ws');

/**
 * Start the ATerminal server.
 * @param {{ port: number, jwtSecret: string, dbPath: string, adminUser: object }} config
 * @returns {Promise<void>}
 */
async function startServer(config) {
  // 1. Open the database
  const db = openDb(config.dbPath);

  // 2. Prune sessions older than 30 days
  const { pruneOldSessions } = require('../db');
  const pruned = pruneOldSessions(db);
  if (pruned.changes > 0) {
    console.log(`Pruned ${pruned.changes} session(s) older than 30 days.`);
  }

  // 3. Create the audit logger
  const audit = createAuditLogger(db);

  // 4. Create the Express app + raw HTTP server
  const { app, server } = createHttpServer(db, config, audit);

  // 5. Create the agent WebSocket gateway (attaches to /ws/agent)
  const agentGateway = createAgentGateway(server, db, config, audit);

  // 6. Make agentGateway available to the API router via app.get('agentGateway')
  app.set('agentGateway', agentGateway);

  // 7. Attach browser Socket.IO on the same HTTP server
  createBrowserWs(server, db, config, agentGateway, audit);

  // 8. Start listening
  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, config.host || '127.0.0.1', (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  console.log(`ATerminal server listening on http://${config.host || '127.0.0.1'}:${config.port}`);
}

module.exports = { startServer };
