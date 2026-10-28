# Painel web

Aplicação Preact (Vite) em `web/`, servida pelo próprio backend a partir de `dist/web`. Funciona como PWA: tem manifesto e um service worker que guarda só o shell do app, nunca respostas da API.

## Desenvolvimento local

1. `npm run auth:setup` e copie os três valores `AUTH_*` para o `.env`. Cadastre a chave TOTP no app autenticador.
2. Acrescente `COOKIE_SECURE=off` ao `.env` (o cookie seguro não funciona em HTTP).
3. `npm start` sobe a API em `:8080`.
4. Em outro terminal, `npm run dev:web` abre o painel em `http://localhost:5173`, com proxy de `/api` para a API.

Para testar o build que vai para produção: `npm run build:web` e `npm start`, e abra `http://localhost:8080`.

## Widgets

Saldo em contas, cartões e limite, fluxo de caixa, gastos, parcelas, transações recentes, atualização das fontes e divergências abertas. Cada widget mostra a idade do dado mais antigo que usa, e passa a avisar quando passa de 6 horas.

A ordem e a visibilidade dos widgets ficam no banco (`/api/layout`), então valem em todos os aparelhos. A ocultação de valores fica em cada aparelho (localStorage) e começa ligada.

## Telas

- **Painel:** grade de 12 colunas. Em "Personalizar painel" cada widget se move pela barra de cima, se redimensiona pelo canto e pode ser removido; é possível adicionar o mesmo widget mais de uma vez, cada um com a sua própria configuração (período, ciclo da fatura). O visual de cada widget muda com o tamanho: pequeno mostra só o número principal, médio acrescenta gráfico e algumas linhas, grande mostra mais linhas e detalhes. Em telas estreitas os widgets empilham e a edição fica desligada.
- **Transações:** explorador com filtros na URL (período, tipo, categorias, instituições, contas, situação, status, ciclo da fatura, faixa de valor, busca por texto), totais do filtro e lista. Todo widget leva para esta tela, ou para a sua tela própria, já com o escopo que ele mostrava.
- **Detalhe de transação:** painel lateral com o que cada fonte reporta, parcelas da mesma compra, histórico do estabelecimento, fatura em que cai e divergências. Permite recategorizar com uma categoria existente ou nova e, opcionalmente, criar uma regra para todas as transações com a mesma descrição.
- **Gastos:** categorias ou estabelecimentos; cada linha abre as transações que a compõem.
- **Cartões:** o ciclo em aberto é o padrão. Dá para escolher faturas fechadas por mês de vencimento. Mostra situação (paga, a pagar, vencida), o que foi lançado, o que foi pago e o histórico de faturas, além das abas Parcelas e Limites.
- **Contas, Fluxo e Fontes:** saldo por instituição, fluxo de caixa com lista de entradas e saídas, e a atualização das fontes com as divergências.
- **Ajustes:** ocultar contas e cartões (saem de todos os totais), criar e excluir categorias e remover regras de categoria.

## Como o ciclo da fatura é calculado

Cada fatura publicada pelas fontes (fechamento, vencimento, total) define um ciclo: do dia seguinte ao fechamento anterior até o fechamento. Depois do último fechamento começa o ciclo em aberto. Um pagamento vale para a fatura em cujo período ele cai (do dia do fechamento até o dia anterior ao próximo fechamento), e o mesmo pagamento informado duas vezes no mesmo dia conta uma vez. A fatura fica paga quando os pagamentos cobrem o total com tolerância de R$ 1; abaixo disso fica paga em parte, a pagar ou vencida. Faturas anteriores à primeira transação que temos ficam "sem dados", porque não dá para ver os pagamentos. Para o ciclo em aberto, o total é o saldo que o emissor informa menos as faturas fechadas ainda não pagas, o que pode incluir parcelas futuras; por isso a tela mostra também o que já foi lançado.

## Conferência entre fontes

- Uma fonte não ter uma transação é normal e não gera aviso. A transação mostra um selo "só pierre" ou "só pluggy", e os totais a incluem.
- Um relato de "lançada" de qualquer fonte vence o de "pendente". Pendente que só uma fonte vê e que tem mais de 7 dias fica fora dos totais (também quando existe uma gêmea lançada com o mesmo valor a até 5 dias). Pendente que as duas fontes veem vale, porque o banco diz o mesmo.
- Dados anteriores a 2026-01-01 são apagados a cada reconciliação (`DEFAULT_DATA_START` em `src/reconcile/run.ts`).
- Em "Fontes e conferência" aparecem só os pares que parecem a mesma transação em fontes diferentes (mesmo valor, até 5 dias de diferença). "É a mesma" junta os dois; "Não é" descarta a sugestão para sempre.
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
- Para rodar à mão: `npm run categorize`.
