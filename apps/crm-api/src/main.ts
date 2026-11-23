import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { AppModule } from './app.module.js';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter.js';

async function bootstrap() {
  // rawBody: true exposes req.rawBody so webhook HMAC signatures can be verified
  // against the exact bytes the provider signed.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, bodyParser: false });

  // Behind the hosting platform's proxy every request arrives FROM the proxy,
  // so without this `req.ip` was the proxy's address: rate limits, the
  // trusted-device list and the audit IPs all saw one client. TRUST_PROXY is
  // the number of proxy hops in front of the API (default 1 — Northflank,
  // Railway, Render and most PaaS); `false` when the API is exposed directly,
  // which stops a client forging X-Forwarded-For to dodge per-IP limits.
  const trustProxy = (process.env.TRUST_PROXY ?? '1').trim().toLowerCase();
  app.set('trust proxy', trustProxy === 'false' || trustProxy === '0' ? false : Number(trustProxy) || 1);

  // Security headers on every API response (the web app sets its own). Done here
  // rather than with a dependency: an API that only ever answers JSON or audio
  // needs a short, fixed set. The strict CSP is skipped for the Swagger UI, which
  // is the one HTML page the API can serve.
  app.disable('x-powered-by');
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!req.path.startsWith('/api/docs')) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    }
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  // Request body size. A 25 MB spreadsheet expands substantially when its rows
  // are sent as JSON, so large-array routes need a higher parser ceiling for
  // imports of tens of thousands of leads. Other routes stay capped at 1 MB,
  // including chunked requests without a Content-Length header.
  const LARGE_BODY_PATHS = ['/api/leads/import', '/api/leads/bulk-', '/api/assignments'];
  const DEFAULT_BODY_LIMIT = 1024 * 1024;
  const LARGE_JSON_BODY_LIMIT = '100mb';
  app.use((req: Request, res: Response, next: NextFunction) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > DEFAULT_BODY_LIMIT && !LARGE_BODY_PATHS.some((p) => req.path.startsWith(p))) {
      res.status(413).json({ statusCode: 413, message: 'Request body too large' });
      return;
    }
    next();
  });
  const captureRawBody = (req: Request, _res: Response, buffer: Buffer) => {
    (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
  };
  const defaultJsonParser = express.json({ limit: DEFAULT_BODY_LIMIT, verify: captureRawBody });
  const largeJsonParser = express.json({ limit: LARGE_JSON_BODY_LIMIT, verify: captureRawBody });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const parser = LARGE_BODY_PATHS.some((p) => req.path.startsWith(p)) ? largeJsonParser : defaultJsonParser;
    parser(req, res, next);
  });
  app.useBodyParser('urlencoded', { limit: '10mb', extended: true });

  // SEC-007 — validate all inputs, strip unknown props
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  // Database errors as proper HTTP answers (409 / 404 / 400) instead of a 500.
  app.useGlobalFilters(new PrismaExceptionFilter(app.get(HttpAdapterHost).httpAdapter));

  // Quo delivers to a bare /hook/<token> path (proxied straight through), which
  // would otherwise 404 against the /api prefix — so that one route is exempt.
  app.setGlobalPrefix('api', { exclude: [{ path: 'hook/:token', method: RequestMethod.POST }] });
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  });

  // OpenAPI (REST is the primary API; GraphQL deferred — SOLUTION_DESIGN §12).
  // Off in production unless SWAGGER_ENABLED=true: a public, browsable map of
  // every route (webhook paths included) is reconnaissance handed out for free.
  const docsEnabled = process.env.NODE_ENV !== 'production' || process.env.SWAGGER_ENABLED === 'true';
  if (docsEnabled) {
    const config = new DocumentBuilder()
      .setTitle('CRM Lead & Sales API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
  }

  // Graceful shutdown. Without this Nest never runs its lifecycle hooks on
  // SIGTERM, so a redeploy killed the process mid-request: in-flight requests
  // were dropped, cron runs cut off, Prisma and the SMTP pool never closed.
  // With it, the HTTP server stops accepting, open requests finish, and every
  // onModuleDestroy / onApplicationShutdown hook runs before exit.
  app.enableShutdownHooks();

  // Render/most PaaS inject PORT; fall back to API_PORT for local dev.
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
  await app.listen(port);
  console.log(`API ready on http://localhost:${port}/api${docsEnabled ? '  (docs: /api/docs)' : ''}`);
  if (process.env.MIGRATIONS_FAILED === '1') {
    console.error('!!! Database migrations FAILED on boot — /api/health reports 503 until a deploy applies them. See the Prisma error above.');
  }
}

bootstrap().catch((err) => {
  // A boot failure (bad env, unreachable database at startup) must exit with a
  // clear reason rather than as an unhandled rejection.
  console.error('API failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
