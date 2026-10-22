// Synthetic Sentinel E2 fixture (nest-validation). Original, inert, never installed outside a bounded
// probe container.
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';

@Module({ controllers: [AppController] })
export class AppModule {}
