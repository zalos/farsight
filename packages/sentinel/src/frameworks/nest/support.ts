// What the Nest pack supports, and no more (PR 16, ADR 32).
export const NEST_PACK = Object.freeze({
  id: 'framework-nest',
  version: '0.1.0',
  framework: 'nest' as const,
  /** Exact captured versions only: @nestjs/common and @nestjs/core 10.4.15 (and class-validator 0.14.1 for validation). */
  versions: Object.freeze({ '@nestjs/common': '10.4.15', '@nestjs/core': '10.4.15', '@nestjs/platform-express': '10.4.15', 'class-validator': '0.14.1' }),
  /** Nest's request order for one handler: guards, then interceptors, then pipes; each global, controller, method (pipes also per parameter). */
  order: Object.freeze(['guard:global', 'guard:controller', 'guard:method', 'interceptor:global', 'interceptor:controller', 'interceptor:method', 'pipe:global', 'pipe:controller', 'pipe:method', 'pipe:parameter']),
  supported: Object.freeze([
    'app.useGlobalGuards / useGlobalInterceptors / useGlobalPipes on the one NestFactory.create application, literal arguments',
    '{ provide: APP_GUARD | APP_INTERCEPTOR | APP_PIPE, useClass } in a module reachable from the bootstrap module',
    '@UseGuards / @UseInterceptors / @UsePipes on a controller class or handler, and pipes passed to @Body / @Query / @Param',
    'ValidationPipe (validation), Parse*Pipe (parsing), DefaultValuePipe and ClassSerializerInterceptor (transformation) from @nestjs/common',
    'FileInterceptor and its siblings from @nestjs/platform-express (multipart parsing only)',
    'a DTO parameter type resolved to a local class and its class-validator decorators',
  ]),
  frontiers: Object.freeze([
    'dynamic or external modules, provider factories, values and aliases, middleware, custom decorators, inherited controllers,',
    'unresolved or local guards, interceptors and pipes (their code is not modeled), non-literal registrations, other versions',
  ]),
  /** A guard's effect (authentication or authorization) is never inferred from its name or its declaration. */
  guardEffect: 'never-inferred' as const,
});
