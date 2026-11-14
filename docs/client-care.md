# Acompanhamento de clientes

Funciona em Solo e lojas, respeitando a assinatura e as permissões existentes. O Solo permanece privado, sem novos logins, páginas públicas, pagamentos de clientes ou envios automáticos. Profissionais de lojas consultam apenas seus próprios atendimentos e clientes vinculados. A mesma identidade em dois espaços não compartilha dados nem modelos entre eles.

## Lembretes manuais
- Configurações → Lembretes nas lojas; Cadastros → Lembretes no Solo. Também acessíveis por Acompanhamento → Lembretes, inclusive para profissionais.
- Até 20 modelos individuais por espaço: título de 2–60 caracteres e mensagem de até 1.500. Títulos/IDs únicos, revisão otimista para evitar sobrescrita concorrente e compatibilidade de leitura do modelo antigo.
- No atendimento, selecionar pelo título ou escolher mensagem avulsa. Editar o texto da conversa não altera o modelo salvo. Prévia obrigatória para gerar o link, com validação também no servidor.
- Variáveis permitidas: {nome}, {servico}, {data}, {horario}, {profissional}, {estabelecimento}. Data/hora vêm do fuso da agenda. Observações privadas e outros dados não são interpolados.
- O profissional revisa e envia no WhatsApp. Nenhuma confirmação de entrega ou envio automático é inferida da abertura do link. WhatsApp Business permanece desativado.

## Ficha e retornos
- Resumo: visitas concluídas, última visita/serviço, cancelamentos, faltas, duração média, produção em serviços e gráfico dos últimos seis meses; valores não representam caixa recebido.
- Regra por cliente, serviço e profissional, de 1 a 730 dias após o último atendimento concluído. Ações: próximos 7 dias, em atraso, já agendados, sem histórico, futuros ou pausados. Pausar/retomar e abrir a ficha específica. Um agendamento ativo futuro evita aviso de atraso.
- Indicadores abrem acompanhamento ou lista de espera. As análises comparam períodos iguais e mostram valor produzido por serviço; pagamentos e despesas continuam em Finanças.

## Agenda
- Recorrências: administrador, 2–12 ocorrências totais, intervalo de 1–8 semanas. Mantém horário local e duração. Validação integral e transação: conflito em uma ocorrência desfaz toda a série; repetição da mesma requisição não duplica reservas. Cada ocorrência é independente para reagendamento/cancelamento. Pagamentos não são cobrados pela recorrência.
- Bloqueios: profissional autorizado, período futuro de até 7 dias; rejeitam sobreposição com reservas/bloqueios ativos. Participam da disponibilidade e validação de criação/reagendamento. Exibição listrada no calendário, fora dos contadores de atendimentos e relatórios. Liberação com revisão otimista.
- Lista de espera: cliente, serviço, profissional, datas (até 90 dias) e faixa de horário. Sugere até 3 vagas reais nos próximos 7 dias da preferência. Oferecer vaga pelo WhatsApp não reserva o horário; administrador confirma com nova checagem de disponibilidade e atualização transacional. Contato iniciado é um registro manual, sem prova de envio. Preferências expiradas deixam de contar como pendentes.
- Faltas: só após o início de atendimento ativo. Usa attendanceOutcome=no_show e encerra a reserva; contadores/CSV distinguem de cancelamento. Registra autor/data e preserva pagamento. Sem disparo de aviso de cancelamento por essa ação.

Sem migração SQL: novas coleções documentais, sem alteração de credenciais ou variáveis de produção. Continuam válidas as restrições atuais de implantação em instância única com SQLite.
