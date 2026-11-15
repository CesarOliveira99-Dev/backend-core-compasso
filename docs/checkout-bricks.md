# Checkout Bricks — piloto

Base: `atualizacao-render-2026-11-07`. Acompanhar com a alteração de frontend `checkout-bricks-2026-11-10`.

## Fluxo

O cliente abre o pagamento em Meus pedidos. O backend verifica titular, tenant, triagem, agenda, status e valor; entrega somente a chave pública recebida no OAuth do vendedor e o total preservado no pedido. O frontend carrega o SDK React oficial sob demanda e exibe Payment Brick com cartão de crédito e Pix. O backend envia os dados tokenizados para `/v1/payments` usando o Access Token da loja conectada; os valores e referências do cliente são ignorados. Nenhuma chave privada chega ao navegador.

`POST /payments/orders/:id/bricks` prepara/reabre a tentativa. `POST /payments/orders/:id/bricks/pay` cria ou recupera a mesma cobrança. `GET /payments/orders/:id/bricks/status` consulta a cobrança já associada ao pedido. As três rotas exigem autenticação e isolamento da loja. O webhook assinado existente e a consulta autenticada da API usam a mesma rotina de validação e liquidação.

## Credenciais e publicação

Continuar com a aplicação e o OAuth existentes. O token OAuth normalmente inclui `public_key`, já armazenada com os tokens criptografados. Se faltar em uma conexão antiga, autorizar novamente a loja. `MP_PUBLIC_KEY` é uma alternativa de configuração no backend para a chave pública correta da integração; não preencher com um valor de exemplo. `MP_CLIENT_ID`, `MP_CLIENT_SECRET`, `MP_WEBHOOK_SECRET`, `PAYMENTS_ENCRYPTION_KEY`, `PUBLIC_API_URL` e `MP_SANDBOX` mantêm seus papéis. Não trocar a chave de criptografia do banco existente. Para Pix, cada conta recebedora precisa de chave Pix ativa e elegibilidade no provedor.

Publicar primeiro o backend e depois o frontend, mantendo os serviços em uma instância como no piloto atual. Não mesclar/publicar automaticamente: validar em ambiente separado com as credenciais e contas de teste apropriadas ao OAuth. Não misturar conta/token sandbox com produção. Depois de homologado, manter `MP_SANDBOX=false` para operações reais. A aceitação de Bricks, dos meios disponíveis e a chave pública devem ser confirmadas na aplicação/conta reais, não apenas pelos testes locais.

## Duplicidade, falhas e compatibilidade

Há uma rota reservada por pedido para impedir dois checkouts concorrentes. Pedidos com um link Checkout Pro emitido continuam no link original; testar Bricks com um pedido novo. A preferência antiga não é cancelada nem recriada. Pedidos novos reservam exclusivamente Bricks.

A primeira requisição é persistida criptografada antes de chamar o provedor. Uma falha de rede ou HTTP 5xx preserva o mesmo corpo tokenizado e a mesma chave de idempotência. `Verificar pagamento` consulta a situação ou reenvia essa mesma tentativa, sem aceitar outro cartão no lugar durante a incerteza. Após dez minutos sem resposta confirmável, o sistema bloqueia novo envio e orienta conferência pela loja; verificar o pedido em Mercado Pago antes de qualquer nova cobrança. Uma recusa definitiva ou erro HTTP de validação permite preparar outra tentativa. Uma cobrança pendente, inclusive Pix, permanece vinculada até resolução pelo provedor. Ao confirmar uma resposta ou webhook verificável, descartar o corpo criptografado da tentativa.

Um pedido cancelado durante uma cobrança não é marcado pago automaticamente; a loja precisa conciliar a operação e eventual estorno no Mercado Pago. Não reverter o frontend para o fluxo antigo enquanto houver pagamentos Bricks pendentes sem antes conferi-los.

## Verificação executada e pendências

- Backend: `pnpm test` com 103 testes aprovados, incluindo 10 cenários novos de Bricks. Webhook, isolamento, valores, retorno perdido, concorrência, Pix pendente, recuperação e recusa cobertos com provedor simulado.
- Frontend: tipos, 10 testes existentes e build de produção aprovados.
- Navegador: janela em 1280×900 e 390×844, ausência de rolagem horizontal, montagem estável do SDK, configuração cartão/Pix, recuperação e confirmação. Provedor simulado; nenhuma cobrança criada pelo teste.
- Revisão manual focada em segurança e ub-mode; sem revisão independente externa nem certificação financeira.
- Pendente: formulário real do SDK com chave válida, pagamento real/sandbox de cartão e Pix para uma loja conectada, QR Code, recusa, fechamento/reabertura e confirmação por webhook no ambiente publicado. Verificar também o retorno de pedido e atendimento como pagos. Os testes locais não comprovam homologação do Mercado Pago.

Referências: https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/payment-brick/default-rendering e https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/payment-brick/payment-submission/introduction
