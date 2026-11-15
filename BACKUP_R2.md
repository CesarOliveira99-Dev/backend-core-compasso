# Backups no Cloudflare R2

## Ativação

No backend do Render, configurar `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID` e `R2_SECRET_ACCESS_KEY`. O endpoint deve ser o endpoint S3 HTTPS da conta Cloudflare, sem o nome do bucket. Credencial com Object Read & Write restrita ao bucket privado. Nunca usar variáveis NEXT_PUBLIC ou configurar estas chaves no frontend.

Com as quatro variáveis e `DATABASE_PATH` persistente, o backend inicia a verificação após subir e a repete a cada hora. Se a última cópia confirmada tiver menos de 24 horas, não cria outra. `R2_BACKUP_ENABLED=false` desativa o agendamento. Não adicionar outra réplica do backend ou um cron que presuma acesso ao disco: a arquitetura atual usa um único serviço com o disco persistente.

## Garantias e falhas

- A cópia usa a API online do SQLite, inclui mídias referenciadas e manifesto com SHA-256.
- Envia os arquivos como streams e baixa cada objeto para verificar tamanho e hash. Só publica o manifesto após verificar todos os arquivos.
- O evento JSON `backup_r2_success` informa o prefixo remoto, o instante da cópia, quantidade de arquivos e bytes. Só ele confirma o envio verificado. `backup_r2_failed` indica falha, com nome limitado do erro, sem credenciais ou conteúdo do banco.
- Estado e uma cópia pendente ficam em `.compasso-r2` ao lado do banco. A cópia pendente é preservada se o envio falhar e reenviada na tentativa seguinte. Um lock impede execuções simultâneas; após interrupção abrupta, um lock antigo pode adiar a retomada por até duas horas.
- Processo separado do servidor HTTP, limitado a 30 minutos. Operações S3 têm timeout e tentativas limitadas. Falha do backup não derruba a API.
- Se uma cópia antiga pendente for recuperada, a verificação horária seguinte cria uma nova. O estado considera a data dos dados copiados, não apenas a data de envio.
- Capacidade livre no disco precisa comportar a cópia do banco e das mídias. Uma cópia parcial no R2 sem `manifest.json` não representa backup concluído.

## Retenção e alertas

O código não exclui objetos remotos nem altera regras do bucket. Configurar na Cloudflare uma regra de lifecycle no prefixo `compasso/` com a retenção aprovada pelo responsável (proposta inicial: 30 dias). Monitorar o volume: 30 cópias de 1 GB usam aproximadamente 30 GB, acima da franquia de 10 GB. Não habilitar acesso público.

O health check HTTP do Render não confirma backups. Alertas de indisponibilidade do Render também não alertam automaticamente sobre ausência de `backup_r2_success`. Falta configurar um alerta específico de última cópia confirmada para considerar essa parte da operação concluída. Logs sozinhos não são alerta entregue.

## Recuperação isolada

No shell do serviço com as variáveis R2, usar:

```sh
node scripts/backup-r2.mjs restore compasso/AAAA-MM-DDTHH-MM-SSZ-HASH16 /tmp/compasso-restore-NOVO
```

Copiar o prefixo exato de um evento `backup_r2_success`. O destino e a pasta `DESTINO.download` devem ser novos. A ferramenta baixa os objetos, valida caminhos, tamanhos e hashes e executa `restoreStore`, que verifica integridade SQLite e presença das mídias referenciadas. Nunca apontar para `/data` ou para o caminho ativo do banco. Não iniciar workers, envios de e-mail ou cobranças na cópia restaurada.

O teste completo de recuperação deve ainda conferir uma conta de teste e um agendamento no ambiente isolado, registrar data e duração e remover as cópias isoladas de forma controlada, pois contêm dados reais. Segredos do Render, domínio, configuração de serviços e chaves de criptografia não estão no backup de dados: sua guarda segura é necessária para recuperar o ambiente completo.

