// Synthetic Sentinel E2 fixture (nest-validation). Original, inert, never installed outside a bounded
// probe container. Deliberately no app.useGlobalPipes(...): global enforcement is a separate,
// out-of-scope lesson from this route-scoped pipe fixture.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.getHttpAdapter().get('/healthz', (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => {
    res.status(200).json({ ok: true });
  });
  const port = Number(process.env.PORT || 3000);
  await app.listen(port, '127.0.0.1');
  process.stdout.write(`fixture-nest-validation listening on ${port}\n`);
}
bootstrap();
