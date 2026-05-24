'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const { insertAudit } = require('../db');
function createAuditLogger(db) {
    const logsDir = path.join(__dirname, '../../logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logger = winston.createLogger({
        level: 'info',
        format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
        transports: [
            new winston.transports.Console(),
            new winston.transports.File({ filename: path.join(logsDir, 'audit.log') }),
        ],
    });
    function log(event, user, details) {
        const safeDetails = details && typeof details === 'object' ? details : {};
        try {
            insertAudit(db, event, user, safeDetails);
        }
        catch (_) {
            // Do not crash the server if audit persistence fails.
        }
        logger.info({ ...safeDetails, event, user });
    }
    return { log };
}
module.exports = { createAuditLogger };
