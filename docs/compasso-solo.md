# Compasso Solo e ferramentas da agenda

## Modalidades e compatibilidade

`settings.workspaceMode` distingue `solo` de `store`. Registros antigos sem o campo continuam como lojas. `ownerId` é fixado no cadastro Solo; não é aceito no schema de alteração das configurações. Nenhum dado de lojas existentes é migrado ou apagado. O armazenamento continua sendo documentos JSON no SQLite e requer uma instância de API.

Solo tem dois planos: `solo-mensal`, R$15,00 a cada mês; `solo-anual`, R$110,00 a cada 12 meses. Ambos têm um único proprietário, zero vagas de equipe e zero franquia de e-mails comerciais. Os três planos de lojas e suas franquias/extras permanecem iguais. O teste gratuito é de 14 dias, sem cartão e sem contratação automática. A regra existente contra repetir o teste pelo mesmo e-mail é preservada.

## Casos de uso e invariantes

| Caso | Regra no servidor |
| --- | --- |
| Criar Solo | Conta administrativa sem endereço público obrigatório; vínculo com proprietário gravado na transação do cadastro. |
| Acessar agenda privada | Somente o proprietário autenticado. Não aparece na descoberta, no endpoint público de loja nem no histórico de clientes. Entrar como cliente ou trocar para essa loja pelo slug é rejeitado. |
| Manter agenda | Serviço particular inicial e contato de compromisso pessoal permitem começar sem cliente ou serviço pago. Reservar, reagendar, concluir e registrar recebimento continuam separados. |
| Cadastrar contato interno | Nome validado, telefone/e-mail opcionais. Não cria identidade global, login ou convite. Repetir a mesma chave retorna o mesmo contato; mudar conteúdo com a mesma chave gera conflito. |
| Equipe, mídia, comércio e mensagens no Solo | Rotas negadas pela política de modalidade; workers de confirmação e lembrete ignoram Solo. Recuperação e segurança da própria conta continuam disponíveis. |
| Fichas nas lojas | Administrador acessa clientes da loja. Funcionário acessa apenas clientes ligados a seus atendimentos. Clientes finais não acessam fichas, categorias ou estilos internos. |
| Editar ficha ou preferências | Schema estrito, limites de texto/listas e revisão otimista. Ficha registra autor e data; edição sobre versão antiga recebe 409. |
| Temas e categorias | Preferências individuais herdam padrão da loja. Só administrador define padrão. Cores são hexadecimais validadas, categorias têm ID único. A categoria é fotografada no atendimento e não altera status/valor. |
| Fidelidade interna | Administrador define meta por cliente; atendimentos concluídos geram progresso. Resgate atômico e idempotente. Meta não muda após resgate para evitar recalcular histórico já utilizado. |
| Análises e CSV | Administrador: loja inteira; funcionário: próprios atendimentos. Períodos em Brasília, máximo 366 dias, exportação até 10.000 linhas. Produção de serviços não é recebimento em caixa. CSV escapa fórmulas e aspas; resposta autenticada não fica em cache. |
| Contratar | Família de plano, preço, vagas e período são decisões do servidor. Aprovação da autorização não concede acesso pago: exige fatura/pagamento verificados com valor, moeda, recebedor e ambiente corretos. |

## Cobrança e falhas

A integração existente `/preapproval` recebe `frequency: 1` ou `12` e `frequency_type: months`. A referência persistida inclui o período contratado e a resposta do provedor precisa corresponder a ele. Uma fatura anual concede 12 meses de calendário, com ajuste de 29/fevereiro. Registros históricos sem período continuam mensais. Recuperação de resposta perdida, idempotência, estorno e confirmação assinada existentes continuam em uso.

`COMPASSO_SUBSCRIPTIONS_ENABLED=false` permite navegar e usar o teste sem iniciar contratação. Não há nova variável obrigatória. Trocar entre mensal e anual exige cancelar a renovação e aguardar o período pago terminar, evitando assinaturas sobrepostas.

Referências oficiais consultadas em 12/11/2026: [criar assinatura](https://www.mercadopago.com.br/developers/pt/reference/online-payments/subscriptions/create-preapproval/post) e [pagamentos autorizados](https://www.mercadopago.com.br/developers/pt/docs/subscriptions/integration-configuration/subscription-no-associated-plan/authorized-payments).

## Verificação e limites

Testes automatizados cobrem cadastro privado, login, tenant/proprietário, exclusão pública, ausência de identidade para contatos, agenda manual sem pedido/e-mail, acesso de funcionário, concorrência de ficha, preferências e categorias, fidelidade idempotente, exportação e cobrança anual verificada com transporte simulado. A suíte HTTP sobe API Nest isolada em memória com integrações externas desligadas e exercita Solo e equipe.

Uma rodada no navegador com Next/BFF/Nest reais verificou cadastro, contato, duas edições da mesma ficha, regra e resgate de fidelidade, reserva gratuita, categoria, conclusão, pagamento manual, tema persistente, CSV autenticado e responsividade em 320/390 px. Capturas usam contas fictícias locais.

Revisão manual pelas skills ub-mode e security-pattern focou limites de autorização, dados internos, repetição de comandos e integridade da cobrança. Sem medição CRAP, ferramenta de mutação ou auditoria completa da aplicação. Testes locais não homologam o provedor: ainda falta contratação mensal/anual controlada no Mercado Pago, conferência de webhook, renovação/cancelamento e estorno com credenciais reais. Nenhuma cobrança ou alteração de produção foi executada nesta implementação.

## Gráficos e contagens

Os gráficos recebem somente o histórico já autorizado do solicitante. A função de domínio `agendaCharts` calcula clientes únicos, categorias, serviços e evolução; não acessa banco ou transporte. Contatos de compromisso pessoal são excluídos dos gráficos de clientes/serviços.

- Semanal: últimos 7 dias, uma coluna por dia; mensal: últimos 30 dias, intervalos de 7 dias; anual: últimos 365 dias, agrupamento por mês de calendário (primeiro e último podem ser parciais).
- Cada cliente conta uma vez em cada intervalo da evolução. Um mesmo cliente pode aparecer em vários intervalos; a soma das colunas não é a quantidade de pessoas únicas do período inteiro.
- Primeira visita versus retorno: clientes com atendimento concluído no período; quem tem mais de uma visita concluída no histórico autorizado até o fim do período conta como retorno, inclusive visita anterior ao início da janela.
- Categorias: atendimentos concluídos, pela categoria fotografada no agendamento. Sem categoria é explícito. Cada atendimento conta uma vez.
- Serviços mais solicitados: pela data do atendimento no período, incluindo pendentes/confirmados/concluídos e excluindo cancelados. Agrupamento pelo ID do serviço, preservando contagem após renomear. Não é um relatório pela data de criação do pedido.
- A produção monetária é mantida separada de recebimento. O campo histórico `returningClients` continua contando repetições dentro da janela para compatibilidade; os gráficos novos usam `recurringClients`, que considera o histórico anterior também.

Testes adicionais verificam clientes repetidos, histórico anterior, exclusão de cancelamentos/compromissos/futuro, grupos vazios e deduplicação semanal/mensal. O teste de acesso por funcionário cobre também as novas distribuições.
