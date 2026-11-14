import { OwnedWorkspaces } from "./owned-workspaces.js";
import {
  assertPublicWorkspace,
  assertWorkspaceOwner,
} from "../../../core/application/workspace-policy.js";
import {
  personNameSchema,
  phoneSchema,
} from "../../../core/application/person.schemas.js";
import { startStoreTrial } from "../../../core/application/store-plans.js";
import { AccountRecovery } from "./account-recovery.js";
import { CustomerAccounts } from "./customer-accounts.js";
import { Memberships, tokenHash } from "./memberships.js";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { Context, id, parse } from "../../../core/application/context.js";
import type {
  Actor,
  CatalogItem,
  Customer,
  Settings,
} from "../../../core/domain/models.js";
import {
  credentialsSchema,
  hashPassword,
  registrationSchema,
  verifyPassword,
} from "./identity.schemas.js";
import { GoogleIdentity } from "./google-identity.js";
import { z } from "zod";
import { businessAddressSchema } from "../../settings/application/business-profile.schemas.js";
@Injectable()
export class IdentityService {
  private readonly customerAccounts: CustomerAccounts;
  readonly recovery: AccountRecovery;
  readonly memberships: Memberships;
  readonly workspaces: OwnedWorkspaces;
  private attempts = new Map<string, { count: number; since: number }>();
  constructor(
    private readonly context: Context,
    private readonly googleIdentity: GoogleIdentity,
  ) {
    this.customerAccounts = new CustomerAccounts(context);
    this.memberships = new Memberships(context);
    this.workspaces = new OwnedWorkspaces(context);
    this.recovery = new AccountRecovery(context);
  }
  member(actor: Actor) {
    return this.context.require<Customer>(actor, "customers", actor.id);
  }
  discovery(query: unknown) {
    const input = parse(
      z.object({
        q: z.string().max(100).default(""),
        city: z.string().trim().max(100).default(""),
        state: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .optional(),
        page: z.coerce.number().int().min(0).max(10000).default(0),
      }),
      query,
    );
    const normalize = (value: string) =>
      value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    const items = this.stores()
      .filter(
        (store) =>
          (!input.city ||
            normalize(store.city || "") === normalize(input.city)) &&
          (!input.state || store.state === input.state),
      )
      .filter((store) =>
        normalize(
          `${store.businessName} ${store.city} ${store.state}`,
        ).includes(normalize(input.q)),
      )
      .sort((a, b) => a.businessName.localeCompare(b.businessName, "pt-BR"));
    return {
      items: items.slice(input.page * 8, input.page * 8 + 8),
      hasMore: items.length > (input.page + 1) * 8,
    };
  }
  stores(includePrivate = false) {
    return this.context.repository
      .list<{ tenantId: string }>("system", "stores")
      .flatMap(({ tenantId }) => {
        const settings = this.context.repository.get<Settings>(
          tenantId,
          "settings",
          "business",
        );
        return settings && (includePrivate || settings.workspaceMode !== "solo")
          ? [
              {
                slug: settings.slug,
                businessName: settings.businessName,
                ...(includePrivate
                  ? {
                      workspaceMode:
                        settings.workspaceMode === "solo" ? "solo" : "store",
                    }
                  : {}),
                city: settings.address?.city || "",
                state: settings.address?.state || "",
              },
            ]
          : [];
      });
  }
  googleConfig() {
    return { clientId: process.env.GOOGLE_CLIENT_ID || "" };
  }
  googleChallenge() {
    if (!process.env.GOOGLE_CLIENT_ID)
      throw new ServiceUnavailableException(
        "Login com Google ainda não configurado.",
      );
    const challenge = id();
    const nonce = randomBytes(32).toString("base64url");
    this.context.repository.put("system", "google_challenges", challenge, {
      nonce,
      expiresAt: Date.now() + 5 * 60000,
    });
    return { challenge, nonce };
  }
  async google(body: unknown, actor?: Actor) {
    const input = parse(
      z.object({
        inviteToken: z.string().length(64).optional(),
        credential: z.string().min(20).max(10000),
        challenge: z.string().uuid(),
        mode: z.enum(["login", "link"]).default("login"),
        slug: z.string().min(2).max(60).optional(),
        phone: phoneSchema.optional(),
        role: z.enum(["admin", "customer"]).optional(),
        businessName: z.string().max(100).optional(),
      }),
      body,
    );
    if (input.mode === "link" && !actor) throw new UnauthorizedException();
    const pending = this.context.repository.transaction(() => {
      const record = this.context.repository.get<{
        nonce: string;
        expiresAt: number;
      }>("system", "google_challenges", input.challenge);
      if (!record || record.expiresAt < Date.now())
        throw new UnauthorizedException("Login expirado. Tente novamente.");
      this.context.repository.remove(
        "system",
        "google_challenges",
        input.challenge,
      );
      return record;
    });
    const identity = await this.googleIdentity.verify(
      input.credential,
      pending.nonce,
    );
    if (input.inviteToken) {
      this.memberships.invitation(input.inviteToken);
      const enrollmentToken = randomBytes(32).toString("hex");
      this.context.repository.put(
        "system",
        "google_enrollments",
        this.enrollmentKey(enrollmentToken),
        {
          ...identity,
          inviteToken: input.inviteToken,
          expiresAt: Date.now() + 600000,
        },
      );
      return {
        status: "onboarding_required",
        enrollmentToken,
        profile: { name: identity.name, email: identity.email },
        stores: [],
        invitation: true,
      };
    }
    const store = input.slug
      ? this.context.repository.get<{ tenantId: string }>(
          "system",
          "stores",
          input.slug,
        )
      : undefined;
    const key = `${store?.tenantId}:${identity.sub}`;
    if (input.mode === "link") {
      const personal = actor!.storeSelected === false && !input.slug;
      if (
        (!personal && (!store || actor!.tenantId !== store.tenantId)) ||
        actor!.email.toLowerCase() !== identity.email
      )
        throw new BadRequestException(
          "Use a conta Google com o mesmo e-mail do seu cadastro e a loja atual.",
        );
      this.context.repository.transaction(() => {
        const existing = this.context.repository.get<{ userId: string }>(
          "system",
          "google_accounts",
          personal ? `${actor!.tenantId}:${identity.sub}` : key,
        );
        if (existing && existing.userId !== actor!.id)
          throw new BadRequestException(
            "Esta identidade Google já está vinculada a outra conta.",
          );
        this.context.repository.put(
          "system",
          "google_accounts",
          personal ? `${actor!.tenantId}:${identity.sub}` : key,
          { userId: actor!.id },
        );
      });
      return { linked: true };
    }
    const stores = this.context.repository
      .list<{ tenantId: string }>("system", "stores")
      .flatMap(({ tenantId }) => {
        const settings = this.context.repository.get<Settings>(
          tenantId,
          "settings",
          "business",
        );
        if (!settings) return [];
        const ownsAccount = this.context.repository.get(
          "system",
          "accounts",
          `${settings.slug}:${identity.email}`,
        );
        if (settings.workspaceMode === "solo" && !ownsAccount) return [];
        const linked = this.context.repository.get<{ userId: string }>(
          "system",
          "google_accounts",
          `${tenantId}:${identity.sub}`,
        );
        const customer =
          linked &&
          this.context.repository.get<Customer>(
            tenantId,
            "customers",
            linked.userId,
          );
        return [
          {
            slug: settings.slug,
            businessName: settings.businessName,
            workspaceMode: settings.workspaceMode === "solo" ? "solo" : "store",
            linked: !!customer,
            existingAccount: !!this.context.repository.get(
              "system",
              "accounts",
              `${settings.slug}:${identity.email}`,
            ),
            customer,
          },
        ];
      });
    const memberships = stores.filter(
      (store) => store.customer && store.customer.active !== false,
    );
    const personal = this.customerAccounts.google(identity.sub);
    if (
      personal &&
      !memberships.some((member) => member.customer!.role !== "customer")
    )
      return { status: "authenticated", ...this.session(personal) };
    if (memberships.length) {
      const identityId =
        memberships[0].customer!.identityId || memberships[0].customer!.id;
      for (const membership of memberships) {
        const user = {
          ...membership.customer!,
          identityId,
          emailVerified: true,
        };
        this.context.repository.put(user.tenantId, "customers", user.id, user);
        membership.customer = user;
      }
      this.context.repository.put("system", "google_persons", identityId, {
        identityId,
        sub: identity.sub,
      });
    }
    if (memberships.length === 1)
      return {
        status: "authenticated",
        ...this.session(memberships[0].customer!),
      };
    const enrollmentToken = randomBytes(32).toString("hex");
    this.context.repository.put(
      "system",
      "google_enrollments",
      this.enrollmentKey(enrollmentToken),
      {
        ...identity,
        expiresAt: Date.now() + 10 * 60000,
      },
    );
    return {
      status: "onboarding_required",
      enrollmentToken,
      existingAccount: this.customerAccounts.all(identity.email).length > 0,
      personalAccountExists: !!this.customerAccounts.find(identity.email),
      profile: { name: identity.name, email: identity.email },
      stores: stores.map(({ customer, ...store }) => store),
    };
  }
  private enrollmentKey(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }
  completeGoogle(body: unknown) {
    const input = parse(
      z.object({
        enrollmentToken: z.string().length(64),
        name: personNameSchema.optional(),
        slug: z.string().min(2).max(60).optional(),
        address: businessAddressSchema.optional(),
        role: z.enum(["admin", "customer"]).optional(),
        workspaceMode: z.enum(["store", "solo"]).default("store"),
        phone: phoneSchema.optional(),
        businessName: z.string().trim().min(2).max(100).optional(),
        password: z.string().min(8).max(128).optional(),
      }),
      body,
    );
    return this.context.repository.transaction(() => {
      const key = this.enrollmentKey(input.enrollmentToken);
      const identity = this.context.repository.get<{
        inviteToken?: string;
        sub: string;
        email: string;
        name: string;
        expiresAt: number;
      }>("system", "google_enrollments", key);
      if (!identity || identity.expiresAt < Date.now())
        throw new UnauthorizedException(
          "Confirmação expirada. Entre com Google novamente.",
        );
      if (identity.inviteToken) {
        if (!input.phone)
          throw new BadRequestException("Informe seu telefone.");
        const existing = this.customerAccounts.all(identity.email)[0];
        // Google proves this e-mail; it may link to a pre-existing password account only through the existing explicit proof flow.
        const linked = this.context.repository
          .list<{ identityId: string; sub: string }>("system", "google_persons")
          .find((person) => person.sub === identity.sub);
        let person =
          linked &&
          this.customerAccounts
            .all()
            .find((user) => (user.identityId || user.id) === linked.identityId);
        if (!person && existing)
          throw new BadRequestException(
            "Entre na sua conta existente para aceitar o convite.",
          );
        person ||= {
          id: id(),
          tenantId: "",
          role: "customer",
          name: parse(personNameSchema, input.name ?? identity.name),
          email: identity.email,
          phone: input.phone,
          passwordHash: hashPassword(randomBytes(48).toString("hex")),
          addresses: [],
          emailVerified: true,
        };
        const member = this.memberships.acceptInTransaction(
          identity.inviteToken,
          person,
        );
        this.context.repository.put(
          "system",
          "google_accounts",
          `${member.tenantId}:${identity.sub}`,
          { userId: member.id },
        );
        this.context.repository.put(
          "system",
          "google_persons",
          member.identityId || member.id,
          {
            identityId: member.identityId || member.id,
            sub: identity.sub,
            userId: member.id,
          },
        );
        this.context.repository.remove("system", "google_enrollments", key);
        return { status: "authenticated", ...this.session(member) };
      }
      const store = this.context.repository.get<{ tenantId: string }>(
        "system",
        "stores",
        input.slug || "",
      );
      const linked =
        store &&
        this.context.repository.get<{ userId: string }>(
          "system",
          "google_accounts",
          `${store.tenantId}:${identity.sub}`,
        );
      const account = this.context.repository.get<{
        tenantId: string;
        userId: string;
      }>("system", "accounts", `${input.slug}:${identity.email}`);
      let result;
      if (!input.slug && input.role === "customer") {
        if (this.customerAccounts.all(identity.email).length) {
          if (!input.password)
            throw new BadRequestException(
              "Confirme a senha da sua conta para vincular o Google.",
            );
          const login = this.login({
            email: identity.email,
            password: input.password,
          });
          if (!("user" in login))
            throw new BadRequestException(
              "Selecione seu acesso existente para vincular o Google.",
            );
          result = login;
        } else {
          if (!input.phone)
            throw new BadRequestException("Informe seu telefone.");
          result = this.createAccount({
            role: "customer",
            phone: input.phone,
            name: parse(personNameSchema, input.name ?? identity.name),
            email: identity.email,
            password: randomBytes(48).toString("hex"),
          });
        }
      } else if (linked) {
        const customer = this.context.repository.get<Customer>(
          store!.tenantId,
          "customers",
          linked.userId,
        );
        if (!customer) throw new UnauthorizedException();
        result = this.session(customer);
      } else if (account) {
        const login = this.login({
          slug: input.slug,
          email: identity.email,
          password: input.password || "",
        });
        if (!("user" in login))
          throw new UnauthorizedException("Selecione uma loja.");
        result = login;
      } else {
        if (!input.role || !input.phone)
          throw new BadRequestException("Informe telefone e tipo de conta.");
        if (
          input.role === "admin" &&
          input.workspaceMode !== "solo" &&
          !input.businessName
        )
          throw new BadRequestException("Informe o nome do negócio.");
        result = this.createAccount({
          ...input,
          name: parse(personNameSchema, input.name ?? identity.name),
          email: identity.email,
          password: randomBytes(48).toString("hex"),
        });
      }
      this.context.repository.put(
        "system",
        "google_accounts",
        `${result.user.tenantId}:${identity.sub}`,
        { userId: result.user.id },
      );
      const verified = {
        ...this.context.require<Customer>(
          result.user,
          "customers",
          result.user.id,
        ),
        emailVerified: true,
      };
      this.context.repository.put(
        verified.tenantId,
        "customers",
        verified.id,
        verified,
      );
      result.user = this.publicUser(verified);
      this.context.repository.put(
        "system",
        "google_persons",
        verified.identityId || verified.id,
        {
          identityId: verified.identityId || verified.id,
          sub: identity.sub,
        },
      );
      this.context.repository.remove("system", "google_enrollments", key);
      return { status: "authenticated", ...result };
    });
  }
  publicUser(customer: Customer): Actor {
    if (customer.internal)
      throw new UnauthorizedException(
        "Contatos internos não possuem acesso à plataforma.",
      );
    assertWorkspaceOwner(this.context.repository, customer);
    const {
      id,
      tenantId,
      role,
      name,
      email,
      phone,
      identityId,
      professionalId,
      active,
      emailVerified,
    } = customer;
    const storeSelected = !!this.context.repository.get(
      tenantId,
      "settings",
      "business",
    );
    return {
      id,
      tenantId,
      role,
      name,
      email,
      phone,
      identityId,
      professionalId,
      active,
      emailVerified,
      storeSelected,
    };
  }
  register(body: unknown) {
    const input = parse(registrationSchema, body);
    const fingerprint = tokenHash(
      JSON.stringify({
        ...input,
        password: undefined,
        idempotencyKey: undefined,
      }),
    );
    return this.context.repository.transaction(() => {
      const key = input.idempotencyKey;
      const previous =
        key &&
        this.context.repository.get<{
          tenantId: string;
          userId: string;
          fingerprint: string;
          expiresAt: number;
        }>("system", "registration_keys", key);
      if (previous) {
        const user = this.context.repository.get<Customer>(
          previous.tenantId,
          "customers",
          previous.userId,
        );
        if (
          previous.fingerprint !== fingerprint ||
          !user ||
          !verifyPassword(input.password, user.passwordHash)
        )
          throw new ConflictException(
            "Tentativa de cadastro já utilizada com outros dados.",
          );
        return this.session(user);
      }
      if (
        input.role === "admin" &&
        !input.slug &&
        this.customerAccounts.all(input.email).length
      )
        throw new ConflictException(
          "Você já tem uma conta. Entre e use Trocar de espaço para criar ou acessar sua empresa e sua agenda Solo.",
        );
      const result = this.createAccount(input);
      if (key)
        this.context.repository.put("system", "registration_keys", key, {
          tenantId: result.user.tenantId,
          userId: result.user.id,
          fingerprint,
          expiresAt: Date.now() + 86400000,
        });
      return result;
    });
  }
  createWorkspace(actor: Actor, body: unknown) {
    const input = parse(
      z
        .object({
          workspaceMode: z.enum(["store", "solo"]),
          idempotencyKey: z.uuid(),
          businessName: z.string().trim().min(2).max(100).optional(),
          address: businessAddressSchema.optional(),
        })
        .strict(),
      body,
    );
    const owner = this.workspaces.owner(actor),
      repo = this.context.repository;
    return repo.transaction(() => {
      const key = (owner.identityId || owner.id) + ":" + input.idempotencyKey,
        fingerprint = JSON.stringify(input);
      const previous = repo.get<{ workspaceId: string; fingerprint: string }>(
        "system",
        "workspace_creation_keys",
        key,
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ConflictException("Chave já utilizada para outro espaço.");
        return this.session(
          this.workspaces.target(actor, previous.workspaceId),
        );
      }
      if (
        this.workspaces
          .list(actor, true)
          .some((w) => w.workspaceMode === input.workspaceMode)
      )
        throw new ConflictException(
          "Você já tem um espaço desta modalidade. Use Trocar de espaço.",
        );
      if (
        input.workspaceMode === "store" &&
        (!input.businessName || !input.address)
      )
        throw new BadRequestException(
          "Informe o nome e a localização da empresa.",
        );
      const result = this.createAccount(
        {
          ...input,
          role: "admin",
          name: owner.name,
          email: owner.email,
          phone: owner.phone,
          password: randomBytes(48).toString("hex"),
        },
        owner,
      );
      repo.put("system", "workspace_creation_keys", key, {
        workspaceId: result.user.tenantId,
        fingerprint,
      });
      return result;
    });
  }
  switchWorkspace(actor: Actor, body: unknown) {
    const input = parse(
      z
        .object({ workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) })
        .strict(),
      body,
    );
    return this.session(this.workspaces.target(actor, input.workspaceId));
  }
  private createAccount(body: unknown, owner?: Customer) {
    const parsed = parse(registrationSchema, body);
    if (parsed.workspaceMode === "solo" && parsed.role !== "admin")
      throw new BadRequestException(
        "Agenda individual exige uma conta de proprietário.",
      );
    if (parsed.role === "customer" && !parsed.slug)
      return this.session(this.customerAccounts.create(parsed));
    if (parsed.role === "customer" && this.customerAccounts.find(parsed.email))
      throw new ConflictException(
        "Você já possui conta. Entre para acessar o estabelecimento.",
      );
    const input = {
      ...parsed,
      slug: parsed.slug || (parsed.role === "admin" ? `loja-${id()}` : ""),
    };
    if (
      !parsed.slug &&
      parsed.role === "admin" &&
      parsed.workspaceMode !== "solo" &&
      (!parsed.address || !parsed.businessName)
    )
      throw new BadRequestException("Informe nome do negócio e localização.");
    if (input.slug && !/^[a-z0-9-]+$/.test(input.slug))
      throw new BadRequestException(
        "Código de loja inválido. Use letras minúsculas, números e hífens.",
      );
    const store = this.context.repository.get<{ tenantId: string }>(
      "system",
      "stores",
      input.slug,
    );
    if (store) assertPublicWorkspace(this.context.repository, store.tenantId);
    if (input.role === "admin" && store)
      throw new ConflictException("Este código de loja já está em uso.");
    if (input.role === "customer" && !store)
      throw new BadRequestException("Loja não encontrada. Confira o código.");
    const tenantId = store?.tenantId || id();
    if (
      this.context.repository.get(
        "system",
        "accounts",
        `${input.slug}:${input.email}`,
      )
    )
      throw new ConflictException("E-mail já cadastrado nesta loja.");
    const customer: Customer = {
      id: id(),
      tenantId,
      role: input.role,
      name: input.name,
      email: input.email,
      phone: input.phone,
      passwordHash: owner?.passwordHash || hashPassword(input.password),
      ...(owner
        ? {
            identityId: owner.identityId || owner.id,
            emailVerified: owner.emailVerified === true,
          }
        : {}),
      addresses: [],
    };
    this.context.repository.put(tenantId, "customers", customer.id, customer);
    this.context.repository.put(
      "system",
      "accounts",
      `${input.slug}:${input.email}`,
      {
        tenantId,
        userId: customer.id,
      },
    );
    if (!store) {
      this.context.repository.put("system", "stores", input.slug, { tenantId });
      const settings: Settings = {
        workspaceMode: input.workspaceMode,
        ownerId: customer.id,
        phone: input.phone,
        address: input.address,
        description: "",
        media: [],
        setupComplete: input.workspaceMode === "solo",
        name: input.name,
        businessName: input.businessName || input.name,
        slug: input.slug,
        timezone: "America/Sao_Paulo",
        completionMode: "manual",
        payOnAppointment: true,
        payOnDelivery: true,
        bankAccount: "",
        pixKey: "",
        openingHour: 8,
        closingHour: 20,
        workDays: [0, 1, 2, 3, 4, 5, 6],
      };
      this.context.repository.put(tenantId, "settings", "business", settings);
      if (input.workspaceMode === "solo") {
        this.context.repository.put<Customer>(
          tenantId,
          "customers",
          "solo-self",
          {
            id: "solo-self",
            tenantId,
            role: "customer",
            internal: true,
            systemContact: true,
            name: "Compromisso pessoal",
            email: "",
            phone: "",
            passwordHash: hashPassword(randomBytes(48).toString("hex")),
            addresses: [],
          },
        );
        this.context.repository.put<CatalogItem>(
          tenantId,
          "catalog",
          "solo-personal",
          {
            id: "solo-personal",
            name: "Compromisso pessoal",
            description: "Uma reserva privada do seu tempo.",
            kind: "service",
            category: "Pessoal",
            priceCents: 0,
            durationMinutes: 60,
            active: true,
            requiresTriage: false,
          },
        );
      }
      startStoreTrial(this.context.repository, customer);
    }
    if (owner) {
      const google = this.context.repository.get<{ sub?: string }>(
        "system",
        "google_persons",
        owner.identityId || owner.id,
      );
      if (google?.sub)
        this.context.repository.put(
          "system",
          "google_accounts",
          tenantId + ":" + google.sub,
          { userId: customer.id },
        );
    }
    return this.session(customer);
  }
  login(body: unknown) {
    const input = parse(credentialsSchema, body);
    const key = input.email;
    const attempt = this.attempts.get(key);
    if (attempt && Date.now() - attempt.since < 60000 && attempt.count >= 8)
      throw new UnauthorizedException(
        "Aguarde um minuto antes de tentar novamente.",
      );
    if (!attempt || Date.now() - attempt.since >= 60000)
      this.attempts.set(key, { count: 1, since: Date.now() });
    else attempt.count++;
    if (this.attempts.size > 10000) this.attempts.clear();
    const passwordChecks = new Map<string, boolean>();
    const validPassword = (hash: string) => {
      if (!passwordChecks.has(hash))
        passwordChecks.set(hash, verifyPassword(input.password, hash));
      return passwordChecks.get(hash)!;
    };
    const matches = this.stores(true)
      .filter((store) => !input.slug || store.slug === input.slug)
      .flatMap((store) => {
        const account = this.context.repository.get<{
          tenantId: string;
          userId: string;
        }>("system", "accounts", `${store.slug}:${input.email}`);
        const customer =
          account &&
          this.context.repository.get<Customer>(
            account.tenantId,
            "customers",
            account.userId,
          );
        return customer && validPassword(customer.passwordHash)
          ? [{ store, customer }]
          : [];
      });
    const personal = !input.slug && this.customerAccounts.find(input.email);
    if (
      personal &&
      validPassword(personal.passwordHash) &&
      !matches.some((match) => match.customer.role !== "customer")
    ) {
      this.attempts.delete(key);
      return this.session(personal);
    }
    if (!matches.length)
      throw new UnauthorizedException("E-mail ou senha inválidos.");
    if (matches.length > 1)
      return {
        status: "store_selection_required" as const,
        stores: matches.map(({ store }) => store),
      };
    this.attempts.delete(key);
    return this.session(matches[0].customer);
  }

  session(customer: Customer) {
    if (customer.active === false)
      throw new UnauthorizedException(
        "Acesso desativado. Fale com o responsável.",
      );
    if (!customer.identityId) {
      customer = { ...customer, identityId: customer.id };
      this.context.repository.put(
        customer.tenantId,
        "customers",
        customer.id,
        customer,
      );
    }
    const token = randomBytes(32).toString("hex");
    this.context.repository.put(
      "system",
      "sessions",
      createHash("sha256").update(token).digest("hex"),
      {
        userId: customer.id,
        tenantId: customer.tenantId,
        credentialVersion:
          this.context.repository.get<{ version: number }>(
            customer.tenantId,
            "credential_epochs",
            customer.id,
          )?.version || 0,
        expiresAt: Date.now() + 1000 * 60 * 60 * 24,
      },
    );
    return { token, user: this.publicUser(customer) };
  }
  authenticate(token: string): Actor {
    const session = this.context.repository.get<{
      userId: string;
      tenantId: string;
      credentialVersion?: number;
      expiresAt: number;
    }>("system", "sessions", createHash("sha256").update(token).digest("hex"));
    const epoch =
      session &&
      this.context.repository.get<{ version: number }>(
        session.tenantId,
        "credential_epochs",
        session.userId,
      );
    if (epoch && (session?.credentialVersion || 0) !== epoch.version)
      throw new UnauthorizedException(
        "Entre novamente após redefinir sua senha.",
      );
    if (!session || session.expiresAt < Date.now())
      throw new UnauthorizedException("Sua sessão expirou. Entre novamente.");
    const customer = this.context.repository.get<Customer>(
      session.tenantId,
      "customers",
      session.userId,
    );
    if (!customer || customer.active === false)
      throw new UnauthorizedException();
    return this.publicUser(customer);
  }
  logout(token: string) {
    this.context.repository.remove(
      "system",
      "sessions",
      createHash("sha256").update(token).digest("hex"),
    );
    return { ok: true };
  }
}
