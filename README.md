# Compasso Backend

API modular de cadastro, agenda, triagem, pedidos e relacionamento do Compasso. Este repositório é independente do [frontend e BFF](https://github.com/CesarOliveira99-Dev/front-compasso-web).

## Executar

Requisitos: Node.js 24 e pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm demo
```

A API inicia em `http://127.0.0.1:4000/v1`. O comando `pnpm demo` cria dados fictícios somente se a loja de demonstração ainda não existir. Para iniciar sem criar a demonstração, use `pnpm dev`. Os dois comandos carregam `.env` quando presente; use `.env.example` como referência.

| Conta fictícia | E-mail | Senha | Código da loja |
| --- | --- | --- | --- |
| Administrador | admin@compasso.local | Compasso@2026 | studio |
| Cliente | cliente@compasso.local | Compasso@2026 | studio |

Não há cobrança real nem mensagens externas. O seed de demonstração é recusado em modo de produção. Uma instalação real deve usar uma base nova, sem contas fictícias.

## Verificação e execução compilada

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

Os testes usam SQLite em memória e uma instância isolada na porta 4107. Não acessam o banco da demonstração.

## Arquitetura

```text
src/
  core/
    domain/                     contratos e políticas compartilhados
    application/                contexto de aplicação e autorização
    infrastructure/             persistência e seed local
  modules/
    <module>/
      domain/                   modelos do módulo
      application/              operações e validação
      infrastructure/controller/ adaptadores HTTP
      <module>.module.ts        composição e interface pública
```

Módulos implementados: identidade, clientes, catálogo, agenda, checkout, triagem, avaliações, fidelidade, campanhas, notificações, configurações e indicadores. O banco SQLite persistente fica em `.data/compasso.sqlite`; o caminho pode ser alterado por `DATABASE_PATH`. Os dados são separados por loja, e operações críticas de checkout são transacionais e idempotentes.

Os controllers delegam aos serviços de aplicação. O adapter de repositório pode ser substituído sem dar ao frontend acesso à persistência. O backend é a autoridade para preços, permissões, disponibilidade e estados.

## Integração com o frontend

Configure `BACKEND_URL=http://127.0.0.1:4000/v1` no ambiente do projeto web. O BFF usa `/auth/login` e encaminha o token de sessão nas chamadas autenticadas. Não existe dependência de código ou de diretórios do outro repositório.

## Limites atuais

Gateway de pagamento e WhatsApp Business estão desativados por decisão do projeto. Seus contratos de integração existem, mas não há webhook ou envio externo ativo. Pagamentos são registrados manualmente e notificações são internas.

Esta é uma base funcional local, sem homologação de carga ou múltiplas instâncias. O worker de lembretes depende do processo ligado. Para produção, ainda é necessário definir infraestrutura, persistência/backup e execução durável de tarefas. Consulte `docs/business-rules.md`, `docs/architecture.md` e `docs/verification.md`.
