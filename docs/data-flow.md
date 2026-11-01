# Fluxo de dados de ponta a ponta

Este documento mostra o caminho de um dado, da leitura no banco até a tela, e onde cada decisão é tomada. Os nomes de arquivo são os do repositório. Cada decisão automática tem uma regra de precedência e uma forma de o dono corrigir.

## 1. Visão geral

```mermaid
flowchart TD
  subgraph SRC["1. Extração"]
    BANK["Bancos (Open Finance)"] --> MP["Meu Pluggy"]
    MP -->|"GET /items, /accounts, /v2/transactions, /bills"| AD["PluggyAdapter<br/>src/adapters/pluggy"]
    MP -. "webhook item/* e transactions/*" .-> HOOK["POST /api/hooks/pluggy/token<br/>src/http/pluggy-hook.ts"]
    HOOK --> OBS["Observer<br/>src/scheduler/observer.ts"]
    POLL["Conferência a cada 30 min<br/>(2 min sem webhook)"] --> OBS
    CLI["npm run sync --since"] --> AD
    OBS -->|"hora de leitura mudou"| AD
    MANUAL["Transações digitadas<br/>src/api/manual.ts"]
  end

  subgraph STORE["2. Armazenamento (SQLite)"]
    AD -->|"respostas brutas"| RAW[("raw_snapshots")]
    AD -->|"normaliza: sinal, moeda, partes, parcela"| ST[("source_transactions<br/>source_accounts<br/>source_bills<br/>freshness")]
  end

  subgraph REC["3. Reconciliação (runReconciliation)"]
    ST --> TRIM["Corta antes de DEFAULT_DATA_START<br/>2026-01-01"]
    TRIM --> ACC["Contas canônicas<br/>reconcile/accounts.ts"]
    ACC --> TX["Transações canônicas<br/>reconcile/transactions.ts<br/>estados: single_source, confirmed,<br/>stale_pending (só conta), billed, ignored"]
    TX --> PROOF["Prova por fatura<br/>reconcile/bill-proof.ts"]
    TX --> FIND["Achados: possível duplicata"]
  end

  subgraph EFF["4. Camada efetiva (effectiveTransactions)"]
    TX --> E1["Escolhas do dono<br/>categoria, parcela, status, fatura"]
    E1 --> E2["Categoria: regra por descrição, regras de condição,<br/>tabela da fonte, Pix para pessoa, MCC, IA"]
    E2 --> E3["Papel: pagamento de fatura,<br/>entre contas suas, investimento"]
    E3 --> E4["Contraparte e documento"]
  end

  subgraph AI["5. IA (OpenRouter)"]
    E2 -.->|"só descrições sem decisão"| CAT["Categorizador"]
    FIND -.-> MAT["Juiz de pares"]
    CAT --> AICAT[("ai_categories")]
    MAT -->|"junta com alta confiança"| TX
    CHAT["Analista (somente leitura)"]
  end

  subgraph VIEWS["6. Visões"]
    E4 --> V1["Gastos, Transações, Fluxo de caixa"]
    E4 --> V2["Cartões: ciclos, Conferir, parcelas, previsão"]
    E4 --> V3["Orçamento, recorrências, calendário"]
    E4 --> V4["Patrimônio, metas, painel"]
  end

  MANUAL --> TX
  V1 & V2 & V3 & V4 --> WEB["Preact SPA / PWA"]
  WEB -->|"corrige"| E1
```

## 2. Reconciliação em detalhe

```mermaid
flowchart LR
  A["source_transactions<br/>por fonte e conta"] --> B{"Conta existe<br/>na fonte?"}
  B -->|sim| C["Agrupa registros<br/>(hoje há 1 fonte: 1 registro = 1 grupo)"]
  C --> D["Junta pares manuais<br/>(manual_links)"]
  D --> E["Id canônico =<br/>hash(conta, dia, valor, texto, ordem)"]
  E --> F{"Estado"}
  F -->|"dono ignorou"| G["ignored"]
  F -->|"pendente, 1 fonte,<br/>conta bancária, mais de 7 dias"| H["stale_pending (fora dos totais)"]
  F -->|"demais"| I["single_source / confirmed"]
  H --> J["Gêmea lançada na mesma conta<br/>(outra fonte) também pode pôr de lado"]
  I --> K["Prova por fatura restaura<br/>o que explica a diferença"]
  H --> K
```

Cartão: uma pendente nunca é posta de lado por idade, porque o Meu Pluggy mantém toda compra da fatura aberta como pendente.

## 3. Quem decide a categoria (da mais forte para a mais fraca)

```mermaid
flowchart TD
  U["Categoria escolhida na transação"] --> R1["Atalho por descrição<br/>(aplicar a todas com o mesmo texto)"]
  R1 --> R2["Regras de condição<br/>(aba Regras, primeira que casa)"]
  R2 --> R3["Tabela da fonte<br/>(árvore de categorias do Meu Pluggy)"]
  R3 --> R4["Pix ou TED para pessoa: Transferências"]
  R4 --> R5["Código MCC do estabelecimento"]
  R5 --> R6["IA, só com confiança alta<br/>(média e baixa esperam você)"]
  R6 --> R7["Rótulo da fonte, como veio"]
```

O papel (pagamento de fatura, entre contas suas, investimento) vem de fatos da fonte e é independente da categoria mostrada. Só uma escolha sua o muda.

## 4. Ciclos de cartão

```mermaid
flowchart TD
  B["Faturas publicadas<br/>(fechamento e vencimento de cada uma)"] --> W["Janelas de ciclo:<br/>fechamento anterior + 1 dia até o fechamento"]
  W --> G{"Mês sem fatura publicada?"}
  G -->|sim| S["Ciclo fechado sintético<br/>mesmo dia de fechamento, status 'não conferido'"]
  G -->|não| P["Ciclo com total publicado"]
  S --> A["Atribuição de compras"]
  P --> A
  A -->|"escolha do dono (billCycle)"| X["Conta no ciclo escolhido"]
  A -->|"padrão"| Y["Conta pelo dia da compra"]
  X --> CMP["Conferir: total do banco x soma do ciclo"]
  Y --> CMP
  CMP -->|"1 a 3 compras a até 6 dias do fechamento<br/>somam a diferença"| MV["Sugere mover"]
  CMP -->|"nada explica"| MS["Falta (lançar à mão) ou sobra (pendente suspeita)"]
```

## 5. O que o dono pode corrigir, e o que sobrevive a uma nova leitura

| Correção | Onde fica | Sobrevive à releitura |
|---|---|---|
| Categoria de uma transação | `category_overrides` | Sim (por registro da fonte) |
| Atalho por descrição, regras | `category_rules`, `rules` | Sim |
| Parcela, status, fatura | `installment_overrides`, `transaction_overrides` | Sim |
| Ignorar, juntar, separar | `ignored_records`, `manual_links` | Sim |
| Fatura paga ou não | `cycle_overrides` | Sim (por conta canônica) |
| Transação digitada | `manual_transactions` | Sim |

## 6. Custo e limites

- IA: categorizador, juiz de pares e analista passam por `src/ai/spend.ts`. O limite mensal vale para o maior entre o que o app registrou e o total da chave no OpenRouter.
- Open Finance: o Meu Pluggy sincroniza uma vez por dia e não aceita pedido de atualização. O webhook avisa quando termina. Transações de 7 a 365 dias só podem ser relidas 4 vezes por mês por CPF e instituição.

## 7. Janela de leitura

Cada vez que a fonte avisa que há dado novo, o app relê os últimos 45 dias (`SYNC_LOOKBACK_DAYS`, `src/scheduler/defaults.ts`; eram 14). Uma compra de cartão fica pendente até a fatura fechar e pode mudar ao ser lançada, então a janela precisa passar de uma fatura. A leitura é de dados que o Meu Pluggy já tem, e não gasta a cota mensal de leituras dos bancos.

## 8. Limpeza do que o Meu Pluggy deixa de listar

Depois de uma leitura completa (contas e transações sem erro), o app remove da fonte:

- as transações dentro da janela lida (do dia seguinte ao início até agora) que a leitura não trouxe. É o caso de um registro apagado, ou recriado com outro id ao ser lançado (por exemplo a pendente de R$ 2,36 do "Lucro", que ficou ao lado da lançada). Futuras parcelas, com data depois de hoje, ficam de fora da limpeza;
- as contas que a lista de contas não trouxe, com as transações e faturas delas. Uma conexão refeita ganha ids novos e deixava a conta antiga para trás, o que dobrava saldos.

Duas travas: uma leitura vazia não remove nada, e mais da metade da janela (ou das contas) sumindo de uma vez é tratada como leitura ruim e vira um aviso. Duas leituras da mesma fonte não rodam ao mesmo tempo, para uma resposta antiga não sobrescrever uma nova. Uma mudança vista e ainda não lida sobrevive a um reinício do servidor.

## 9. Limitações conhecidas

- O id da conta canônica é um hash de tipo, instituição e nome. Renomear uma conexão em `PLUGGY_ITEMS` muda o id e solta as escolhas guardadas por conta.
- O mesmo conceito aparece escrito em mais de um lugar: a lista de fontes `['pierre','pluggy']`, a data de início 2026-01-01, o fuso -3h e vários cálculos de data.
