import express from 'express';
import path from 'path';
import fs from 'fs';
import type { Server } from 'http';
import {
  createApiApp,
  startBackgroundMaintenanceTimers,
  stopBackgroundMaintenanceTimers,
  closeAllSseClients,
  shutdownCctvGateway,
  flushPendingKvWrites,
  getRuntimeInfo,
} from './serverApp.ts';
import { APP_VERSION, APP_BUILD_ID } from './src/version.ts';

function logServer(level: 'info' | 'warn' | 'error', event: string, meta?: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    version: APP_VERSION,
    ...(meta || {}),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function resolveListenPort(): number {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } else if (arg.startsWith('--port=')) {
      const parsed = Number(arg.slice('--port='.length));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  const envPort = Number(process.env.PORT);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  return 3000;
}

let activeShutdownHandler: ((signal: string, exitCode?: number) => void) | null = null;
let unhandledHooksRegistered = false;

function registerProcessStabilityHandlers() {
  if (unhandledHooksRegistered) return;
  unhandledHooksRegistered = true;
  process.on('unhandledRejection', (reason) => {
    logServer('error', 'UNHANDLED_REJECTION', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
  process.on('uncaughtException', (err) => {
    logServer('error', 'UNCAUGHT_EXCEPTION', {
      message: err?.message || String(err),
      stack: err?.stack,
    });
    if (activeShutdownHandler) {
      activeShutdownHandler('UNCAUGHT_EXCEPTION', 1);
    } else {
      process.exit(1);
    }
  });
}

async function start() {
  const startTimeMs = Date.now();
  registerProcessStabilityHandlers();

  const initialPort = resolveListenPort();
  const app = createApiApp();

  // Instant readiness probe for Railway / Cloud Run / load balancers
  app.get('/healthz', (_req, res) => {
    const mem = process.memoryUsage();
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json({
      ok: true,
      status: 'healthy',
      version: APP_VERSION,
      buildId: APP_BUILD_ID,
      uptimeSec: Math.round(process.uptime()),
      memoryMb: {
        rss: Math.round(mem.rss / (1024 * 1024)),
        heapUsed: Math.round(mem.heapUsed / (1024 * 1024)),
      },
    });
  });

  // PWA Manifest with explicit application/manifest+json MIME type
  app.get(['/manifest.json', '/manifest.webmanifest'], (_req, res) => {
    const manifestPath = path.resolve(process.cwd(), 'public', 'manifest.json');
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, max-age=0');
    if (fs.existsSync(manifestPath)) {
      return res.sendFile(manifestPath);
    }
    return res.status(404).json({ success: false, message: 'Manifest not found' });
  });

  // PWA Service Worker with Service-Worker-Allowed header
  app.get('/sw.js', (_req, res) => {
    const swPath = path.resolve(process.cwd(), 'public', 'sw.js');
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (fs.existsSync(swPath)) {
      return res.sendFile(swPath);
    }
    return res.status(404).send('// Service worker not found');
  });

  const distPath = path.resolve(process.cwd(), 'dist');
  const distIndexPath = path.join(distPath, 'index.html');
  const hasDistBuild = fs.existsSync(distIndexPath);
  const isExplicitDev =
    process.env.NODE_ENV === 'development' ||
    process.env.npm_lifecycle_event === 'dev';
  const shouldServeDist =
    hasDistBuild && (process.env.NODE_ENV === 'production' || !isExplicitDev);

  if (shouldServeDist) {
    logServer('info', 'SERVING_STATIC_DIST', { buildId: APP_BUILD_ID, distPath });
    app.use(
      express.static(distPath, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(distIndexPath);
    });
  } else {
    if (!isExplicitDev && !hasDistBuild) {
      logServer('warn', 'DIST_MISSING_DEV_FALLBACK', {
        message: '/dist/index.html missing — run "npm run build" before production start.',
      });
    } else {
      logServer('info', 'MOUNTING_VITE_DEV_MIDDLEWARE');
    }
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          hmr: process.env.DISABLE_HMR !== 'true',
        },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } catch (viteErr: any) {
      logServer('error', 'VITE_UNAVAILABLE_NO_DIST', {
        message: viteErr?.message || 'Vite dev server unavailable and /dist is not built.',
      });
      app.get('*', (_req, res) => {
        res.status(503).send('Application build (/dist) is missing. Run "npm run build" before starting.');
      });
    }
  }

  startBackgroundMaintenanceTimers();

  const runtime = getRuntimeInfo();
  let activeHttpServer: Server | null = null;
  let shuttingDown = false;

  const listenOnPort = (portToBind: number, allowProxyFallback: boolean): Promise<Server> =>
    new Promise((resolve, reject) => {
      const candidate = app.listen(portToBind, '0.0.0.0', () => {
        candidate.keepAliveTimeout = 65000;
        candidate.headersTimeout = 66000;
        const bootMs = Date.now() - startTimeMs;
        logServer('info', 'SERVER_LISTENING', {
          host: '0.0.0.0',
          port: portToBind,
          storageMode: runtime.storageMode,
          bootMs,
          nodeVersion: process.version,
        });
        resolve(candidate);
      });

      candidate.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && allowProxyFallback && portToBind === 8080) {
          logServer('warn', 'PORT_8080_IN_USE_FALLBACK', { nextPort: 3000 });
          resolve(listenOnPort(3000, false));
          return;
        }
        reject(err);
      });
    });

  activeHttpServer = await listenOnPort(initialPort, Boolean(process.env.K_SERVICE));

  const gracefulShutdown = (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logServer('info', 'GRACEFUL_SHUTDOWN_START', { signal, exitCode });
    try {
      stopBackgroundMaintenanceTimers();
    } catch {}
    try {
      closeAllSseClients();
    } catch {}
    try {
      shutdownCctvGateway();
    } catch {}

    const finalize = () => {
      flushPendingKvWrites()
        .catch(() => {})
        .finally(() => {
          process.exit(exitCode);
        });
    };

    if (activeHttpServer) {
      activeHttpServer.close(() => finalize());
    } else {
      finalize();
    }
    const forceTimer = setTimeout(() => process.exit(exitCode), 4000);
    forceTimer.unref?.();
  };

  activeShutdownHandler = gracefulShutdown;
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM', 0));
  process.once('SIGINT', () => gracefulShutdown('SIGINT', 0));
}

start().catch((err) => {
  logServer('error', 'FATAL_STARTUP_ERROR', {
    message: err?.message || String(err),
    stack: err?.stack,
  });
  process.exit(1);
});
