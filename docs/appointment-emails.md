# E-mails de agendamento

Implementada confirmação de agendamento confirmado (incluindo aprovação de triagem e novo horário após reagendamento) e lembrete na janela de uma hora antes. A fila é persistida no SQLite do backend; não exige serviço pago de cron. Ativação explícita por `APPOINTMENT_EMAILS_ENABLED=true`, além de `RESEND_API_KEY`, `MAIL_FROM` e `APP_URL` já usados para recuperação. Desativada por padrão. Somente clientes com e-mail confirmado recebem; não há disparo retroativo de confirmações antigas. Lembretes consideram também agendamentos futuros existentes após a ativação.

Worker a cada 30 segundos, até dez tentativas por ciclo com espaçamento entre chamadas. Mensagem em texto com loja, serviço, profissional e horário no fuso da loja; exclui notas de triagem, credenciais e informações de pagamento. Falha de rede não impede reservar horário. Fila e evento são gravados na mesma transação nos fluxos HTTP de reserva/triagem/reagendamento. Idempotência por loja, agendamento, horário e tipo, com payload persistido imutável. Até seis tentativas com espera crescente; eventos são descartados após início do atendimento ou 23 horas, dentro da janela de idempotência de 24 horas do Resend. Envio aceito pela API é registrado como `sent`; isso não confirma caixa de entrada ou entrega final.

Antes de enviar, revalida cliente, endereço confirmado, horário e status. Cancelamento/reagendamento invalida pendências antigas; mensagem já enviada ou em trânsito não pode ser retirada. Cancelamentos por e-mail e lembretes comerciais de retorno/fidelidade não fazem parte desta rodada. Envio apenas ao cliente, sem cópias ao administrador/profissional.

Revisões security-pattern/ub-mode focadas em isolamento, minimização de dados, falha parcial, duplicidade e transações. Arquitetura destinada à instância única atual com SQLite; não comprova suporte a múltiplas réplicas nem carga de 50 lojas. A fila ainda não possui painel/reprocessamento manual ou tratamento de bounce por webhook. Limites/franquia do Resend continuam aplicáveis. Homologação real da confirmação e lembrete permanece pendente de publicação e teste controlado em produção.


## Validação local

91 testes do workspace aprovados (85 backend e 6 frontend), tipos e builds aprovados em 07/11/2026. Quinze testes específicos cobrem fila, tenant, destinatário confirmado, transação, replay, reagendamento, limite de tentativas, retomada do worker, concorrência no processo, invalidação de mensagens antigas, lembretes, triagem e transporte com Resend simulado. Não foi enviado e-mail real nesta implementação. Docker e carga não executados.
