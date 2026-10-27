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
