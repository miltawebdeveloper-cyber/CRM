import { NestFactory } from '@nestjs/core';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // rawBody: true exposes req.rawBody so webhook HMAC signatures can be verified
  // against the exact bytes the provider signed.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // Bulk lead import POSTs every parsed row in ONE request, and Express defaults to
  // a 100kb JSON body — which a few hundred leads already exceed, failing the whole
  // import with 413 "request entity too large". Raise it so realistic spreadsheets
  // (tens of thousands of rows) go through. Set explicitly here rather than relying
  // on the default; useBodyParser keeps req.rawBody intact for the webhook routes.
  app.useBodyParser('json', { limit: '10mb' });
  app.useBodyParser('urlencoded', { limit: '10mb', extended: true });

  // SEC-007 — validate all inputs, strip unknown props
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  // Quo delivers to a bare /hook/<token> path (proxied straight through), which
  // would otherwise 404 against the /api prefix — so that one route is exempt.
  app.setGlobalPrefix('api', { exclude: [{ path: 'hook/:token', method: RequestMethod.POST }] });
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  });

  // OpenAPI (REST is the primary API; GraphQL deferred — SOLUTION_DESIGN §12)
  const config = new DocumentBuilder()
    .setTitle('CRM Lead & Sales API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));

  // Render/most PaaS inject PORT; fall back to API_PORT for local dev.
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
  await app.listen(port);
  console.log(`API ready on http://localhost:${port}/api  (docs: /api/docs)`);
}
bootstrap();
