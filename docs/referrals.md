# Indicações e descontos de renovação

## Regra implementada

Proprietários de Solo e Empresa geram um código aleatório de 12 caracteres. Novos proprietários podem informar o código ao cadastrar Solo ou Empresa, por senha ou Google. O vínculo é fixado no cadastro, não pode ser trocado e só existe uma vez por identidade/e-mail. Contas existentes e autoindicações são rejeitadas.

Cada pessoa indicada gera 1.500 pontos-base (15%) uma única vez, depois do fim do teste de 14 dias e de um pagamento aprovado de valor positivo que cubra período posterior ao teste. Estornos/reembolsos invalidam a conversão; se o benefício já tiver sido utilizado, o débito compensa benefícios futuros. A aprovação isolada de uma assinatura ou uma fatura gratuita não é conversão paga.

O saldo percentual não expira nem tem limite de duas renovações. Cada ciclo utiliza até 10.000 pontos-base. O percentual incide sobre o preço-base do plano do indicador no ciclo reservado; colaboradores extras continuam cobrados. Planos anuais preservam a frequência de 12 meses. Novas indicações recebidas após a reserva ficam para o próximo ciclo. O valor é arredondado em centavos uma única vez.

Reservas, intenção de preço e consumo são persistidos. Atualização remota ambígua repete o valor desejado, sem criar nova assinatura nem consumir outro desconto. Faturas são vinculadas à assinatura, data, valor e pagamento verificados. O preço normal é restaurado após a fatura aprovada. Cobranças já geradas, vencidas ou a menos de 24 horas não são alteradas. Reservas de assinaturas canceladas são liberadas; uma aprovação tardia reconsome a reserva original. Reconciliar a cada cinco minutos também trata a passagem do teste grátis e falhas de webhook.

## Ativação e homologação

O programa fica desligado por padrão. Nenhuma configuração de produção foi alterada por esta implementação.

- `COMPASSO_REFERRALS_ENABLED=true`: habilita código e atribuição no cadastro.
- `COMPASSO_REFERRAL_BILLING_ENABLED=true`: permite reservar descontos e atualizar valores no Mercado Pago.
- `COMPASSO_REFERRAL_ZERO_AMOUNT_VERIFIED=true`: libera ciclos com valor final zero **somente após homologação externa**. Sem isso, saldo suficiente para 100% fica preservado, sem uma cobrança artificial de centavos.

Antes de habilitar o programa, homologar em ambiente do provedor: atualizar 15%, verificar a próxima fatura, confirmar pagamento, restaurar preço normal, repetir notificações, simular perda de resposta e validar ciclo de 100% mensal/anual. O caso zero requer comprovar que a assinatura permanece autorizada, não cobra e avança `next_payment_date`. Somente então o reconciliador concede o período gratuito. A documentação pública confirma atualização do valor recorrente, mas não comprova sozinha que zero seja aceito: https://www.mercadopago.com.br/developers/pt/docs/subscriptions/subscription-management

As flags de ativação não interrompem a restauração de preços e o encerramento de reservas já iniciadas. Não desinstalar o reconciliador com ciclos em aberto. A aplicação usa um único processo sobre SQLite, conforme as restrições existentes do repositório.

## Verificação

`pnpm build` e `node --import tsx --test test/referrals.test.ts test/referrals-http.test.ts`.

Testes locais usam provedor simulado e não comprovam aceitação de valor zero pelo Mercado Pago real. O frontend mostra apenas código, indicadores e ações; as regras operacionais acima não são adicionadas como texto aos fluxos de uso.
