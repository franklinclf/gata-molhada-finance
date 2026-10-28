# Escolha dos modelos de IA (OpenRouter)

Data: 2026-10-28. Medido com `npm run eval:categorize` e `npm run eval:analyst` (código em `eval/ai/`). Preços da lista pública da OpenRouter no mesmo dia, em dólares por milhão de tokens (entrada / saída). As chamadas pedem `data_collection: deny`, então só provedores que não guardam nem treinam com os dados respondem. Gasto total dos testes: cerca de US$ 0,49.

## Categorizador

Teste: 175 textos inventados no formato que os bancos entregam (124 comuns e 51 difíceis: gateways de pagamento, nomes opacos, valor que muda o sentido), 29 categorias, lotes de 25, saída em JSON com a lista de categorias como enum. O custo por 1.633 transações é a projeção para todo o seu histórico, sem contar o cache por descrição.

| Modelo | Preço | Comuns | Difíceis | Custo por 1.633 | Latência por lote |
|---|---|---|---|---|---|
| anthropic/claude-haiku-5.5 | 0,10 / 0,50 | 100% | 98,0% | US$ 0,032 | 3,0 s |
| openai/gpt-6-luna | 0,10 / 0,50 | 100% | 96,1% | US$ 0,017 | 4,9 s |
| google/gemini-3.1-flash-lite | 0,25 / 1,50 | 99,2% | 96,1% | US$ 0,063 | 2,6 s |
| meta-llama/llama-3.3-70b-instruct | 0,10 / 0,32 | 97,6% | 94,1% | US$ 0,025 | 11,5 s |
| google/gemini-2.5-flash-lite | 0,10 / 0,40 | 96,8% | 96,1% | US$ 0,038 | 8,2 s |
| deepseek/deepseek-v4-flash | 0,09 / 0,18 | 97,6% | 90,2% | US$ 0,030 | 45,7 s |
| openai/gpt-5-nano | 0,05 / 0,40 | 95,2% | 92,2% | US$ 0,036 | 11,7 s |
| mistralai/mistral-small-2603 | 0,15 / 0,60 | 95,2% | 86,3% | US$ 0,077 | 13,5 s |
| openai/gpt-5.4-nano | 0,20 / 1,25 | 91,1% | 86,3% | US$ 0,040 | 3,0 s |
| openai/gpt-oss-20b | 0,018 / 0,09 | 59,7% | 88,2% | US$ 0,006 | 5,7 s (46 respostas fora da lista) |
| mistralai/mistral-small-3.2-24b-instruct | 0,075 / 0,20 | 19,4% | 47,1% | US$ 0,004 | expirou (504) |

Escolha: **claude-haiku-5.5** como principal e **gpt-6-luna** como reserva (metade do custo, dois pontos a menos nos casos difíceis). O custo é irrelevante nessa faixa (centavos para categorizar tudo), então a precisão decide. Fora: gpt-oss-20b (responde fora da lista), mistral-small-3.2 (expira) e gpt-5.4-nano (mais fraco que os de preço igual).

## Analista

Teste: um resumo financeiro inventado (saldos, faturas, gastos por categoria em dois meses, assinaturas, parcelas) e 16 perguntas com resposta calculável: somas, diferenças, porcentagens, simulações com mais de um passo e 3 perguntas sem resposta nos dados (a resposta certa é dizer que não há o dado). Pontuação automática por conferência dos números e das frases.

| Modelo | Preço | Acertos | Armadilhas | Custo por pergunta | Latência |
|---|---|---|---|---|---|
| anthropic/claude-haiku-5.5 | 0,10 / 0,50 | 16/16 | 3/3 | US$ 0,0003 | 3,1 s |
| openai/gpt-5.6-luna | 0,20 / 1,20 | 16/16 | 3/3 | US$ 0,0003 | 2,4 s |
| deepseek/deepseek-v4-pro | 0,96 / 1,91 | 16/16 | 3/3 | US$ 0,0015 | 6,1 s |
| openai/gpt-6-sol | 2 / 10 | 16/16 | 3/3 | US$ 0,0027 | 2,7 s |
| anthropic/claude-sonnet-5.5 | 2 / 10 | 16/16 | 3/3 | US$ 0,0046 | 2,3 s |
| google/gemini-3.1-pro-preview | 2 / 12 | 16/16 | 3/3 | US$ 0,0074 | 6,1 s |

Todos acertaram tudo, então o teste não separa os modelos: com um resumo pequeno e limpo, até o mais barato faz as contas e admite quando falta o dado. A escolha vem do custo e de um escalonamento: **claude-haiku-5.5** para perguntas do dia a dia e **claude-sonnet-5.5** quando a pergunta for aberta (por exemplo, "o que mudou nos meus gastos?") ou o contexto for grande. A decisão se confirma com perguntas reais sobre os seus dados, que são mais bagunçadas que o resumo do teste.

## O que o teste não cobre

- O resumo é pequeno e perfeito. Dados reais têm lacunas (como as compras que faltam no cartão Amazon) e o modelo precisa avisar disso.
- Só o categorizador recebe descrições reais, e só depois da sua autorização. Os cálculos continuam no código, e o modelo explica e interpreta.
