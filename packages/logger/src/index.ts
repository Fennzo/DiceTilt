import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'node:path';

const LOG_DIR = process.env['LOG_DIR'] ?? '/app/logs';
const LOG_LEVEL = process.env['LOG_LEVEL'] ?? 'info';

export interface ServiceLoggers {
  app: winston.Logger;
  audit: winston.Logger;
  security: winston.Logger;
}

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, service, ...rest }) => {
    const extra = Object.keys(rest).length ? '  ' + JSON.stringify(rest) : '';
    return `[${timestamp}] ${level} [${service ?? '?'}]  ${message}${extra}`;
  }),
);

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json(),
);

function rotateFile(filename: string, level?: string): DailyRotateFile {
  return new DailyRotateFile({
    filename: path.join(LOG_DIR, filename),
    datePattern: 'YYYY-MM-DD',
    maxFiles: '7d',
    maxSize: '20m',
    format: jsonFormat,
    ...(level ? { level } : {}),
  });
}

export function createLoggers(service: string): ServiceLoggers {
  const defaultMeta = { service };

  const app = winston.createLogger({
    level: LOG_LEVEL,
    defaultMeta,
    transports: [
      new winston.transports.Console({ format: consoleFormat }),
      rotateFile('app.%DATE%.log'),
      rotateFile('error.%DATE%.log', 'error'),
    ],
  });

  const audit = winston.createLogger({
    level: 'info',
    defaultMeta,
    transports: [
      rotateFile('audit.%DATE%.log'),
    ],
  });

  const security = winston.createLogger({
    level: 'warn',
    defaultMeta,
    transports: [
      rotateFile('security.%DATE%.log'),
    ],
  });

  return { app, audit, security };
}

export { pseudonymize } from './pseudonymize';
