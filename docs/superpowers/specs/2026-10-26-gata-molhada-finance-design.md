# Gata Molhada Finance: design

Data: 2026-10-26. Estado: aguardando revisão. Este documento junta as decisões de design das cinco partes discutidas (arquitetura, agendador, armazenamento, interface e IA, operação). Ainda não há código da aplicação.

## 1. Contexto e objetivo

O usuário consolida contas e cartões de vários bancos por Open Finance. Hoje usa o Pierre Finance, cuja camada de dados apresenta atrasos, lançamentos faltando e divergências entre telas do próprio app. A interface do Pierre agrada, mas os números não são confiáveis o bastante para análise.

O objetivo é uma aplicação própria que consolide as contas, mostre visões configuráveis (widgets), aplique agentes de IA sobre os dados e deixe explícito o quanto cada número está atualizado e se as fontes concordam entre si.

A aplicação usa duas fontes de dados, o Pierre (fonte principal para dados recentes) e o Meu Pluggy (contingência e revalidação cruzada). Uma terceira fonte, `manual`, guarda lançamentos e contas que o usuário cria. Nenhuma fonte pode ser requisito para a aplicação funcionar: retirar uma delas desativa o adapter e mantém os dados já gravados.

## 2. O que a auditoria mostrou

A auditoria comparou 90 dias de dados das duas fontes com scripts somente de leitura.

- O formato "raw" do Pierre é derivado do Pluggy. Traz a descrição original, os dados de pagamento e o id do provedor, mas com categoria, descrição e datas tratadas por ele.
- A mesma chamada ao Pierre, repetida, devolveu resultados idênticos.
- 445 de 461 transações do Pierre na janela têm par no Pluggy (96,5%). Os resíduos são pagamentos de fatura, lançamentos pendentes que nunca foram confirmados no Pluggy e alguns Pix.
- Cartões consolidados por mais de um banco aparecem duplicados no Pluggy, sob itens diferentes, com os mesmos lançamentos e ids diferentes. O Pierre mantém uma cópia só. Cartões com limite compartilhado reportam o mesmo limite, disponível e saldo em cada cartão, de modo que somar os cartões conta o limite e o saldo em dobro.
- O filtro de data do `get-transactions` do Pierre se aplica à data de vencimento da parcela, e não à data da compra. O Pluggy data a parcela na data da cobrança.
- Diferenças de saldo entre as fontes se explicaram por atraso de sincronização, e não por erro de dado.
- O `manual-update` do Pierre atualizou 5 bancos em 32 a 63 segundos e trouxe lançamentos novos. O `PATCH /items/{id}` do Pluggy é recusado para itens do Meu Pluggy, e a atualização manual do Meu Pluggy não tem API pública. O saldo em tempo real do Pluggy não funciona nesses itens.
- A Open Finance limita as leituras por mês, por CPF, instituição e produto (cerca de 8 leituras de transações por dia por banco, e uma leitura de faturas por dia). Os dois itens de cada banco (Pierre e Meu Pluggy) consomem a mesma cota.

Não medidos: parcelas contra transações, consistência de categorias, limites de gasto do Pierre, a cadência de atualização automática do Pierre e o consumo real de cota.

## 3. Não objetivos

- Iniciar pagamentos ou escrever nos bancos. A aplicação só lê.
- Multiusuário.
- Aplicativos nativos e widgets de tela inicial do iOS (o painel é web, instalável como PWA).
- Dados em tempo real. O limite é de poucas atualizações por dia por banco, com detecção em minutos.

## 4. Arquitetura

Uma aplicação TypeScript com os módulos `core` (modelo canônico e reconciliação), `adapters/*`, `store`, `scheduler`, `api`, `web` e `agents`. Os adapters importam as interfaces do `core`, e o `core` não conhece nenhum adapter. Os adapters são registrados num único arquivo.

Contrato de um adapter:

```ts
interface SourceAdapter {
  id: string
  capabilities: { refreshOnDemand: boolean; pendingTransactions: boolean; creditLimits: boolean; rawDescription: boolean; installments: boolean }
  fetchAccounts(): Promise<{ accounts: Account[]; freshness: Freshness[] }>
  fetchTransactions(since: Date): Promise<Transaction[]>
  fetchBills(): Promise<Bill[]>
  requestRefresh?(): Promise<RefreshHandle>
}
```

Cada adapter grava a resposta original em `raw_snapshots` antes de normalizar e devolve registros no modelo canônico.

Modelo canônico: instituição, conta (corrente, poupança, cartão), grupo de limite, transação, fatura, parcela e frescor. A transação tem id próprio, calculado sobre data, valor, descrição e posição entre iguais, porque o Pluggy apaga e recria lançamentos de cartão com ids novos em torno do fechamento da fatura. Contas de itens diferentes com o mesmo final de cartão viram uma só conta. Cartões do mesmo banco com o mesmo limite, disponível e saldo formam um grupo de limite, que conta uma vez.

### Reconciliação

O cruzamento entre fontes tem três passadas: instante, valor e descrição iguais; mesmo dia, valor e descrição; mesmo valor com até 36 horas de diferença e descrição diferente. Cada transação recebe um estado: confirmada (as fontes concordam), de fonte única ou em conflito (valor, data ou status). Uma transação de fonte única só é divergência real se a outra fonte já tinha atualizado aquele banco depois do horário dela. Do contrário é "ainda não sincronizada". Lançamentos pendentes sem par depois de alguns dias são marcados como "pendente parado" e saem dos totais. A reconciliação é uma função determinística dos registros de origem, e pode ser reexecutada sem duplicar achados.

### Qual fonte vale

Para cada banco, a leitura usa a fonte com `lastUpdatedAt` mais recente, em geral o Pierre. Se o Pierre ficar mais de 1 hora atrás do Pluggy em um banco, esse banco é lido do Pluggy até o Pierre alcançar. O Pluggy também fornece a descrição original do banco. A interface mostra a fonte em uso e a idade do dado.

## 5. Agendador, orçamento e frescor

- Observador: consulta as contas do Pierre a cada 5 minutos e os itens do Pluggy a cada 1 a 2 minutos. Não gasta cota de banco. Uma mudança de `lastUpdatedAt` dispara a ingestão incremental daquele banco e fonte.
- Reconciliação completa: uma vez por dia, sobre 90 dias.
- Atualização manual: chama o `manual-update` do Pierre, com uma chamada por vez, intervalo mínimo de 15 minutos e checagem do orçamento. O `manual-update` atualiza todos os bancos, sem filtro. Um banco que não responde em 3 minutos fica "sem resposta" com os dados antigos, e não há tentativa automática.
- Atualização agendada do Pierre: desligada até a cadência medida mostrar que é necessária.
- Orçamento: a aplicação conta, por banco e mês, as mudanças de `lastUpdatedAt` vistas nas duas fontes. Avisa ao passar de 70% de 240 e bloqueia o botão acima de 90%, com opção de forçar. Um aviso 423 do Pluggy marca o banco como "cota esgotada" até o dia 1º.
- Saúde das fontes: alertas para chave inválida ou assinatura cancelada no Pierre, itens do Pluggy em erro e aviso 30 dias antes do fim da autorização do Meu Pluggy.
- Frescor: cada conta mostra a idade do dado em cada fonte. Verde até 6 horas, amarelo até 24 horas e vermelho acima disso (configurável). Os totais exibem o horário do dado mais antigo que entra na conta.
- Execução com trava no banco, para que só um processo ingira por vez.

## 6. Armazenamento

SQLite em arquivo, atrás de uma interface `Store`, com migrações em arquivos SQL numerados e uma tabela de versão. Valores monetários em centavos inteiros. Datas em UTC, mais a data local de `America/Sao_Paulo`. Nenhuma transação é apagada de verdade: `deleted_at` marca as que as fontes deixam de listar.

- Fontes e coleta: `sources`, `raw_snapshots`, `freshness`, `refresh_log`, `quota_events`.
- Modelo canônico: `institutions`, `accounts`, `limit_groups`, `account_source_refs`, `account_snapshots` (série temporal de saldo, limite, disponível, vencimento e mínimo), `transactions`, `transaction_source_records`, `bills`, `reconciliation_findings`.
- Do usuário: `category_overrides` e a fonte `manual` para contas e lançamentos próprios.

Retenção: corpo completo dos snapshots por 30 dias, depois um por dia e endpoint por 12 meses, e o hash para sempre. Transações, saldos e achados sem prazo. Backup diário do arquivo do banco, guardando os últimos 14, em local externo à VM.

## 7. Interface e widgets

Aplicação web responsiva, instalável como PWA, servida pelo backend. Um widget é uma consulta tipada sobre o modelo canônico mais um desenho, com parâmetros (período, contas, categorias), e devolve dados junto com a idade do dado mais antigo usado. O painel é um JSON no banco, e pode haver vários painéis salvos. Widgets iniciais: saldo consolidado por banco, fatura atual por cartão e limite por grupo, gastos por categoria, fluxo de caixa, parcelas a vencer, transações recentes, frescor das fontes e divergências abertas. Os valores são calculados em código, nunca por um modelo de IA. A organização visual segue as telas do Pierre de que o usuário gosta, a partir de capturas fornecidas por ele, antes da construção da interface.

## 8. Agentes de IA

- Categorizador: roda em lote nas transações sem categoria ou com pouca confiança e grava categoria, confiança e motivo com a origem `ai`. Uma correção do usuário sempre vence e serve de exemplo.
- Analista (chat): responde com ferramentas somente de leitura sobre o banco (transações, saldos, grupos de limite, parcelas, frescor, divergências) e cita período e idade do dado. Avisa quando uma conta está desatualizada ou divergente.

O provedor de modelos fica atrás de uma interface. O padrão é o OpenRouter em todos os ambientes, porque o servidor roda na nuvem. Um provedor direto pode ser acrescentado por configuração. Os agentes recebem só os campos necessários. Documentos pessoais, números de conta e finais de cartão não são enviados, a menos que a pergunta exija. A política de dados do OpenRouter ainda precisa ser conferida antes de enviar dados reais.

## 9. Hospedagem e implantação

Uma VM Linux x86 no Azure for Students (crédito de US$ 100 por 12 meses, e 750 horas mensais gratuitas de uma VM B1s ou B2ats v2 pelo mesmo período), com o app em contêiner Docker, Caddy na frente para HTTPS automático e SQLite no disco. Um domínio do pacote de estudante (gratuito por 1 ano, conforme a oferta) serve o HTTPS. O acesso por SSH usa só chave e é restrito, e as portas abertas são 443 e o SSH restrito. O banco é copiado todas as noites para fora da VM.

Segredos: ficam no Azure Key Vault. A VM tem uma identidade gerenciada com permissão só de leitura no cofre, e o script de inicialização lê os segredos e os entrega ao contêiner como variáveis de ambiente. Assim, trocar uma chave não exige nova implantação, e nenhuma credencial do Azure existe fora da VM. Na primeira iteração, um arquivo `.env` na VM com permissão 600 é aceitável como atalho, desde que a migração para o cofre esteja no plano.

Os clientes (Mac, Windows e Android) usam a mesma interface web. Um único servidor chama o Pierre e o Pluggy, então os limites de atualização e os dados são compartilhados por construção.

## 10. CI/CD e repositório público

O repositório é público, em github.com, na conta pessoal do usuário. Consequências:

- Nenhum dado real no repositório: o `.gitignore` cobre `.env` e `data/`, há um `.env.example` só com nomes, os dados de teste são sintéticos ou anonimizados, e este documento não traz saldos, limites, ids nem dados pessoais.
- Antes do primeiro envio, revisar os scripts de auditoria e remover o que seja específico do usuário (ids de itens, rótulos). Rodar uma varredura de segredos. O histórico do git começa limpo.
- A varredura de segredos do GitHub e a proteção de envio ficam ligadas. A `main` tem proteção de branch, e workflows de colaboradores novos exigem aprovação.
- As chaves do Pierre, do Pluggy e do OpenRouter ficam no Azure Key Vault, lidas pela VM com a identidade gerenciada dela. O GitHub não guarda segredos de produção nem credenciais do Azure, porque a implantação é feita pela VM, que busca a imagem. Os secrets do GitHub só entram se o CI passar a precisar de algum, o que hoje não acontece.

Fluxo: tronco único (`main`). O pull request roda o CI (instalação com cache, checagem de tipos, lint, testes, varredura de segredos e build da imagem), cancelando execuções antigas do mesmo branch. O merge em `main` publica a imagem no GitHub Container Registry. A VM busca a imagem nova por conta própria, com um timer, sem acesso de entrada: faz cópia do banco, aplica as migrações, sobe o contêiner novo, confere `/healthz` e volta à versão anterior se falhar. A imagem não leva `.env` nem `data/` (há um `.dockerignore`). Um workflow manual reimplanta uma versão anterior pela etiqueta.

O app é público na internet com código aberto, então a autenticação precisa se sustentar sozinha: um único usuário, com passkey ou senha mais TOTP, limite de tentativas e sem credenciais padrão.

## 11. Erros e testes

Erros:

- Leituras têm tempo limite e até 3 tentativas com espera crescente. O `manual-update` nunca é repetido sozinho.
- Erros de autenticação marcam a fonte como fora do ar e avisam o usuário. Aviso 423 marca o banco como cota esgotada. Falha temporária mantém o último dado e mostra a idade.
- A ingestão grava por fonte e banco numa transação. A marca de leitura só avança depois de gravar, o snapshot é salvo antes da normalização e um índice único por fonte e id externo impede duplicar.
- Como os schemas do OpenAPI do Pierre vêm vazios, a validação segue o formato observado. Campo novo ou ausente gera um achado "formato mudou".
- A IA nunca bloqueia a leitura dos dados. Resposta inválida não grava nada, e valores monetários nunca vêm do modelo.

Testes:

- Executor embutido do Node (`node:test`).
- Unitários: três passadas do cruzamento, chave de identidade, deduplicação de cartões e grupos de limite, contador de cota e regra de fonte por banco.
- Contrato dos adapters com respostas anonimizadas.
- Regressão: a taxa de pares da auditoria como métrica fixa nos dados de teste.
- API com SQLite em memória.
- Um comando local de leitura contra as APIs reais, rodado pelo usuário antes de uma versão. O CI nunca recebe chaves reais.
- Teste de fumaça da interface com Playwright, em etapa posterior.

## 12. Ordem de construção

1. Esqueleto: repositório, TypeScript, tipos do `core`, `Store`, migrações, CI mínimo e um `/healthz` implantado na VM para validar o pipeline cedo.
2. Adapters do Pluggy e do Pierre, snapshots e importação do histórico do Pierre.
3. Reconciliação, frescor, grupos de limite e um relatório de linha de comando que reproduz os números da auditoria.
4. Observador, atualização pelo Pierre e orçamento de cota.
5. API, autenticação e painel com os primeiros widgets.
6. Mais widgets e painéis personalizáveis.
7. IA: categorizador e depois o analista.
8. Fonte manual e backups automáticos.

## 13. Dependências e ferramentas a aprovar

Nenhuma foi instalada. Cada uma exige aprovação do usuário: TypeScript (checagem de tipos), um linter, uma biblioteca de validação de formatos, React com Vite, Playwright, Docker (`Dockerfile`, `.dockerignore`, `compose`), os workflows do GitHub Actions, o Dependabot e uma ferramenta de varredura de segredos. O Node instalado (22.22.3) traz SQLite embutido (`node:sqlite`, marcado como experimental) e deve executar TypeScript sem compilar; ambos serão confirmados ao configurar o projeto.

## 14. Itens em aberto

- Licença do repositório público.
- Nome da pasta do projeto (hoje `pierre-finance-app`) e do repositório.
- Idioma da documentação e dos comentários do repositório público.
- Preços do Azure após os 12 meses e regiões permitidas pela assinatura de estudante.
- Custo do Key Vault e se a assinatura de estudante permite atribuir à VM a permissão de leitura no cofre.
- Quais ofertas do pacote de estudante estão ativas na conta.
- Cadência de atualização automática do Pierre, a medir com o observador de 24 a 48 horas.
- Catálogo e política de dados do OpenRouter para os modelos escolhidos.
- Se a oferta de estudante exige renovação anual para manter o crédito e os serviços gratuitos.
