// Copyright (c) 2025 Robert “RJDC” Clinkenbeard. All rights reserved.
// Unauthorized copying, modification, distribution, or use of this file,
// via any medium, is strictly prohibited without express written permission.

// Load environment variables from .env file
import * as dotenv from 'dotenv';
dotenv.config();

// Verify Stripe keys are configured
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('[ENV] ⚠️ STRIPE_SECRET_KEY not set in environment variables');
}
if (!process.env.VITE_STRIPE_PUBLIC_KEY) {
  console.error('[ENV] ⚠️ VITE_STRIPE_PUBLIC_KEY not set in environment variables');
}

import { createClient } from "@supabase/supabase-js";
import type { Request, Response } from "express";

import express, { type Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";

const app = express();

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown
  }
}
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // CRITICAL: Verify database connection FIRST before anything else
  console.log('[STARTUP] Verifying database connection...');
  try {
    const { db } = await import('./db');
    await db.execute('SELECT 1');
    console.log('[STARTUP] ✓ Database connection verified');
    
    // Ensure database schema is properly synced (handles Railway deployments)
    const { ensureSchemaSync } = await import('./ensureSchema');
    await ensureSchemaSync();
  } catch (error: any) {
    console.error('[STARTUP] ❌ Database connection failed:', error.message);
    console.log('[STARTUP] Attempting to reset database pool...');
    try {
      const { resetPool } = await import('./db');
      await resetPool();
      console.log('[STARTUP] ✓ Database pool reset successful');
      
      // Try schema sync after pool reset
      const { ensureSchemaSync } = await import('./ensureSchema');
      await ensureSchemaSync();
    } catch (resetError) {
      console.error('[STARTUP] ❌ Database pool reset failed:', resetError);
      console.error('[STARTUP] Server starting anyway - Worker will attempt repair');
    }
  }

  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // Serve static SEO and public files before Vite middleware
  app.use(express.static("public"));
  
  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain");
    res.sendFile("robots.txt", { root: "public" });
  });

  app.get("/sitemap.xml", (_req, res) => {
    res.type("application/xml");
    res.sendFile("sitemap.xml", { root: "public" });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Railway and other platforms will provide PORT, default to 5000 for local development
  const port = parseInt(process.env.PORT || '5000', 10);
  
  server.listen({
    port,
    host: "0.0.0.0",
  }, () => {
    log(`serving on port ${port}`);
  }).on('error', (error: any) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[STARTUP] ❌ CRITICAL: Port ${port} is already in use.`);
      console.error(`[STARTUP] ❌ Deployment will fail. Please ensure no other process is using port ${port}.`);
      process.exit(1);
    } else {
      console.error(`[STARTUP] ❌ Server error:`, error);
      throw error;
    }
  });

  // Initialize persistence manager on startup
  const { persistenceManager } = await import('./persistenceManager');
  await persistenceManager.start();

  // Run Sub-Agent table migrations
  try {
    const { createSubAgentTables } = await import('./migrations/createSubAgentTables');
    await createSubAgentTables();
  } catch (error) {
    console.error('Failed to create Sub-Agent tables:', error);
  }

  // Run Token Metrics table migrations
  try {
    const { createTokenMetricsTables } = await import('./migrations/createTokenMetrics');
    await createTokenMetricsTables();
  } catch (error) {
    console.error('Failed to create Token Metrics tables:', error);
  }

  // Run Device Rate Limit table migrations
  try {
    const { createDeviceRateLimitTables } = await import('./migrations/createDeviceRateLimitTables');
    await createDeviceRateLimitTables();
  } catch (error) {
    console.error('Failed to create Device Rate Limit tables:', error);
  }

  // Start BadBlue Worker
  const { badblueWorker } = await import('./badblueWorker');
  badblueWorker.initialize().catch((error) => {
    console.error('Failed to start BadBlue Worker:', error);
  });

  // Initialize AI Sub-Agent autonomous improvements
  const { initializeAutonomousImprovements } = await import('./aiSubAgent');
  await initializeAutonomousImprovements();
})();
