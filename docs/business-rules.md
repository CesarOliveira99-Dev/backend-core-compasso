# Regras da primeira versão

## Identidade

Cada loja tem um código único e um administrador inicial. O cliente se cadastra com o código da loja; um mesmo e-mail pode existir em lojas diferentes. O papel e a loja são obtidos da sessão no backend e não de campos enviados em operações de negócio.

## Agenda e triagem

- Uma agenda representa a capacidade de atendimento de um administrador por loja. Não há múltiplos profissionais ou recursos simultâneos nesta versão.
- Estados: `pending` (triagem), `confirmed`, `completed`, `cancelled`.
- Pedidos em triagem reservam o intervalo até a decisão. Uma recusa libera o intervalo; cancelados não bloqueiam novas reservas.
- A triagem exige uma descrição. Serviços e produtos podem solicitar triagem. Produtos em triagem não podem ser concluídos nem marcados como pagos antes da decisão.
- O backend recusa datas passadas, sobreposição e horários fora do expediente configurado.
- A conclusão manual pode ocorrer antes ou depois do horário estimado. A automática atua apenas em agendamentos confirmados cujo término estimado já passou.
- A conclusão gera uma notificação para avaliação; não registra pagamento.
- Horas trabalhadas são calculadas pela duração agendada dos atendimentos finalizados. Não existe apontamento real de entrada/saída.

## Datas e resumo do dia

O fuso inicial é `America/Sao_Paulo`. Uma semana vai de domingo a sábado e só vira no domingo local. O relógio e as regras são avaliados no backend.

O resumo apresenta saudação de acordo com o horário, nome do administrador, pendências e compras ainda não vistas. A seção “O que já foi feito até agora” aparece somente quando há atendimento do dia ou pedido concluído naquele dia. Ao reabrir o menu, o conteúdo é montado a partir do estado atualizado.

## Preços e descontos

Valores são inteiros em centavos. Promoções são exibidas no catálogo com preço anterior e percentual. A cotação do checkout é calculada no backend e os valores são revalidados antes da compra. O pedido preserva o preço acordado, mesmo que o catálogo mude depois.

Cupons e promoções não acumulam; o maior percentual válido é aplicado a cada item. Uma lista vazia de itens, tipos ou dias significa ausência daquela restrição. Para serviço, o dia da semana é o do atendimento; para produto, é o da compra. O período de validade é verificado no momento da solicitação.

Um cupom permite um uso por conta de cliente, até o limite de clientes configurado. O valor zero representa ausência de limite global. A cotação não consome o cupom; somente a confirmação bem-sucedida o faz. Cupons não são restaurados automaticamente após cancelamento, pois reversões comerciais não foram implementadas.

## Checkout e pagamentos

Nesta etapa, só há pagamento no atendimento para serviços e na entrega para produtos, conforme a configuração do administrador. Sem uma modalidade disponível, a confirmação é recusada. O cliente não recebe uma ação de pagamento online.

Endereços são cadastrados no perfil; um deles é padrão. No checkout, o cliente pode escolher outro endereço. O pedido guarda uma cópia do endereço escolhido para que alterações futuras no perfil não mudem a entrega acordada.

A chave de idempotência evita pedidos repetidos na mesma tentativa de checkout. Finalizar um pedido não significa receber seu valor. Marcar um pedido como pago atualiza seus atendimentos associados; marcar um atendimento isolado não quita outros itens do pedido.

Pedidos com serviços em andamento precisam ter os atendimentos resolvidos na agenda antes da conclusão do pedido. Cancelamento parcial de pedidos, estornos, crédito e conciliação devem ser tratados na evolução financeira; esta entrega não efetua essas operações.

## Carteira

O período inicial é de 30 dias. “Valor produzido” soma serviços finalizados e produtos de pedidos finalizados, sem contar o serviço novamente no pedido. “Recebido dos concluídos” considera somente esses registros marcados como pagos; não é o extrato de caixa de todos os adiantamentos. “Ainda a receber” acompanha os concluídos pendentes.

A projeção considera serviços futuros confirmados, pagos ou pendentes, e usa o valor preservado no agendamento. A carteira não representa saldo bancário nem lucro líquido.

## Relacionamento

Avaliações ficam disponíveis após o atendimento ser concluído, com uma avaliação por atendimento. O administrador pode responder e abrir uma conversa manual no WhatsApp. Mensagens personalizadas são entregues nas notificações internas.

Retornos sazonais só podem ser programados após um atendimento ou pedido concluído daquele item. O cliente escolhe uma data de lembrete; isso não cria uma reserva ou cobrança automática. Ao chegar a data, o backend cria uma notificação e marca o lembrete como enviado.

Lembretes de atendimento são gerados na hora anterior ao início. O backend precisa estar ligado; envios externos e execução distribuída não fazem parte desta etapa.
