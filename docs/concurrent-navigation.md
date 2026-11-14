# Navegação simultânea e identificação do BFF

## Implantação
Defina **BFF_PROXY_SECRET com exatamente o mesmo valor privado no backend e no frontend**. Use 32 bytes aleatórios (por exemplo, 64 caracteres hexadecimais). Não use NEXT_PUBLIC_, não reutilize chaves do Mercado Pago e não coloque o valor no Git. O frontend em produção recusa chamadas sem uma chave com pelo menos 32 caracteres.

Ordem para esta atualização: configurar a chave nos dois serviços; publicar primeiro a API (continua aceitando o BFF anterior como tráfego direto), depois o frontend. Não alterar a chave em apenas um lado. Para rotação futura, coordenar a atualização dos dois serviços; não há janela de rotação dupla nesta versão.

## Comportamento
- O BFF cria um identificador aleatório em cookie HttpOnly, SameSite=Lax e Secure em produção, válido por um dia. O cookie tem assinatura própria; alterar o identificador invalida sua assinatura.
- Cada chamada à API inclui um identificador pseudônimo e assinatura HMAC-SHA256 ligada ao método, caminho com query e timestamp (tolerância de 30 segundos). A API rejeita assinaturas inválidas, expiradas ou usadas para outra rota/método.
- Cabeçalhos de identidade, Authorization e IP recebidos do navegador não são repassados como autoridade. O BFF usa a sessão HttpOnly e cria os próprios cabeçalhos assinados. A prova do BFF **não concede login, papel, tenant ou autorização**.
- Usuários autenticados usam identidade verificada da API para os limites gerais; a proteção por usuário permanece em 300 chamadas/minuto (uploads: 12). Os limites de leitura (1.200/minuto), visitantes anônimos e tentativas de entrada usam contadores separados, impedindo que uma pessoa esgote o orçamento de outro usuário autenticado pela simples coincidência do IP do BFF.
- Mutações de autenticação: 30/minuto por visitante assinado ou 120/minuto no acesso direto; entrada também tem 15 tentativas por conta+visitante a cada 15 minutos. Metadados de autenticação/descoberta não consomem o orçamento de mutações.
- Requisições diretas sem prova continuam sujeitas ao endereço remoto da conexão; X-Forwarded-For não escolhe esse orçamento. Provas forjadas têm proteção separada por conexão. O health check não é derrubado pelo consumo do limite de navegação.
- O frontend preserva status 429 e Retry-After, incluindo no bootstrap. Respostas de mídia pública não recebem um cookie novo de visitante, preservando a segurança do cache.

## Limites da proteção
O cookie é um identificador de navegador, não prova de pessoa única. Apagá-lo ou criar novos navegadores muda a identidade anônima. Isto não substitui proteção DDoS, WAF e limites de borda da hospedagem, nem é um teste de capacidade do Render. Não aceitamos um IP alegado pelo cliente como solução para essa limitação. Os contadores permanecem em memória e o SQLite em disco: continua sendo uma implantação de uma instância; escalar exige coordenar limites e persistência.

## Evidências
- 32 usuários, quatro abas simuladas por usuário e 768 requisições simultâneas na API, conferindo identidade de cada resposta.
- Excesso de um usuário produz 429 sem afetar outro usuário na mesma conexão/proxy.
- Cookies adulterados, assinaturas falsas/expiradas e troca de método/caminho rejeitados.
- 16 tentativas simultâneas com chave idempotente criam uma reserva; chaves distintas no mesmo horário produzem uma criação e 15 conflitos. Aba com espaço incorreto recebe 409 e não modifica o outro espaço.
- Pelo BFF real: oito usuários com quatro abas reais cada, cookies HttpOnly, tokens ausentes do JSON, visitante abusivo limitado e outro usuário ainda capaz de entrar e carregar a plataforma.

As verificações usaram dados fictícios locais, sem pagamentos, mensagens ou alterações de ambiente real.
