const getTimestamp = () => new Date().toISOString();

class Logger {
  info(message: string, meta?: Record<string, any>) {
    console.log(`[${getTimestamp()}] INFO:`, message, meta || '');
  }

  warn(message: string, meta?: Record<string, any>) {
    console.warn(`[${getTimestamp()}] WARN:`, message, meta || '');
  }

  error(message: string, meta?: Record<string, any>) {
    console.error(`[${getTimestamp()}] ERROR:`, message, meta || '');
  }
}

export const logger = new Logger();