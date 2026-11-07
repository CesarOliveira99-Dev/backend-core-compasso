import { RateLimiter } from './core/application/rate-limiter.js';
import { json, urlencoded } from 'express';
import { REPOSITORY, type Repository } from './core/domain/document-repository.js';
import './environment.js';
import {
  type CanActivate,
  type ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import 'reflect-metadata';
import { AppModule } from './app.module.js';
import { Context } from './core/application/context.js';
import { seedDemo } from './core/infrastructure/seed.js';
import { type AuthRequest, IdentityService } from './modules/identity/identity.module.js';
const app = await NestFactory.create(AppModule, {
  bodyParser: false,
  logger: ['error', 'warn', 'log'],
});
const limiter = new RateLimiter();
const http = app.getHttpAdapter().getInstance();
const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (Number.isInteger(proxyHops) && proxyHops > 0 && proxyHops <= 3)
  http.set('trust proxy', proxyHops);
app.use(
  (
    request: { ip: string; path: string },
    response: {
      status: (code: number) => { json: (body: unknown) => void };
      setHeader: (name: string, value: string) => void;
    },
    next: () => void,
  ) => {
    const auth = request.path.startsWith('/v1/auth/');
    if (!limiter.allow(`${request.ip}:${auth ? 'auth' : 'api'}`, auth ? 120 : 1200)) {
      response.setHeader('Retry-After', '60');
      response.status(429).json({ message: 'Muitas solicitações. Aguarde um minuto.' });
      return;
    }
    next();
  },
);
app.use(json({ limit: '64kb' }));
app.use(urlencoded({ extended: false, limit: '64kb' }));
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
    const httpRequest = execution.switchToHttp().getRequest<{ path: string; method: string }>();
    if (request.actor.storeSelected === false) {
      const path = httpRequest.path.replace(/^\/v1\//, '');
      const allowed =
        httpRequest.method === 'GET'
          ? /^(auth\/(me|last-visit)|customers\/profile)$/.test(path)
          : httpRequest.method === 'POST'
            ? /^(auth\/(logout|switch-store|last-visit\/review|email\/request|invite\/accept|google\/link)|customers\/addresses)$/.test(
                path,
              )
            : httpRequest.method === 'PATCH' &&
              /^(customers\/profile|customers\/addresses\/[\w-]+\/default)$/.test(path);
      if (!allowed) throw new ForbiddenException('Escolha um estabelecimento para continuar.');
    }
    const upload = httpRequest.path === '/v1/media' && httpRequest.method === 'POST';
    if (upload && request.actor.role !== 'admin') throw new ForbiddenException();
    if (
      !limiter.allow(
        `user:${request.actor.tenantId}:${request.actor.id}:${upload ? 'upload' : 'api'}`,
        upload ? 12 : 300,
      )
    )
      throw new HttpException('Muitas solicitações. Aguarde um minuto.', 429);
    if (request.actor.role === 'employee') {
      const http = execution.switchToHttp().getRequest<{ path: string; method: string }>();
      const path = http.path.replace(/^\/v1\//, '');
      const readable =
        /^(auth\/me|catalog|settings|appointments(?:\/availability)?|notifications|professionals)$/.test(
          path,
        );
      const writable =
        /^(auth\/logout|auth\/email\/request|auth\/switch-store|auth\/invite\/accept|notifications(?:\/[^/]+)?|appointments\/[^/]+|professionals\/[^/]+)$/.test(
          path,
        );
      if (!(http.method === 'GET' ? readable : writable))
        throw new ForbiddenException('Acesso restrito ao responsável da loja.');
    }
    return true;
  },
};
app.useGlobalGuards(guard);
seedDemo(app.get(Context), identity);
const maintenance = () => app.get<Repository>(REPOSITORY).cleanupExpired?.();
maintenance();
const cleanupTimer = setInterval(maintenance, 60000);
cleanupTimer.unref();
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT || 4000), process.env.HOST || '127.0.0.1');
console.log(
  `Compasso API: http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 4000}/v1`,
);
