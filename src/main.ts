import { type CanActivate, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import 'reflect-metadata';
import { AppModule } from './app.module.js';
import { Context } from './core/application/context.js';
import { seedDemo } from './core/infrastructure/seed.js';
import { type AuthRequest, IdentityService } from './modules/identity/identity.module.js';
const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
app.setGlobalPrefix('v1');
const identity = app.get(IdentityService);
const reflector = app.get(Reflector);
const guard: CanActivate = {
  canActivate(execution: ExecutionContext) {
    if (
      reflector.getAllAndOverride<boolean>('public', [execution.getHandler(), execution.getClass()])
    )
      return true;
    const request = execution.switchToHttp().getRequest<AuthRequest>();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer '))
      throw new UnauthorizedException('Entre para continuar.');
    request.actor = identity.authenticate(authorization.slice(7));
    return true;
  },
};
app.useGlobalGuards(guard);
seedDemo(app.get(Context), identity);
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT || 4000), process.env.HOST || '127.0.0.1');
console.log(
  `Compasso API: http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 4000}/v1`,
);
