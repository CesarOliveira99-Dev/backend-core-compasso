import { createHash } from "node:crypto";
import {
  verifiedProxyVisitor,
  authenticationMutation,
} from "./core/application/proxy-proof.js";
import {
  assertWorkspaceRoute,
  employeeCareRoute,
} from "./core/application/workspace-policy.js";
import { RateLimiter } from "./core/application/rate-limiter.js";
import { json, urlencoded } from "express";
import {
  REPOSITORY,
  type Repository,
} from "./core/domain/document-repository.js";
import "./environment.js";
import {
  type CanActivate,
  type ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
} from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import "reflect-metadata";
import { AppModule } from "./app.module.js";
import { Context } from "./core/application/context.js";
import { seedDemo } from "./core/infrastructure/seed.js";
import {
  type AuthRequest,
  IdentityService,
} from "./modules/identity/identity.module.js";
const app = await NestFactory.create(AppModule, {
  bodyParser: false,
  logger: ["error", "warn", "log"],
});
const limiter = new RateLimiter();
const http = app.getHttpAdapter().getInstance();
const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (Number.isInteger(proxyHops) && proxyHops > 0 && proxyHops <= 3)
  http.set("trust proxy", proxyHops);
const identity = app.get(IdentityService);
const anonymousLimiter = new RateLimiter();
const authenticatedLimiter = new RateLimiter();
const credentialLimiter = new RateLimiter();
app.use(
  (
    request: {
      ip: string;
      socket: { remoteAddress?: string };
      path: string;
      originalUrl: string;
      method: string;
      headers: Record<string, string | undefined>;
      rateIdentity?: string;
    },
    response: {
      status: (code: number) => { json: (body: unknown) => void };
      setHeader: (key: string, value: string) => void;
    },
    next: () => void,
  ) => {
    if (request.method === "GET" && request.path === "/v1/health") {
      next();
      return;
    }
    const proof = {
      id: request.headers["x-compasso-visitor"],
      time: request.headers["x-compasso-proxy-time"],
      signature: request.headers["x-compasso-proxy-signature"],
    };
    const present = !!(proof.id || proof.time || proof.signature),
      visitor = verifiedProxyVisitor(
        proof,
        request.method,
        request.originalUrl,
        process.env.BFF_PROXY_SECRET,
      );
    if (present && !visitor) {
      if (
        !anonymousLimiter.allow(
          "invalid-proof:" + (request.socket.remoteAddress || "unknown"),
          120,
        )
      ) {
        response.setHeader("Retry-After", "60");
        response
          .status(429)
          .json({ message: "Muitas solicitações. Aguarde um minuto." });
        return;
      }
      response
        .status(403)
        .json({ message: "Identificação de origem inválida." });
      return;
    }
    let actorKey: string | undefined;
    const bearer = request.headers.authorization;
    if (bearer?.startsWith("Bearer ")) {
      try {
        const actor = identity.authenticate(bearer.slice(7));
        actorKey = createHash("sha256")
          .update(actor.tenantId + ":" + actor.id)
          .digest("hex");
      } catch {
        /* Invalid sessions never select an authenticated bucket. */
      }
    }
    const auth = authenticationMutation(request.path, request.method);
    const key = auth
      ? visitor || `direct:${request.socket.remoteAddress || "unknown"}`
      : actorKey
        ? `actor:${actorKey}`
        : visitor || `direct:${request.socket.remoteAddress || "unknown"}`;
    request.rateIdentity = key;
    const bucket = actorKey && !auth ? authenticatedLimiter : anonymousLimiter;
    const limit = auth ? (visitor ? 30 : 120) : 1200;
    if (!bucket.allow(`${auth ? "auth" : "read"}:${key}`, limit)) {
      response.setHeader("Retry-After", "60");
      response
        .status(429)
        .json({ message: "Muitas solicitações. Aguarde um minuto." });
      return;
    }
    next();
  },
);
app.use(json({ limit: "64kb" }));
app.use(urlencoded({ extended: false, limit: "64kb" }));
app.use(
  (
    request: {
      path: string;
      method: string;
      body?: { email?: unknown };
      rateIdentity?: string;
    },
    response: {
      status: (code: number) => { json: (body: unknown) => void };
      setHeader: (key: string, value: string) => void;
    },
    next: () => void,
  ) => {
    if (
      request.path === "/v1/auth/login" &&
      request.method === "POST" &&
      typeof request.body?.email === "string" &&
      request.body.email.length <= 254
    ) {
      const account = createHash("sha256")
        .update(
          request.body.email.trim().toLowerCase() + ":" + request.rateIdentity,
        )
        .digest("hex");
      if (!credentialLimiter.allow(account, 15, Date.now(), 15 * 60000)) {
        response.setHeader("Retry-After", "900");
        response
          .status(429)
          .json({
            message:
              "Muitas tentativas de entrada neste navegador. Aguarde para tentar novamente.",
          });
        return;
      }
    }
    next();
  },
);
app.setGlobalPrefix("v1");
const reflector = app.get(Reflector);
const guard: CanActivate = {
  canActivate(execution: ExecutionContext) {
    if (
      reflector.getAllAndOverride<boolean>("public", [
        execution.getHandler(),
        execution.getClass(),
      ])
    )
      return true;
    const request = execution.switchToHttp().getRequest<AuthRequest>();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer "))
      throw new UnauthorizedException("Entre para continuar.");
    request.actor = identity.authenticate(authorization.slice(7));
    const httpRequest = execution
      .switchToHttp()
      .getRequest<{ path: string; method: string }>();
    const expectedWorkspace = request.headers["x-compasso-workspace"];
    if (
      expectedWorkspace &&
      expectedWorkspace !== request.actor.tenantId &&
      httpRequest.path !== "/v1/auth/me"
    )
      throw new HttpException(
        "O espaço mudou em outra aba. Atualize a página antes de continuar.",
        409,
      );
    if (request.actor.storeSelected === false) {
      const path = httpRequest.path.replace(/^\/v1\//, "");
      const allowed =
        httpRequest.method === "GET"
          ? /^(auth\/(me|last-visit)|customers\/profile)$/.test(path)
          : httpRequest.method === "POST"
            ? /^(auth\/(logout|switch-store|last-visit\/review|email\/request|invite\/accept|google\/link)|customers\/addresses)$/.test(
                path,
              )
            : httpRequest.method === "PATCH" &&
              /^(customers\/profile|customers\/addresses\/[\w-]+\/default)$/.test(
                path,
              );
      if (!allowed)
        throw new ForbiddenException(
          "Escolha um estabelecimento para continuar.",
        );
    }
    assertWorkspaceRoute(
      app.get(Context).repository,
      request.actor,
      httpRequest.path.replace(/^\/v1\//, ""),
      httpRequest.method,
    );
    const upload =
      httpRequest.path === "/v1/media" && httpRequest.method === "POST";
    if (upload && request.actor.role !== "admin")
      throw new ForbiddenException();
    if (
      !limiter.allow(
        `user:${request.actor.tenantId}:${request.actor.id}:${upload ? "upload" : "api"}`,
        upload ? 12 : 300,
      )
    ) {
      execution
        .switchToHttp()
        .getResponse<{ setHeader: (key: string, value: string) => void }>()
        .setHeader("Retry-After", "60");
      throw new HttpException("Muitas solicitações. Aguarde um minuto.", 429);
    }
    if (request.actor.role === "employee") {
      const http = execution
        .switchToHttp()
        .getRequest<{ path: string; method: string }>();
      const path = http.path.replace(/^\/v1\//, "");
      const readable =
        /^(workspace\/(?:preferences|analytics|export|customers(?:\/[\w-]+)?)|auth\/me|catalog|settings|appointments(?:\/availability)?|notifications|professionals)$/.test(
          path,
        );
      const writable =
        /^(workspace\/(?:preferences|customers\/[\w-]+(?:\/redeem)?|appointments\/[\w-]+\/style)|auth\/logout|auth\/email\/request|auth\/switch-store|auth\/invite\/accept|notifications(?:\/[^/]+)?|appointments\/[^/]+|professionals\/[^/]+)$/.test(
          path,
        );
      if (
        !(http.method === "GET" ? readable : writable) &&
        !employeeCareRoute(path, http.method)
      )
        throw new ForbiddenException("Acesso restrito ao responsável da loja.");
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
await app.listen(
  Number(process.env.PORT || 4000),
  process.env.HOST || "127.0.0.1",
);
console.log(
  `Compasso API: http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 4000}/v1`,
);
