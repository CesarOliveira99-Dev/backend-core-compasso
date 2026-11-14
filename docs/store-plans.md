# Planos e período de teste

| Plano mensal | Funcionários ativos | E-mails por mês | Proteção diária |
| --- | ---: | ---: | ---: |
| Essencial — R$ 59,90 | 1 | 1.000 | 100 |
| Profissional — R$ 79,90 | 5 | 2.500 | 200 |
| Equipe — R$ 99,90 | 10 incluídos + R$25,00 por extra/mês | 5.000 | 400 |

O proprietário/principal não ocupa vaga. Um profissional adicional também ocupa vaga, mesmo sem acesso de funcionário. A pessoa vinculada ao profissional é contada uma vez. Desativação libera a vaga, reativação confere o limite novamente. Contratar um plano menor exige desativar excedentes; nenhum cadastro é apagado.

Novos donos recebem 14 × 24 horas desde a criação da loja, tanto por senha quanto Google, com os recursos do Equipe. Sem cartão obrigatório. Sem autorização explícita de uma assinatura, o término do teste não gera cobrança. O primeiro teste é registrado por hash do e-mail normalizado, impedindo reinício por recadastro com o mesmo e-mail. Isso não constitui verificação antifraude de identidade civil. Clientes não recebem assinatura nem mensalidade; continuam pagando apenas os serviços/produtos contratados.

Ao expirar, novos pedidos, agendamentos e adições de funcionários são bloqueados no servidor. Consultas, dados existentes, gestão de cadastros e processamento de pedidos já criados continuam disponíveis. Lojas preexistentes sem novo plano ou teste mantêm o piloto; não há migração ou cobrança retroativa. Assinaturas legadas precisam de conferência antes de migração ao novo catálogo.

## Colaboradores extras no Equipe

O valor mensal é `9990 + 2500 × extras contratados`, em centavos: 11 vagas custam R$124,90/mês; 12 custam R$149,90/mês. Essencial e Profissional não aceitam extras. O autosserviço permite até 90 extras (100 vagas totais). As franquias de e-mail não aumentam com colaboradores extras.

Na contratação inicial, a quantidade escolhida já compõe o valor enviado ao Mercado Pago e o resumo confirmado pelo dono. O teste gratuito continua com até 10, sem extras pagos ou cobrança automática.

Em uma assinatura Equipe autorizada e com período pago vigente, o dono pode adicionar uma vaga em Equipe ou Configurações. Antes de liberar o cadastro acima da capacidade atual, ele confirma o novo total mensal. `POST /payments/subscription/extras` aceita somente quantidade e valor esperado; valida permissão, plano, capacidade ocupada e preço canônico. Envia `PUT /preapproval/{id}` com o novo valor recorrente, sem criar outra assinatura ou uma cobrança avulsa. A mudança vale para as cobranças ainda não geradas; não há rateio nem ajuste retroativo nesta versão.

As vagas extras são contratadas até redução explícita: desativar um colaborador libera a vaga para substituição, mas não remove a vaga contratada da recorrência. O dono pode reduzir as vagas extras desocupadas e confirmar o novo valor no mesmo painel. Não é permitido reduzir abaixo das vagas ocupadas. Isso evita alteração financeira iniciada por outra pessoa ao aceitar um convite compartilhado.

A intenção de alteração é persistida antes do PUT. Falha incerta bloqueia novas inclusões/reativações e outra alteração, até conferência por GET/Atualizar situação; não há repetição automática de PUT. Recusa HTTP 4xx definitiva mantém preço/capacidade anteriores e remove apenas a intenção recusada. A quantidade só muda após conferir o retorno do provedor. Preços históricos confirmados são preservados para validar faturas antigas, renovação e reembolso após alterações de valor.

Homologar também aumento, redução e momento de aplicação à fatura antes de ativar a cobrança real. Referência: [alterar valor da assinatura](https://www.mercadopago.com.br/developers/pt/docs/subscriptions/subscription-management).

## E-mails

Confirmações, reagendamentos e lembretes compartilham a franquia da loja. As contagens reiniciam no primeiro dia do mês e à meia-noite em America/Sao_Paulo. Os dois limites valem simultaneamente. Segurança, recuperação de senha e mensagens de cobrança não passam pela franquia de agendamentos, mas continuam consumindo a capacidade contratada do provedor. O total comercial de franquias não substitui a contratação de capacidade suficiente no Resend.

Uma reserva é persistida antes do envio; retentativas usam o mesmo identificador, sem consumir várias unidades. Rejeição definitiva na primeira tentativa devolve a unidade. Entrega incerta ou falha após tentativa anterior mantém reserva conservadora, inclusive após reinício. A fila aguarda limite disponível, sem gastar tentativas por franquia cheia; mensagens vencidas/canceladas não são enviadas. A janela de validade da fila continua sendo 23 horas. Avisos no painel de 80% e 100% são deduplicados por período; não há excedente pago automaticamente.

## Cobrança e ativação

`COMPASSO_SUBSCRIPTIONS_ENABLED=false` é o padrão. Para homologar, configurar no backend `MP_PLATFORM_ACCESS_TOKEN`, `MP_PLATFORM_USER_ID`, `MP_WEBHOOK_SECRET`, `MP_SANDBOX` coerente com as credenciais, `APP_URL` e `PUBLIC_API_URL` HTTPS. Credenciais da plataforma cobram o SaaS; tokens OAuth de lojistas continuam recebendo os serviços de seus clientes. O antigo preço único `COMPASSO_MONTHLY_PRICE_CENTS` não define os novos planos.

No painel Mercado Pago, configurar a URL `PUBLIC_API_URL/payments/webhook` para os eventos `subscription_preapproval`, `subscription_authorized_payment` e `payment`, conforme os tipos de eventos disponíveis no painel. O retorno do navegador não ativa o plano. O backend valida assinatura do webhook, consulta assinatura/fatura/pagamento na API e confere referência local, loja, recebedor, moeda, valor e ambiente. Uma assinatura autorizada sem fatura paga não é um período pago.

O proprietário confirma plano e recorrência antes de ir ao Mercado Pago. Durante o teste grátis, a contratação fica bloqueada no servidor: o checkout real apresentou cobrança imediata apesar de `auto_recurring.start_date` futuro. Após o teste, a contratação pode começar com cobrança imediata. Só uma fatura aprovada libera o período pago. Cancelamento preserva o período já pago; estorno/reembolso remove o direito associado àquela fatura. O vencimento usa um mês de calendário a partir do débito, ajustando o último dia dos meses curtos.

Falha de rede ao criar assinatura mantém a intenção pendente. O botão Atualizar situação recupera por referência e consulta faturas paginadas (até 100 por atualização). Não se cria nova assinatura enquanto o resultado anterior for incerto. Troca de plano nesta versão exige cancelamento e fim do período pago; não há rateio, migração automática nem pacote adicional cobrado.
Uma contratação pendente sem período pago pode ser cancelada pelo proprietário no Compasso. A API confirma que ela continua pendente no Mercado Pago, envia o cancelamento e lê novamente o estado antes de liberar outra escolha. Falhas de comunicação mantêm a tentativa bloqueada até nova conferência.

## Homologação antes de ativar para lojas

Os testes locais usam SQLite em memória, transporte simulado e navegador com respostas de exemplo; não fazem cobranças. Ainda é necessário confirmar com credenciais apropriadas: link de contratação, autorização recorrente, primeira cobrança após o teste, entrega e reentrega dos três eventos, renovação, recusa, cancelamento e estorno. Uma compra avulsa via Bricks não homologa assinaturas.

Após conferir os eventos e o fluxo recorrente, habilitar `COMPASSO_SUBSCRIPTIONS_ENABLED=true` e realizar o deploy. Publicar a API antes do frontend, pois o catálogo e a regra de acesso são do servidor. Os novos cadastros iniciam o teste mesmo enquanto a contratação está desabilitada; habilitar a cobrança antes da expiração dos primeiros testes ou adiar a abertura pública do cadastro. Manter uma instância da API com disco persistente e backup: os controles atuais não suportam múltiplas réplicas.

Fontes: [assinaturas pendentes](https://www.mercadopago.com.br/developers/pt/docs/subscriptions/integration-configuration/subscription-no-associated-plan/pending-payments), [criar assinatura](https://www.mercadopago.com.br/developers/pt/reference/online-payments/subscriptions/create-preapproval/post).
