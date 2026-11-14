# Último atendimento e navegação do cliente — 07/11/2026

Card na tela inicial pessoal e na área da loja: foto do serviço, loja, profissional e data/horário no fuso do estabelecimento. Avaliação direta sem procurar outra página. Após envio mostra a nota; o backend impede segunda avaliação. Agendar novamente abre nova reserva com serviço selecionado, sem reaproveitar preço/horário antigos. Removidos/inativos permanecem no histórico com repetição desativada. Foto ausente usa composição neutra.

X acima do card dispensa aquele atendimento no navegador, por identidade; persiste após reload e não impede novo card após outra conclusão. Não apaga o atendimento. Menu de três linhas à esquerda, inclusive no celular; drawer continua abrindo pela esquerda.

Resumo autenticado `GET auth/last-visit` agrega somente vínculos comprovados por identityId, com compatibilidade do cliente legado da própria loja. Não combina contas por e-mail e não cria vínculos ao consultar. `POST auth/last-visit/review` resolve o cliente e a loja pelo histórico autenticado; rejeita chave de outro usuário e duplicidade, usando a regra existente de FeedbackService dentro de transação. Sem notas privadas, senhas ou e-mails no resumo.

Validação: 99 testes do workspace aprovados (91 backend e 8 frontend), tipos e builds aprovados. Novos testes cobrem vínculos entre lojas, e-mail igual sem identidade, acesso indevido, duplicidade, papel, estado, cliente legado, serviço removido e conteúdo/ações do card. Revisões security-pattern/ub-mode focadas nessas fronteiras; resposta sem histórico usa JSON explícito com visit=null.

Navegador local, conta e base fictícias: avaliação enviada a partir do início pessoal, estado Avaliado, X persistente após reload, novo atendimento reaparecendo, nova reserva com serviço selecionado, card na área da loja e menu funcionando à esquerda. Conferidos desktop e 390×844; navegação mobile ajustada para evitar rolagem horizontal. As fotos da prévia usam mídia pública já existente do estabelecimento. Sem avaliação, reserva ou alteração de dados de produção nesta implementação.

Limites: Docker local e carga não executados. Histórico consulta as lojas atuais e não comprova capacidade para múltiplas réplicas ou grande volume. Dispensa é local ao navegador, não sincronizada entre dispositivos.
