# Refinamentos do piloto — 07/11/2026

Interface: azul-marinho e laranja, seleção única no menu com foco de teclado interno. Início de administrador e funcionário com capa da empresa, monograma e agenda compartilhada. Seletor mensal destaca datas com atendimentos e abre o dia. A imagem usa mídia de ambiente cadastrada; não há campo separado de logo.

Finanças: recebido por data de pagamento, despesas pagas e saldo do mesmo período no fuso da loja. PUT insights/expenses/:uuid cadastra/atualiza sem duplicar ao repetir identificador; DELETE remove. Somente administrador do tenant autenticado. Valores positivos em centavos, categoria enumerada e data válida até hoje. Nenhuma migração; coleção expenses no repositório existente.

Recebimentos de pedidos usam totalCents já descontado e excluem seus atendimentos para evitar duplicidade. Pagamentos independentes usam o preço registrado. Sem paidAt ficam fora do saldo com aviso. Atendimento concluído não equivale a pago; cancelamento não registra estorno. Não é conciliação bancária ou livro-caixa imutável: quitação posterior de pedido com pagamentos individuais pode mudar o agrupamento por data.

Validação integrada local: node scripts/verify.mjs code, 95 testes backend + 8 frontend, tipos e builds aprovados. Navegador: desktop e 390×844, início de admin/funcionário, selecionar dia, cadastro e edição de despesa, recálculo e persistência após reload. Base fictícia isolada. Security-pattern/ub-mode no escopo. Sem publicação, transações externas, carga ou homologação bancária. Publicar backend antes do frontend.
