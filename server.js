#!/usr/bin/env node
'use strict';

const { readServerConfig } = require('./src/config');
const { startServer } = require('./src/server/index');

startServer(readServerConfig()).catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
