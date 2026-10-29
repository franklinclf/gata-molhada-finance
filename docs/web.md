# Painel web

Aplicação Preact (Vite) em `web/`, servida pelo próprio backend a partir de `dist/web`. Funciona como PWA: tem manifesto e um service worker que guarda só o shell do app, nunca respostas da API.

## Desenvolvimento local

1. `npm run auth:setup` e copie os três valores `AUTH_*` para o `.env`. Cadastre a chave TOTP no app autenticador.
2. Acrescente `COOKIE_SECURE=off` ao `.env` (o cookie seguro não funciona em HTTP).
3. `npm start` sobe a API em `:8080`.
4. Em outro terminal, `npm run dev:web` abre o painel em `http://localhost:5173`, com proxy de `/api` para a API.

Para testar o build que vai para produção: `npm run build:web` e `npm start`, e abra `http://localhost:8080`.

## Widgets

Saldo em contas, cartões e limite, fluxo de caixa, gastos, parcelas, orçamento, patrimônio, metas, resumo do mês, próximos 14 dias, calendário, maiores altas, itens para revisar, transações recentes, atualização das fontes e divergências abertas. Quem já tem um painel salvo não ganha os novos sozinho: eles aparecem em "Personalizar painel > Adicionar widget". Cada widget mostra a idade do dado mais antigo que usa, e passa a avisar quando passa de 6 horas.

A ordem e a visibilidade dos widgets ficam no banco (`/api/layout`), então valem em todos os aparelhos. A ocultação de valores fica em cada aparelho (localStorage) e começa ligada.

## Telas

- **Painel:** grade de 12 colunas. Em "Personalizar painel" cada widget se move pela barra de cima, se redimensiona pelo canto e pode ser removido; é possível adicionar o mesmo widget mais de uma vez, cada um com a sua própria configuração (período, ciclo da fatura). O visual de cada widget muda com o tamanho: pequeno mostra só o número principal, médio acrescenta gráfico e algumas linhas, grande mostra mais linhas e detalhes. Em telas estreitas os widgets empilham e a edição fica desligada.
- **Transações:** explorador com filtros na URL (período, tipo, categorias, instituições, contas, situação, status, ciclo da fatura, faixa de valor, busca por texto), totais do filtro e lista. Todo widget leva para esta tela, ou para a sua tela própria, já com o escopo que ele mostrava.
- **Detalhe de transação:** painel lateral com o que cada fonte reporta, parcelas da mesma compra, histórico do estabelecimento, fatura em que cai e divergências. Permite recategorizar com uma categoria existente ou nova e, opcionalmente, criar uma regra para todas as transações com a mesma descrição.
- **Gastos:** categorias ou estabelecimentos; cada linha abre as transações que a compõem.
- **Cartões:** o ciclo em aberto é o padrão. Dá para escolher faturas fechadas por mês de vencimento. Mostra situação (paga, a pagar, vencida), o que foi lançado, o que foi pago e o histórico de faturas, além das abas Parcelas e Limites.
- **Calendário:** toque num dia para ver as transações dele (a lista completa, com valores, abrindo o painel de cada uma), o que se espera e o saldo projetado; toque em outro dia para selecionar o período entre os dois. "Abrir em Transações" leva a mesma seleção para o explorador.
- **Contas, Fluxo e Fontes:** saldo por instituição, fluxo de caixa com lista de entradas e saídas, e a atualização das fontes com as divergências.
- **Orçamento, Patrimônio, Metas, Calendário e Analista:** ver as seções com o mesmo nome abaixo.
- **Ajustes:** ocultar contas e cartões (saem de todos os totais), categorias e seus grupos, regras por condições, IA, dados (versão, backup) e segurança.
- **Menu:** em tela larga o menu de cima mostra sete seções e guarda o resto em "Mais"; no celular a barra de baixo tem quatro e "Mais" abre o resto.

## Como o ciclo da fatura é calculado

Cada fatura publicada pelas fontes (fechamento, vencimento, total) define um ciclo: do dia seguinte ao fechamento anterior até o fechamento. Depois do último fechamento começa o ciclo em aberto. Um pagamento vale para a fatura em cujo período ele cai (do dia do fechamento até o dia anterior ao próximo fechamento), e o mesmo pagamento informado duas vezes no mesmo dia conta uma vez. A fatura fica paga quando os pagamentos cobrem o total com tolerância de R$ 1; abaixo disso fica paga em parte, a pagar ou vencida. Faturas anteriores à primeira transação que temos ficam "sem dados", porque não dá para ver os pagamentos. Para o ciclo em aberto, o total é o saldo que o emissor informa menos as faturas fechadas ainda não pagas, o que pode incluir parcelas futuras; por isso a tela mostra também o que já foi lançado.

## Conferência entre fontes

- Uma fonte não ter uma transação é normal e não gera aviso. A transação mostra um selo "só pierre" ou "só pluggy", e os totais a incluem.
- Um relato de "lançada" de qualquer fonte vence o de "pendente". Pendente que só uma fonte vê e que tem mais de 7 dias fica fora dos totais (também quando existe uma gêmea lançada com o mesmo valor a até 5 dias). Pendente que as duas fontes veem vale, porque o banco diz o mesmo.
- Dados anteriores a 2026-01-01 são apagados a cada reconciliação (`DEFAULT_DATA_START` em `src/reconcile/run.ts`).
- Em "Fontes e conferência" aparecem só os pares que parecem a mesma transação em fontes diferentes (mesmo valor, até 5 dias de diferença). "É a mesma" junta os dois; "Não é" descarta a sugestão para sempre.
- O botão "Atualizar agora" em Fontes e conferência tenta pedir ao Meu Pluggy que atualize cada conexão (`POST /api/refresh`, um `PATCH` por item). Na prática o Meu Pluggy recusa o pedido (ele lê cada banco sozinho uma vez por dia; o Pierre era quem deixava atualizar na hora). Quando recusa para todas as conexões, a tela explica, mostra os códigos HTTP e troca o botão por um link para abrir o Meu Pluggy; não repete o pedido por 6 horas. Atualizando a conexão no app do Meu Pluggy, o observador (a cada 2 minutos) percebe a hora nova e traz os dados sozinho. As horas em "Última leitura de cada banco" são as do Meu Pluggy, não de algo feito aqui. Roda em segundo plano, segue as mesmas regras do `npm run refresh` (intervalo mínimo de 15 minutos, bloqueio perto do limite mensal de leituras, um pedido por vez) e, ao terminar, lê os dados e reconcilia. Quando bloqueia, a tela explica o motivo. Só aparece se a chave do Pierre estiver configurada.
- No painel de uma transação: "Juntar com outra transação" (lista as candidatas da outra fonte na mesma conta), "Separar o que juntei" e "Ignorar (tirar dos totais)". As escolhas ficam gravadas por registro da fonte e sobrevivem a cada nova reconciliação.

## Interação

- O card inteiro de um widget abre a sua tela; controles e links dentro dele mantêm a própria ação.
- Barras são clicáveis: na tela de Cartões escolhem o ciclo da fatura, em Gastos e Fluxo escolhem o mês. Fatias do anel de gastos abrem a categoria. Os pontos do fluxo de caixa escolhem o dia.
- Passar o mouse mostra o valor exato (barras, anel, linha de gastos, pontos do fluxo) e o texto completo de linhas cortadas.
- Os widgets mostram a lista inteira com rolagem interna em vez de cortar linhas pelo tamanho; o tamanho define só que blocos aparecem.

## Faturas que não batem e parcelas

- **Sobra em uma fatura antiga:** quando uma fatura fechada fica com uma sobra pequena (até 25% do total), passaram 30 dias do vencimento e todas as faturas seguintes foram pagas por inteiro, a sobra é tratada como não cobrada (por exemplo, uma compra "em análise" que saiu da fatura) e a fatura conta como paga, marcada como ajustada. No histórico de faturas do cartão dá para contrariar ("Não está certo") ou marcar à mão uma fatura como quitada. A palavra do usuário vale mais que a regra automática.
- **Mês sem fatura:** ao escolher um mês, um cartão que ainda não tinha fatura nele não entra nos totais nem na lista.
- **Parcelas:** cada compra mostra suas parcelas, cada uma na fatura (mês de vencimento) em que cai e com a situação: paga, fatura fechada a pagar, no ciclo em aberto ou ainda não cobrada. Parcelas que não foram vistas entre duas cobranças têm o mês calculado pelas vizinhas (marcadas como estimadas), e as anteriores aos dados que temos contam como pagas. Descrições com o número da parcela ("Loja 5/6") são tratadas como a mesma compra.
- **Widgets:** a parte principal (número e gráfico) fica fixa no topo do widget; o detalhamento (cartões, categorias, contas, listas) rola por baixo, com barra fina que só aparece com o mouse em cima. O botão ⤢ do widget abre tudo em tela cheia (Esc fecha).

## Categorização por IA

- O servidor, a cada 10 minutos, procura descrições sem categoria da IA, manda ao modelo em lotes de 25 e grava a resposta. Cada descrição é perguntada uma vez só (as parcelas "Loja 03/12" e "Loja 04/12" contam como a mesma), e o resultado fica guardado por descrição.
- Só a descrição, a direção (entrou ou saiu dinheiro) e a categoria que a fonte deu vão ao modelo. Nunca valores, contas nem bancos. Os provedores são instruídos a não guardar nem treinar com o texto. Texto dentro de uma descrição é tratado como dado, não como instrução.
- Confiança alta é aplicada sozinha. Média e baixa viram sugestão em Ajustes, aba IA, onde você aceita, troca a categoria ou recusa. Uma recusa não é perguntada de novo.
- Ordem de prioridade da categoria de uma transação: sua escolha nela, sua regra para a descrição, a IA, a fonte. A categoria original da fonte continua guardada e aparece no painel da transação.
- Custo: todo o histórico de 431 descrições custou cerca de US$ 0,011. O gasto do mês aparece em Ajustes, e o orçamento mensal (`AI_MONTHLY_BUDGET_USD`, padrão US$ 2) interrompe as chamadas quando é atingido.
- Gasto do mês: o app soma o custo que o OpenRouter devolve em cada resposta (`usage.cost`), inclusive de chamadas que cobraram mas não deram resposta útil (resposta vazia de modelo que gastou tudo pensando). A cada 10 minutos, e depois de cada pergunta ao analista, ele também lê `GET /api/v1/key` (`usage_monthly`, mês em UTC), que é o total da chave que o painel do OpenRouter mostra, com testes e avaliações feitos com a mesma chave. O limite mensal vale para o maior dos dois números, e Ajustes mostra os dois ("De onde vem"). Se a leitura falhar, vale o último valor do mesmo mês. Gasto em outras chaves da mesma conta não aparece aqui.
- Para rodar à mão: `npm run categorize`.

## Conferência assistida por IA

- Para cada par em "Para conferir" (mesmo valor, fontes diferentes, até 5 dias de diferença) o modelo recebe só os textos, as datas, o status e o rótulo da fonte (nunca valores, contas ou bancos) e diz se parecem a mesma transação, com confiança. Quando as duas fontes trazem o documento do outro lado do Pix, o modelo também recebe se é o mesmo documento (sim, não ou desconhecido); "não" pesa como "não" e o código nunca junta um par com documentos diferentes. O documento em si nunca vai ao modelo.
- **Quem decide é o código.** Dois registros só são juntados pela IA quando o modelo tem certeza que são o mesmo **e** os fatos são conferidos de novo na hora (mesma conta, fontes diferentes, mesmo valor, até 5 dias, nenhum dos dois ignorado ou posto de lado) **e** nenhum dos dois tem outro parceiro possível. Um "não" com certeza descarta a sugestão. Todo o resto continua como sugestão, agora com a opinião da IA ao lado.
- A junção da IA aparece em "Fontes e conferência → Juntadas pela IA" e no painel da transação, com "Separar". Separar desfaz e a IA não junta aquele par de novo. A reconciliação ao final é a mesma de sempre, então juntar ou separar só muda quais registros formam cada transação.
- Modelo: `openai/gpt-6-luna` (reserva `google/gemini-3.1-flash-lite`), configurável por `AI_MATCH_MODEL`. Em 48 pares inventados (24 iguais e 24 diferentes, metade difíceis) o gpt-6-luna e o gemini acertaram 48/48 e nunca erraram com certeza; o claude-haiku-5.5 errou uma vez com certeza ("Spotify" em meses diferentes), por isso não é usado aqui. Rodar de novo: `npm run eval:pairs`.

## Passkeys e aparelhos confiáveis

- **Passkey** é o login com a biometria ou o PIN do aparelho (Touch ID, impressão digital do Android, Windows Hello), guardada pelo navegador ou pelo sistema (chaveiro do iCloud, Gerenciador de Senhas do Google). Como ficam na sua conta, uma passkey criada no Chrome do Mac aparece no Chrome do celular logado na mesma conta Google. O servidor guarda só a chave pública. A verificação é feita no próprio servidor com `node:crypto`, sem biblioteca, e só aceita cerimônias com verificação do usuário (biometria ou PIN).
- **Para criar:** entre uma vez com a senha e o código, abra Ajustes → Segurança e use "Criar passkey neste aparelho". Depois a tela de login mostra "Entrar com passkey". A passkey vale como login completo (algo que você tem mais algo que você é), então não pede senha nem código.
- **Aparelho confiável:** marque "Confiar neste aparelho por 30 dias" ao entrar (ou depois, em Ajustes → Segurança). O aparelho fica conectado até 30 dias sem uso e no máximo 90 dias desde que foi marcado. O cookie do aparelho troca a cada uso, e o anterior ainda vale por 1 minuto para pedidos em paralelo. Se um cookie antigo aparecer depois disso, o aparelho é revogado (indica cópia). "Sair" tira o aparelho da lista, e "Esquecer" em Ajustes encerra as sessões dele.
- **Mexer em como entrar** (criar ou remover passkey, confiar ou esquecer aparelho) exige uma entrada feita nos últimos 15 minutos com senha e código ou passkey. Uma sessão restaurada por aparelho confiável, ou uma sessão cookie antiga, não basta. Assim, um cookie copiado não vira acesso permanente.
- **Limites:** erros de passkey não travam o login por senha (uma assinatura não se adivinha); só há um limite de 30 por 15 minutos para frear inundação. Erros de senha continuam travando em 5 por 15 minutos.
- **Endereço:** a passkey fica presa ao endereço `PUBLIC_ORIGIN` (no servidor é `https://` mais o nome da VM). Abrir o app por outro nome (IP, outro domínio) desliga as passkeys, e a senha continua funcionando. Se o domínio mudar um dia, é preciso criar as passkeys de novo.

## Fonte única

O Meu Pluggy é a única fonte lida. A integração com o Pierre foi removida (adaptador, chave `PIERRE_API_KEY` e segredo no Key Vault): a assinatura de R$ 40 por mês não acrescentava dados que o Meu Pluggy e a IA não deem. Os registros que o Pierre já tinha trazido continuam guardados como histórico (`sources.active = 0`, `retireSourcesExcept`): sem eles, cerca de 20 transações que só o Pierre viu (como pendências de cartão) sumiriam dos totais. Esse histórico não recebe dados novos e não aparece em Fontes. Os nomes de ids de transações, regras e escolhas suas não mudam. Para apagar o histórico de vez seria preciso decidir o que fazer com essas transações, e isso não foi feito.

A conferência entre duas fontes continua no código (junção, pares para conferir, IA de pares), mas hoje só atua sobre o histórico. Um pendente com mais de 7 dias que só uma fonte vê continua saindo dos totais; faturas de cartão que o provam o devolvem (prova pela fatura).

## Leitura do Meu Pluggy

A cada leitura o adaptador pede as transações duas vezes por conta e junta pelo id: pela data da transação (`dateFrom`, vê a mudança de pendente para lançada de lançamentos recentes) e pela data em que o Pluggy criou o registro (`createdAtFrom`, pega o que o Pluggy ingere tarde mas data para trás, como pagamento de fatura datado no fechamento ou compra que liquida semanas depois). Só a primeira janela perdia esses lançamentos. Limite, disponível, pagamento mínimo, vencimento e final do cartão que a fonte deixa de informar numa leitura não apagam o valor que ela deu antes.

## Compras em outra moeda

O Meu Pluggy manda, numa compra em euro ou dólar, `amount` na moeda original e `amountInAccountCurrency` em reais. O app usava `amount` e contava 9 euros como R$ 9,00. Agora vale o valor cobrado em reais (`chargedAmount`, `src/adapters/pluggy/normalize.ts`), e a moeda e o valor originais ficam guardados (migração 025) para exibir: um selo com a moeda (EUR, USD) na lista e "Valor original" no painel da transação. Se a fonte não trouxer o valor em reais, o número fica como veio e o painel avisa que não houve conversão. Os registros já salvos são corrigidos uma vez, na subida do servidor, a partir das respostas brutas guardadas (`src/sync/backfill-foreign.ts`), inclusive os do Pierre, para os pares continuarem batendo. Numa cópia dos dados de produção a conta corrigiu 6 valores: o Real-Debrid de 26/10 (€ 9,00) passou de R$ 9,00 para R$ 60,85 e o OpenRouter de 01/09 (US$ 10,80) para R$ 58,64; o cartão Gol final 3432 foi de R$ 11,13 para R$ 62,98 e os gastos do mês subiram R$ 51,85.

A etiqueta "só pluggy" some da lista: com uma única fonte ativa ela não informa nada.

## Quem pagou e quem recebeu

Pix, TED e boleto trazem o documento (CPF ou CNPJ) de quem paga e de quem recebe nas duas fontes, e compras no cartão trazem o código de categoria do estabelecimento (MCC). Os adaptadores guardam isso em `source_transactions` (migração 016): o documento vira um hash, para comparar pessoas, mais os 4 últimos dígitos, para mostrar; o número inteiro não é guardado nessa tabela (as respostas brutas em `raw_snapshots` continuam com ele). Os registros antigos são preenchidos uma vez, na subida do servidor, a partir dessas respostas brutas (`src/sync/backfill-parties.ts`).

O que isso muda, sem IA:

- **Transferência entre contas suas:** o dono é o documento que aparece como pagador nas próprias saídas e como recebedor nas entradas. Um Pix cujo outro lado tem esse documento é transferência entre contas suas, mesmo que o texto não diga. Numa cópia dos dados reais isso confirmou as 324 transferências que as fontes já marcavam e achou 3 que o texto escondia.
- **Nome da pessoa:** quando o texto não traz o nome, usa-se o nome com que o mesmo documento aparece em outras transações. Estabelecimentos e Gastos agrupam por esse nome.
- **Categoria:** quando o rótulo da fonte não corresponde a nenhuma categoria nossa, o MCC decide (`src/api/mcc.ts`, só códigos sem ambiguidade). Um rótulo da fonte que já corresponde a uma categoria nossa continua valendo, porque apps de entrega usam códigos de restaurante.
- **Pix e TED para uma pessoa** (CPF) são "Transferências" sem consultar a IA. Para empresa (CNPJ) a decisão fica com o rótulo, o MCC e a IA, porque pode ser uma loja.
- **Um mesmo texto enviado a pagadores diferentes** (como "Pix key transfer" do 99Pay) não vai à IA: uma resposta seria copiada para todos. Respostas antigas desse tipo são descartadas.
- A IA não escolhe "Transferência entre minhas contas", "Pagamento de fatura" nem "Investimentos": isso é decidido por fatos. Uma resposta antiga da IA com uma dessas categorias é ignorada.
- A transação mostra "Para" ou "De", com o nome e os 4 últimos dígitos do documento.

## Exportar e fazer backup

- **CSV:** em Transações, "Exportar CSV" baixa o que o filtro atual mostra (`GET /api/export/transactions.csv`, aceita os mesmos filtros da lista, `style=intl` para vírgula e ponto, e `id=` repetido para exportar só linhas escolhidas). O arquivo começa com a marca de ordem de bytes para o Excel ler os acentos, usa ";" e vírgula decimal, e um texto que começa com `=`, `+`, `-` ou `@` ganha um apóstrofo na frente para a planilha não executá-lo como fórmula.
- **Backup:** Ajustes > Dados > "Baixar backup" gera uma cópia consistente do banco inteiro (`VACUUM INTO`), compacta e cifra com AES-256-GCM, com chave derivada da frase-senha por scrypt (N 2^15). A frase-senha tem pelo menos 12 caracteres e vai no corpo do POST, não na URL. Exige login com senha ou passkey nos últimos 15 minutos, como mudar a forma de entrar. O formato está em `src/backup/backup.ts`. A senha perdida é o arquivo perdido.
- **Restaurar:** `GMF_BACKUP_PASSPHRASE=… npm run restore:backup -- backup.gmfbak novo.sqlite` abre o backup num arquivo NOVO (nunca sobrescreve), confere a integridade e diz o que fazer: parar o app, tirar o banco atual do caminho e colocar o novo no lugar. Não há restauração pela web de propósito, porque trocar o banco com o app no ar é fácil de errar.

## Calendário e contas que se repetem

- **Detecção** (`src/api/recurring.ts`, sem IA): uma cobrança ou entrada é recorrente quando aparece pelo menos 3 vezes, em 3 meses diferentes, com intervalo típico de 24 a 38 dias em pelo menos 70% dos casos, valor dentro de 10% da mediana em 70% dos casos (fixa) ou dentro de 45% em 80% (variável, como conta de luz) e a última dentro de 2,2 intervalos de hoje (senão foi cancelada). Parcelas, pendentes e movimentos que não são gasto nem receita ficam de fora. O nome é o do estabelecimento limpo ou da pessoa. O próximo dia é o dia típico do mês depois da última; se esse dia passou há mais de 5 dias sem aparecer, o item aparece "atrasado". "Não é recorrente" esconde um item (tabela `recurring_ignored`, migração 022).
- **Calendário** (`src/api/calendar.ts`): grade do mês com o que passou pelas contas em cada dia e, de hoje em diante, o que se espera: itens recorrentes pagos da conta (os do cartão já estão na fatura) e as faturas de cartão no vencimento (fechadas e não pagas pelo que falta; a aberta pela estimativa da tela Cartões). O saldo projetado das contas parte do saldo de hoje e anda dia a dia, até 100 dias à frente. Um item cujo dia passou continua esperado e cai em hoje.

## Metas

A tela Metas (`src/api/goals.ts`, tabela `goals`, migração 023) acompanha quanto falta para um valor, com ou sem data.

- **O que acompanha:** um valor que você atualiza, o saldo de uma conta, um bem lançado em Patrimônio ou o patrimônio total. Se o item acompanhado some, a meta cai no valor digitado e avisa.
- **Progresso** é quanto do valor da meta já está guardado. O **ritmo**, quando há data, é julgado pelo caminho andado desde o ponto de partida (o valor no dia em que a meta foi criada): a linha reta entre esse dia e a data é o esperado. Adiantada passa de 10% à frente da linha, atrás do ritmo é mais de 5% atrás, no ritmo no meio; atingida vale também se chegou tarde; atrasada é a data vencida sem atingir. Assim uma meta que já começou com dinheiro não nasce "adiantada".
- **Por mês:** o que falta dividido pelos meses inteiros restantes (pelo menos um).

## Analista (chat)

A tela Analista responde perguntas sobre as suas finanças (`src/ai/analyst.ts`, `analyst-tools.ts`, tabelas `chat_conversations` e `chat_messages`, migração 024).

- **Como funciona:** o modelo devolve, a cada passo, um JSON pedindo uma ferramenta ou dando a resposta. O código roda a ferramenta e devolve o resultado. Há até 6 passos por pergunta; se estourar, o analista diz isso e pede uma pergunta mais específica.
- **Ferramentas (só leem):** visão geral do mês, gastos por categoria ou estabelecimento, fluxo de caixa, lista de transações com a soma de todas as que combinam, cartões, faturas futuras, orçamento, recorrentes, patrimônio, metas e tendência. Todo número já vem calculado em reais pelo código; a regra do prompt é citar o total da ferramenta e nunca somar linhas de cabeça.
- **O que o modelo vê:** descrições (cortadas em 80 caracteres), datas, valores, categorias, nome da instituição e final do cartão. Nunca o documento (CPF ou CNPJ), número de conta nem hash. O texto das transações vem sempre dentro de "observações" e o prompt manda tratá-lo como dado, nunca como instrução. O analista não altera nada.
- **Custo e limites:** modelo barato (claude-haiku-5.5) para o dia a dia e o mais forte (claude-sonnet-5.5) para perguntas abertas (por que, o que mudou, compare, devo...), com reserva se um falhar (`AI_ANALYST_MODEL`, `AI_ANALYST_DEEP_MODEL`). Cada chamada entra no gasto do mês e o limite mensal (`AI_MONTHLY_BUDGET_USD`) vale antes de cada passo. Uma pergunta de cada vez. A pergunta é salva antes da chamada, e as últimas 12 mensagens da conversa entram no contexto de uma pergunta seguinte. Numa medição com dados reais, três perguntas custaram US$ 0,015.
- Fica desligado, e a tela avisa, se a IA não estiver ligada no servidor.

## Busca rápida

Ctrl+K (Cmd+K no Mac) abre a busca rápida em qualquer tela: ir para uma tela (pelo nome ou por palavras como "extrato", "faturas", "backup"), atalhos (Nova transação, Perguntar ao analista, Fazer backup, atualizar as fontes) e, com 3 letras ou mais, as transações cujo texto combina. Setas escolhem, Enter abre, Esc fecha. No celular não há atalho de teclado; use a aba Mais.

## Seletores

Nenhuma tela usa o `<select>` do navegador ou do sistema. `web/src/Select.tsx` é o seletor próprio: lista igual em qualquer aparelho, títulos de grupo, busca (aparece sozinha com mais de 8 opções), teclado (setas, Home, End, Enter, Esc; sem busca, digitar pula para a opção que começa com a letra), marca da opção atual e, quando pedido, "Criar “texto”" para uma opção nova. Abre abaixo do botão (ou acima, se faltar espaço) e, no celular, como uma folha que sobe da base da tela. `CategorySelect` o usa para categorias, agrupadas pelo grupo a que pertencem (ordenados pelo uso, com a contagem à direita, "sua" nas que você criou e "Sem grupo" por último), e é o que aparece no painel da transação, na regra, na transação digitada, nas sugestões da IA e no orçamento. Em Ajustes > Categorias, o grupo de cada categoria se escolhe ou cria no mesmo seletor. A lógica de busca e de agrupamento é pura e testada (`select-model.ts`, `category-options.ts`).

## Versão e atualização

Ajustes > Dados > Versão mostra a versão em execução (o commit, com link para o GitHub) e desde quando está no ar (a hora em que o processo subiu, que é a do último deploy, porque cada deploy recria o contêiner). "Procurar versão nova agora" grava o mesmo arquivo que o webhook (`/data/.deploy-requested`), então a VM roda o deploy e, se houver imagem nova, troca o contêiner; a tela espera até 2 minutos pela mudança de versão. Exige login com senha ou passkey nos últimos 15 minutos e só um pedido a cada 30 segundos, e só aparece quando o app roda sob o serviço de deploy (não em desenvolvimento). O timer de 30 minutos não gera custo: é um timer do systemd na VM que já existe e, quando nada mudou, faz um `git pull` e uma consulta ao registro de imagens (e uma leitura dos segredos a cada 30 minutos, cerca de 500 consultas ao Key Vault por dia, muito abaixo da cobrança). Do terminal: `bash infra/azure/deploy-now.sh`.

## Transações digitadas

"+ Nova" em Transações cria uma transação que nenhuma fonte traz (a cobrança em dólar do cartão Gol que o banco não manda, um pagamento em dinheiro). Ela fica na tabela `manual_transactions` (migração 021) e é somada às transações canônicas no fim de cada reconciliação (`src/reconcile/run.ts`), sem ligação com registro de fonte: a sincronização nunca mexe nela e uma reconciliação nova não a perde. Entra nos gastos, no fluxo, nas faturas do cartão e nas regras como as outras. Valor com sinal de fluxo (gasto negativo), data entre 01/01/2026 e hoje, conta existente. No painel da transação dá para editar e excluir; categoria escolhida ali fica na própria transação. "Ignorar" não vale para ela: exclua. Se a mesma cobrança chegar depois por uma fonte, as duas ficam e é preciso excluir a digitada.

## Tendência e navegação por período

- Em Gastos, a aba Tendência (`src/api/trends.ts`) mostra cada categoria nos últimos 6 meses, com uma linha pequena, a média dos meses fechados, o gasto do mês em andamento e a diferença entre os dois. Estorno, Renda e Sem categoria ficam de fora.
- O seletor de período ganhou as setas ‹ e › (Gastos, Fluxo e Transações). Elas andam o intervalo pelo próprio tamanho: um mês inteiro vai para o mês vizinho (outubro vira setembro, não "os 31 dias antes de 1º de outubro"), três meses inteiros andam três meses, e um intervalo qualquer anda pelo número de dias dele. O mês em andamento é cortado em hoje, e a seta para frente fica desligada quando o intervalo já chega a hoje.

## Patrimônio

A tela Patrimônio (`src/api/networth.ts`, tabelas `assets` e `asset_values`, migração 020) soma o que você tem e tira o que deve.

- **Hoje:** saldos das contas correntes e poupanças visíveis, mais os bens lançados à mão, menos as faturas de cartão (o total que o emissor informa, com limite compartilhado contado uma vez), menos dívidas lançadas à mão e saldos negativos.
- **Histórico (12 meses, não antes de jan/2026):** reconstruído a partir de hoje, desfazendo as transações lançadas depois de cada fim de mês: saldo do mês = saldo de hoje menos o que entrou e saiu depois; dívida do cartão = dívida de hoje mais as compras (negativas) e menos os pagamentos feitos depois. Só transações lançadas contam, porque o saldo do banco não tem as pendentes. A precisão depende de o histórico estar completo.
- **Bens e dívidas à mão** (investimento, imóvel, carro, empréstimo): cada valor tem uma data e vale até o próximo; antes do primeiro valor o item não conta. Dá para arquivar (sai dos totais) ou excluir. Valores futuros, negativos ou com centavos fracionados são recusados.
- Há um widget Patrimônio no painel.

## Orçamento

A tela Orçamento (`src/api/budgets.ts`, tabela `budgets`, migração 019) dá um limite mensal a uma categoria ou a um grupo de categorias.

- **Um valor por mês, com herança:** a linha de um mês vale só para ele, a marcada "repetir nos meses seguintes" vale para ele e para os seguintes até haver outra mais nova. Mudar o limite de outubro não reescreve agosto, e remover a linha mais nova traz a anterior de volta.
- **Gasto do mês** é o mesmo número da tela Gastos (por data da compra, estornos descontam). O ritmo é o gasto até hoje dividido pelos dias passados, vezes os dias do mês; mês fechado não tem projeção.
- **Sem dupla contagem:** uma categoria e o grupo em que ela está não podem ter orçamento ao mesmo tempo (o sistema recusa). Categorias dentro de um grupo com orçamento não aparecem separadas.
- **Gastos sem orçamento** aparecem na lista com o botão Definir.
- **Sugestão pela média:** média do gasto líquido dos últimos 3, 6 ou 12 meses fechados antes do mês escolhido, arredondada para R$ 10. O mês em andamento e meses antes de janeiro/2026 não entram, e Renda e Estorno nunca são sugeridos. Criar vários de uma vez é tudo ou nada.
- **Copiar do mês anterior** copia o que cada alvo vale no mês de origem como linha própria do mês de destino, com ajuste de -100% a +1000%, arredondado ao centavo. Quem já tem linha no mês é mantido, a menos que se peça para substituir, e quem já resolve para o mesmo valor não ganha linha.
- Há um widget Orçamento no painel (quanto sobra, quantas categorias passaram do limite, as mais usadas).

## Regras de categorização

Ajustes > Regras define a categoria por condições (`src/api/rules-engine.ts`, tabela `rules`, migração 018). Uma regra tem condições e uma categoria. As condições combinam "todas" ou "qualquer", e podem ter grupos de um nível ("A e (B ou C)").

- **Campos:** descrição, estabelecimento (nome limpo), pessoa ou empresa do Pix, categoria da fonte, instituição, operação, MCC, valor (em centavos, com sinal: saída é negativa), data, direção, status e papel.
- **Operadores de texto:** contém, não contém, igual, diferente, começa com, termina com e expressão regular. Texto compara sem acento e sem diferença de maiúsculas, nos dois lados. A expressão regular tem até 120 caracteres, precisa compilar, não pode casar texto vazio (`a*` casaria tudo) e não pode repetir um grupo repetido.
- **Valor em branco** nunca casa e não é aceito ao salvar. Zero é um valor de verdade.
- **Prioridade:** o número menor vale primeiro e a primeira regra ativa que casa dá a categoria. Dá para reordenar com Subir e Descer, ligar e desligar.
- **Precedência:** a categoria escolhida na transação e a regra "aplicar a todas com a mesma descrição" valem mais; depois vêm estas regras, a tabela das fontes, o MCC e a IA. Descrições cobertas por uma regra não vão à IA.
- **Papéis não mudam por texto:** uma regra de condições não transforma pagamento de fatura ou transferência entre contas suas em gasto. Só uma regra cuja categoria seja uma dessas (Pagamento de fatura, Transferência entre minhas contas, Investimentos) muda o papel.
- **Prévia:** "Ver o que mudaria" usa o mesmo código da regra salva e mostra quantas transações casam, quantas mudariam e as 15 mais recentes.
- **Exportar e importar:** arquivo JSON com a categoria pelo nome. Importar sobre regras existentes pede confirmação e substitui tudo; regras inválidas ou repetidas são ignoradas e listadas; se nada do arquivo serve, as regras atuais ficam.
- **Categoria apagada:** a regra que apontava para ela é desligada, não apagada.
- **Regras sugeridas** (`src/api/rule-suggestions.ts`): estabelecimentos (nome limpo, fora pessoas e pagamentos de fatura) com 3 transações ou mais em que pelo menos 90% têm a mesma categoria, quando alguma destoa ou o banco escreve o lugar de mais de um jeito. "Criar regra" faz `estabelecimento é X → categoria`, que também acerta as que destoavam. É contagem, sem IA e sem custo; a IA só categoriza (por texto) e não cria regras sozinha.

## Grupos de categorias

Cada categoria pode ficar dentro de um grupo (Aluguel dentro de Casa, por exemplo). As categorias padrão já vêm agrupadas (`src/api/category-groups.ts`: Alimentação, Transporte, Saúde e bem-estar, Casa, Compras, Lazer, Finanças); as que não estão na lista ficam sozinhas. Em Ajustes > Categorias, cada linha tem um seletor de grupo, com a opção de criar um grupo novo, e sua escolha vale mais que o padrão (migração 015, tabela `category_parents`). Grupos têm um nível só: um grupo não entra em outro grupo. A aba Grupos de Gastos é a padrão; ao abrir um grupo aparecem as categorias dele, e cada uma abre as transações. A IA continua usando a lista plana de categorias, então agrupar não gera nova chamada nem nova consulta ao modelo.

## Nomes de estabelecimentos

A aba Estabelecimentos de Gastos agrupa pelo nome do lugar, não pelo texto do banco (`merchantName`, `src/core/merchant.ts`). São regras de texto e uma lista curta de nomes conhecidos, sem IA e sem custo: tira códigos de processadora antes do asterisco, números de loja, sufixos como "SA" e "LTDA", e junta "DL*UberRides", "Uber UBER *TRIP" e "UBER * PENDING" em Uber. Transferências e Pix para a mesma pessoa viram o nome dela, escritas de qualquer jeito. Nos dados reais, 457 textos distintos de saída viraram 280 nomes. O nome de um lugar que não está na lista só perde números e sufixos, então dois lugares escritos de formas bem diferentes continuam separados.

## O que é dado contábil e o que é só rótulo

A categoria que aparece na tela pode mudar: a IA a troca pela lista padrão, e você pode escolher outra. A conta das faturas, dos gastos e do fluxo de caixa não pode depender dela. Por isso cada transação tem um **papel** (`src/api/roles.ts`): pagamento de fatura, transferência entre contas suas ou investimento. O papel vem do que a fonte disse (a categoria que ela deu e o texto), nunca do rótulo da IA. Só uma escolha sua (categoria na transação ou regra) muda o papel: escolher "Pagamento de fatura", "Transferência entre minhas contas" ou "Investimentos" dá o papel, e escolher qualquer outra categoria tira.

Fatura paga por boleto ou Pix QR code: o banco não cita o cartão, então o texto sozinho não basta. Uma saída de conta com cara de boleto ou Pix QR code (categoria ou texto) cujo valor é igual, ao centavo, ao total de uma fatura e que cai de 45 dias antes a 30 dias depois do vencimento dela vira o pagamento daquela fatura. Cada fatura é usada uma vez, e uma escolha sua na transação vale mais.

Foi isso que quebrou as faturas depois da categorização por IA: a IA trocou "Credit card payment" por "Pagamento de fatura", as regras antigas só reconheciam os nomes das fontes, e nenhum pagamento era visto. As faturas apareciam todas vencidas, os créditos entravam como estorno e o ciclo em aberto ficava negativo.

Aviso do Meu Pluggy (webhook). Com `PLUGGY_WEBHOOK_SECRET` definido, `POST /api/hooks/pluggy/<segredo>` recebe os eventos da Pluggy. O dashboard da Pluggy não deixa definir cabeçalhos, então o segredo é o último trecho da URL, comparado em tempo constante; token errado ou ausente responde 404, como uma rota inexistente. Todo corpo JSON recebe 202 (a Pluggy não repete depois de 4xx). `item/updated`, `item/created` e `item/login_succeeded` fazem o observador conferir a hora de leitura na hora; `transactions/created|updated|deleted` forçam a leitura dos últimos 14 dias mesmo que a hora não tenha mudado. Uma rajada de eventos vira uma leitura só (espera de 3 segundos). Com o webhook ligado, a conferência periódica cai de 2 minutos para 30, como garantia contra uma entrega perdida. `item/error`, `item/waiting_user_input` e `item/waiting_user_action` gravam um alerta (configuração `pluggy_connection_alerts`) que aparece em Fontes e conferência como "Uma conexão precisa de você", com link para o Meu Pluggy; o alerta some quando chega `item/updated`, `item/created` ou `item/login_succeeded` do mesmo item. Itens que não estão em `PLUGGY_ITEMS` são ignorados. O webhook só avisa: não faz o Meu Pluggy atualizar mais cedo. Passo a passo em `deploy/README.md`.

Em Fontes e conferência, um aviso "Algo nos dados não fecha" aparece quando o ciclo em aberto de um cartão dá negativo ou as faturas em aberto passam do limite dele, que são sinais de pagamentos não reconhecidos.

O total de Gastos é a soma líquida dos dias, o mesmo número que as barras dos meses mostram. Categorias que só têm estornos não aparecem na lista; o valor delas já está descontado e a tela avisa quanto foi.

## De onde vem o total das faturas em aberto

O valor que o emissor informa como saldo do cartão é o que está sendo usado do limite: as compras do ciclo em aberto mais as parcelas de compras antigas que ainda vão cair em faturas futuras. Esse saldo não é a fatura. O app mostra como "fatura do ciclo" o saldo do emissor menos as faturas fechadas não pagas e menos as parcelas de faturas futuras (que vêm do plano de parcelas), nunca menos que o já lançado. Para cartões de limite compartilhado (os Bradesco), o saldo é um só para o grupo e entra uma vez. A tela de Cartões mostra, ao lado, as parcelas de faturas futuras e o saldo devedor total no emissor, para o número poder ser conferido.

## Cobranças que a fatura prova serem reais

Cartões como o Amazon deixam cobranças como "pendentes" para sempre, só em uma fonte. A regra de 7 dias as tirava dos totais, e a fatura fechada ficava maior que as compras contadas. Agora, depois de cada reconciliação (`src/reconcile/bill-proof.ts`):

1. Se uma fatura fechada é maior que o que contamos nela, e as pendentes postas de lado daquele ciclo somam **exatamente** a diferença (uma única combinação possível), elas voltam a contar, com o estado "confirmada pela fatura". Se mais de uma combinação serve, ou nenhuma, nada é restaurado.
2. Uma cobrança com o mesmo texto e o mesmo valor, de 20 a 40 dias depois de uma que a fatura provou, também volta (parcelas e assinaturas).

No Amazon, as sete pendentes de setembro somam R$ 221,28, que é o valor da fatura de outubro, e as de outubro repetem as de setembro.

Também dá para informar à mão a parcela de uma compra no painel da transação ("Parcelamento": parcela N de M), para compras que a fonte entrega sem essa informação. Com a parcela informada, o app conta as parcelas das faturas seguintes e as tira da fatura em aberto.

## Faturas futuras estimadas

A aba Cartões → Futuras mostra as próximas seis faturas por mês de vencimento, em três camadas, da mais certa à menos certa: **parcelas já compradas** (vêm do plano de parcelas), **cobranças que se repetem** (mesmo texto em pelo menos 3 meses das últimas 6 faturas, com valor estável, que entram todo mês pelo último valor) e o **gasto de costume**, uma média do que as últimas 3 faturas fechadas tiveram além das duas primeiras camadas (um chute). A fatura em aberto mostra também o que já tem e nunca é estimada abaixo disso. Um clique no mês mostra a divisão por cartão.

## Categorias: o que a tabela traduz e o que a IA decide

- As categorias das fontes são uma lista fixa (Pierre em português, Meu Pluggy em inglês). As que dizem uma coisa só são **traduzidas por tabela** (`src/ai/source-map.ts`) para a nossa lista, sem chamar o modelo. As genéricas (Compras, Serviços, Alimentos e bebidas...) e as transações sem rótulo vão ao modelo.
- Ao modelo vão: o texto, a direção, a instituição e o tipo de conta (cartão ou banco), os rótulos das duas fontes, quantas vezes e em quantos meses o texto apareceu, uma faixa de valor (nunca o valor), a parcela se houver, o tipo de operação (Pix, TED, boleto), o código MCC do estabelecimento e o nome limpo (sem prefixo de gateway, número de loja e sufixo da empresa) quando o texto é diferente, e até 40 exemplos de como você mesmo categorizou (sem nomes de pessoas). Respostas "Outros" ou de baixa confiança não aplicam nada e não geram pergunta.
- **Transferências para você mesmo** e pagamentos de fatura são reconhecidos sem o modelo: o nome do outro lado de uma transferência que as fontes marcaram como "mesma titularidade" vira o seu nome, e qualquer transferência para esse nome (mesmo truncado) é entre contas suas. O nome nunca é enviado a modelo. Desde que as fontes passaram a trazer o documento, a transferência para o seu próprio documento também é reconhecida sem depender do nome.
- Em Ajustes → IA, "Decisões anteriores" lista o que a IA aplicou, o que você aceitou, recusou ou ficou sem palpite. Dá para confirmar, trocar, voltar à categoria da fonte ou mandar perguntar de novo, um a um, e há três botões para esquecer em massa (o que a IA decidiu, as suas respostas, ou tudo).

## Gastos sem pagamento de fatura em dobro

A fatura paga pela conta aparece lá como "GASTOS CARTAO DE CREDITO" (Bradesco) ou "PAGTO ELETRON COBRANCA - BANCO BRADESCARD" (Bradescard, que o banco chama de IBI). A Pierre rotulou isso como taxa de cartão e o Meu Pluggy como pagamento de cartão. O papel de uma transação agora olha os rótulos das duas fontes e esses textos, então esses débitos não entram em gastos, que contam as compras no cartão pelo dia da compra.

## Fotos das telas para revisar o visual

`npm run shots` fotografa o app em quatro tamanhos (desktop 1440, notebook 1024, tablet 768 e celular 390) para 13 telas, com dados inventados e sem servidor nem login. Usa o Chrome sem tela (o `chrome-headless-shell` que o Playwright guarda em `~/Library/Caches/ms-playwright`, ou o Chrome em si via `CHROME=...`). As fotos vão para `shots/` (fora do git). `npm run shots -- painel --size phone` tira só uma. Não mostra hover, arrastar nem animação; serve para conferir layout, quebra de texto e responsividade.
