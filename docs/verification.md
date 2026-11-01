# Verificação

## Verificações automatizadas

Resultado final nesta entrega: **14 testes passaram**, com checagem de tipos nas duas aplicações e build de produção concluído.

O comando `pnpm test` compila o backend e executa testes de políticas e integração HTTP em uma instância isolada, com SQLite em memória e porta 4107. Os testes não utilizam nem modificam os dados de demonstração do usuário.

Os cenários cobrem:

- troca da semana no domingo do fuso local e visibilidade condicional do resumo de concluídos;
- cálculo em centavos, dias, validade e limite de descontos;
- acesso sem sessão, operações administrativas, isolamento entre lojas e propriedade dos registros;
- bloqueio de horários e rollback integral de checkout com dois serviços conflitantes;
- conclusão independente do pagamento, avaliação após conclusão e fidelidade;
- cotação sem consumir cupom, preço final sem acumulação e idempotência do checkout;
- bloqueio de conclusão de produto em triagem até a decisão administrativa;
- recusa de uma confirmação com valor esperado divergente;
- pagamento online desabilitado e proteção dos dados bancários;
- finalização automática, preservação do pagamento e deduplicação de notificações;
- invalidação da sessão após logout.

`pnpm typecheck` verifica os dois projetos. `pnpm build` compila o backend e gera o build de produção do frontend. O build de produção usa `.next-production`, separado do diretório de desenvolvimento.

## Verificação pelo navegador

Foram percorridos o acesso demonstrativo do administrador, o painel, o resumo contextual do dia e a carteira. Na conta do cliente, foram conferidos catálogo, inclusão de produto na sacola, endereço padrão, cotação no backend e confirmação de pedido fictício com pagamento na entrega.

Foram inspecionados layouts de desktop e tela estreita. O CSS inclui navegação lateral recolhível, tabelas com rolagem e reorganização dos cartões em dispositivos menores.

## Limites

Esta verificação não é um teste de carga, uma auditoria completa de segurança ou uma homologação em hospedagem de produção. Não foram exercitados cobrança real, webhooks externos, Meta, gateways ou compras em lojas externas. Crapper, Dryer e Mutator não foram executados.

## Registro resumido das decisões

1. Aplicações separadas para preservar a fronteira entre interface/BFF e regras de negócio.
2. Banco local persistente para permitir uma entrega executável sem contratar infraestrutura.
3. Finalização e pagamento independentes para refletir a rotina descrita.
4. Transações para proteger agenda, descontos e pedidos diante de conflitos.
5. Dados fictícios isolados para validar fluxos sem cobrança ou mensagens reais.
6. Integrações externas mantidas desativadas por decisão explícita do usuário.
