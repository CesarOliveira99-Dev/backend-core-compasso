# Compasso — API

Atualização de 07/11/2026 a partir da versão local integrada. Este repositório é independente: código da aplicação na raiz, dependências e lockfile próprios. O outro serviço fica em https://github.com/CesarOliveira99-Dev/front-compasso-web.

## Executar e validar

Requisitos: Node.js 24 e pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm start
```

Para desenvolvimento: `pnpm dev`. `pnpm demo` cria dados fictícios apenas fora de produção. Sem esse comando, dados existentes são preservados e não é criada demonstração.

## Render

Crie um Web Service Docker ligado a este repositório. Root Directory vazio; Dockerfile `./Dockerfile`; contexto raiz. Health check `/v1/health`; disco persistente em `/data`; uma instância; SEED_DEMO=false. Banco /data/compasso.sqlite e mídia /data/media. Configure APP_URL para o frontend HTTPS e PUBLIC_API_URL para a API HTTPS com /v1.

Use criação manual de serviço ou Blueprint `render.yaml`, nunca ambos para o mesmo serviço. Starter é uma referência inicial para piloto, sujeito a testes de memória/carga. O disco inicial de 1 GB não comporta 50 lojas com 200 MB cada. O disco não substitui backups externos com restauração testada.

## Integrações e limites

Segredos ficam no painel do backend, fora do repositório. Resend: RESEND_API_KEY, MAIL_FROM e APP_URL HTTPS; confirmar DNS e testar entrega real. Google: GOOGLE_CLIENT_ID e origens autorizadas. Mercado Pago: credenciais, criptografia e webhook conforme a integração; manter mensalidade e adicional com preço zero até homologação. Backup: node scripts/backup.mjs backup PASTA_NOVA com DATABASE_PATH e MEDIA_PATH configurados; copiar o resultado para destino externo e testar restauração isolada.

As contas e arquivos da demonstração local não acompanham este repositório. Publicação, Docker, e-mails reais, Google real, pagamentos reais e carga precisam ser homologados. A documentação antiga preservada em docs é histórica e pode descrever a primeira versão.
