# Backend do Compasso

## Repositório independente

Código em src/; testes em test/; scripts em scripts/. Consulte README.md para execução e deploy. Não use caminhos do antigo workspace applications/backend ou applications/frontend. Preserve a fronteira Next.js/BFF → NestJS: permissões, tenant, dinheiro, agenda e confirmação de pagamento pertencem ao backend.

Após implementação, aplicar a skill ub-mode quando disponível e revisar segurança proporcionalmente. Validar testes, tipos e build pertinentes. Não colocar credenciais, banco ou uploads no Git. Integração simulada não comprova homologação externa. SQLite e controles em memória não suportam simplesmente adicionar réplicas.
