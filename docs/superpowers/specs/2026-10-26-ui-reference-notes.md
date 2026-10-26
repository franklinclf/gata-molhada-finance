# Referência de interface: o que o app do Pierre faz bem

Data: 2026-10-26. Notas tiradas de capturas de tela do app do Pierre (telas de divulgação e telas reais de uso). Servem de referência para o Plano F (interface e widgets). Este documento não traz valores, nomes nem instituições dos dados reais.

## Linguagem visual

- Tema escuro por padrão, com um verde-limão como cor de destaque e cores próprias de cada instituição (roxo, amarelo, vermelho, laranja) nas barras e logotipos.
- Cartões com cantos bem arredondados, números grandes e rótulos pequenos acima deles.
- Botão de olho no topo para ocultar todos os valores.
- Seletor de instituições no canto superior direito, com os logotipos sobrepostos e uma seta, para filtrar a tela por conta.
- Barra de navegação flutuante, com um campo "Pergunte ao Pierre" (entrada para o assistente de IA) e botões para os agentes.

## Telas e o que mostram

1. **Início**, com abas Contas, Cartão e Investimentos. Blocos: total em faturas (cartões empilhados com os finais), saldo em contas (logotipos e contagem), um alerta de agente (por exemplo, limite de uma categoria, com horário diário), lista de cartões com barra de uso do limite e vencimento, fluxo de caixa (entradas e saídas em barras), gastos do mês (linha acumulada), gastos por categoria ou por grupo com "ver mais N categorias", transações recentes com o logotipo da instituição, assinaturas (soma e quantidade) e limite usado em anel com o disponível.
2. **Saldo em contas:** total, barra única dividida por instituição (com porcentagem) e uma linha por instituição com valor. Botão para adicionar conta e últimos lançamentos.
3. **Faturas**, com abas Faturas, Parcelas e Limites. Próximo vencimento com contagem de dias, gráfico de barras por mês (o mês futuro em destaque), filtro por cartão e um bloco por cartão com valor, situação (aberta) e barra de limite usado contra total.
4. **Fluxo de caixa**, com abas Geral, Entradas e Saídas. Total do mês, entradas e saídas, uma grade de pontos por dia (verde e vermelho) e períodos (este mês, 3 meses, 6 meses, 1 ano). Nota na tela: considera só o dinheiro que entra e sai da conta, e compras no cartão entram quando a fatura é paga.
5. **Gastos:** total do período com variação contra o mês anterior, linha acumulada com a curva do mês anterior tracejada, períodos (1 semana, 1 mês, 6 meses, 1 ano), principais estabelecimentos (valor e número de vezes) e principais categorias com a participação no período.
6. **Gastos por categoria ou grupo:** seletor de mês, anel com segmentos coloridos, alternância Categorias e Grupos e lista expansível.
7. **Assinaturas (compromisso mensal):** total, botão de adicionar manualmente e lista com logotipo, valor, data e situação (paga), com a instituição pagadora.
8. **Parcelas:** valor comprometido no mês e total restante, gráfico de barras pelos próximos meses, filtro por cartão e, por compra, a parcela atual de quantas ("4 de 12"), barra de progresso, valor pago e restante e o mês da última parcela.

## Mapa para os widgets do design

| Tela do Pierre | Widget do design | Dados necessários | Observação |
|---|---|---|---|
| Saldo em contas | Saldo consolidado por banco | saldo das contas | |
| Faturas e Limites | Fatura e limite por grupo de limite | faturas, limites de cartão | Contar o limite compartilhado uma vez. |
| Fluxo de caixa | Fluxo de caixa | transações de contas correntes | Regra de caixa: compra no cartão só entra no pagamento da fatura. |
| Gastos | Gastos por categoria | transações, categorias | Regra de competência: compra no cartão entra na data da compra. Os dois critérios convivem. |
| Parcelas | Parcelas a vencer | parcelas das transações de cartão | Número da parcela e total vêm das duas fontes. |
| Assinaturas | Recorrências | transações recorrentes | Precisa de detecção de recorrência (planejada, ainda não projetada). |
| Alerta de agente | Alertas | limites por categoria | Depende de limites definidos pelo usuário (nosso, não do Pierre). |
| Pergunte ao Pierre | Analista (chat) | modelo canônico completo | Parte da etapa de IA. |

## Ideias que o design atual ainda não cobre

- Alternar a leitura entre critério de caixa e de competência no mesmo conjunto de dados.
- Agrupar categorias em grupos de nível mais alto (por exemplo, várias categorias de saúde em um grupo).
- Mostrar a data da última atualização de cada instituição junto do seletor de instituições, que é a nossa forma de deixar a idade do dado visível.
- Ocultação de valores com um toque, como padrão ao abrir o app em local público.
