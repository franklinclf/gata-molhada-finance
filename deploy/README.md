# Operação da implantação

A VM executa `deploy/deploy.sh` quando o app avisa que há imagem nova (webhook do GitHub, abaixo) e, como rede de segurança, a cada 30 minutos (timer `gmf-deploy.timer`). Cada execução atualiza os arquivos de implantação, baixa `ghcr.io/franklinclf/gata-molhada-finance:latest` e troca o contêiner se a imagem ou os segredos mudaram. Os segredos só são lidos do Key Vault quando a imagem muda, quando a cópia salva tem mais de 30 minutos (`GMF_SECRETS_TTL_MIN`) ou com `--refresh-secrets`; uma execução sem novidade faz um `git pull` e uma consulta ao registro, e nenhuma chamada ao Key Vault. Se a versão nova não ficar saudável em 60 segundos, volta à anterior e ignora essa imagem até outra ser publicada.

## Implantação por webhook (sem consultar a cada 2 minutos)

1. O CI publica a imagem no último job. Ao terminar com sucesso na `main`, o GitHub envia `POST https://<seu-host>/api/hooks/deploy` com a assinatura HMAC-SHA256 do corpo (`X-Hub-Signature-256`).
2. O app confere a assinatura com `DEPLOY_WEBHOOK_SECRET`. Só uma execução do workflow `CI` com sucesso, na `main`, disparada por push, conta; qualquer outra entrega é respondida e ignorada. Sem o segredo configurado a rota não existe (404). Entregas em rajada tocam o arquivo no máximo uma vez a cada 10 segundos.
3. O app escreve `/var/lib/gmf/.deploy-requested` (o volume `/data` do contêiner). A unidade `gmf-deploy.path` vigia esse arquivo e inicia `gmf-deploy.service`. Resultado: a versão nova entra em segundos, sem consulta nenhuma enquanto nada é publicado.
4. Se o app estiver fora do ar quando o aviso chega, ou se uma entrega se perder, o timer de 30 minutos faz a implantação mesmo assim.

Para ligar (uma vez):

- Gere o segredo e grave no cofre: `openssl rand -hex 32 | GMF_KEYVAULT=<cofre> bash infra/azure/set-secret.sh DEPLOY-WEBHOOK-SECRET`.
- Crie o webhook no repositório (Settings > Webhooks): URL `https://<seu-host>/api/hooks/deploy`, tipo de conteúdo `application/json`, o mesmo segredo, evento só "Workflow runs".
- Na VM, instale a unidade nova e o timer lento: `... --scripts "bash /opt/gmf/deploy/install.sh && systemctl start gmf-deploy.service --no-block"` (a troca do segredo é lida na hora porque a execução seguinte usa `--refresh-secrets` abaixo).
- Ao gravar o segredo por pipe, termine o valor com quebra de linha (`printf '%s\n' "$SECRET" | ... set-secret.sh ...`): sem ela o `read` do script falha e, com `set -e`, ele sai sem gravar e sem mensagem. Confira com `az keyvault secret show --vault-name <cofre> --name DEPLOY-WEBHOOK-SECRET --query attributes.created -o tsv`.
- Se o `gh` responder "Bad credentials", há um `GITHUB_TOKEN` inválido no ambiente do terminal: rode `unset GITHUB_TOKEN`.
- O GitHub envia um `ping` ao criar o webhook; se ele chegar antes de a VM ter o segredo, a primeira entrega aparece com erro (401 ou 404). Depois de `deploy.sh --refresh-secrets`, reenvie o ping: a resposta deve ser 202.
- Para testar: em Settings > Webhooks > Recent Deliveries, reenvie uma entrega; a resposta deve ser 202 com `"decision":"deploy"` para uma execução do CI na `main`.

## Aviso do Meu Pluggy (webhook)

O Meu Pluggy sincroniza cada banco sozinho uma vez por dia. Com um webhook, ele avisa o app quando termina e o app lê os dados na hora; sem o webhook, o app confere a cada 2 minutos. O dashboard da Pluggy (Applications > editar > Webhooks) só pede a URL e o evento, não deixa definir cabeçalhos, então o segredo vai no último trecho da URL.

- Gere o segredo e grave no cofre: `printf '%s\n' "$(openssl rand -hex 32)" | GMF_KEYVAULT=<cofre> bash infra/azure/set-secret.sh PLUGGY-WEBHOOK-SECRET`. Leia-o de volta para montar a URL: `az keyvault secret show --vault-name <cofre> --name PLUGGY-WEBHOOK-SECRET --query value -o tsv`.
- Leia o segredo na VM: `bash infra/azure/deploy-now.sh --refresh-secrets`. Os logs mostram `observer on: pluggy every 30 min (Pluggy webhook on)`.
- No dashboard da Pluggy, crie o webhook com URL `https://<seu-host>/api/hooks/pluggy/<segredo>` e evento `all`.
- Token errado ou ausente responde 404, igual a uma rota que não existe. Eventos válidos respondem 202, inclusive os que o app não usa (a Pluggy não repete depois de 400, 401, 403, 404 ou 405).
- Para testar: Applications > Events no dashboard da Pluggy mostra cada entrega e permite reenviar. No log do app aparece `pluggy webhook: item/updated for <banco>`.
- O segredo aparece na tela de eventos do dashboard da Pluggy (só admins do time) e fica fora dos logs do app e do Caddy, que não registram acessos. Se vazar, grave outro segredo, leia de novo e edite a URL do webhook.

## Comandos úteis (sem SSH)

Troque `rg-gmf` e `vm-gmf` se usou outros nomes.

- Registro da implantação: `az vm run-command invoke -g rg-gmf -n vm-gmf --command-id RunShellScript --scripts "journalctl -u gmf-deploy --no-pager -n 50" --query "value[0].message" -o tsv`
- Estado dos contêineres: `... --scripts "docker ps --format '{{.Names}} {{.Status}}'"`
- Registro do app: `... --scripts "docker logs --tail 100 gmf-app"`
- Forçar uma implantação agora, do terminal: `bash infra/azure/deploy-now.sh` (com `--refresh-secrets` para ler os segredos de novo). Pelo app: Ajustes > Dados > Versão > "Procurar versão nova agora". Sem essas duas, o comando cru: `... --scripts "systemctl start gmf-deploy.service"`. Para ler os segredos de novo na hora (depois de trocar um valor): `... --scripts "/opt/gmf/deploy/deploy.sh --refresh-secrets"`.
- Backups do banco antes de cada implantação: `/var/lib/gmf/backups/pre-deploy-*.sqlite` (os 5 mais recentes).

## Segredos

Cada nome em `deploy/secrets.list` precisa existir no Key Vault. Hífens viram sublinhados no ambiente (`PLUGGY-CLIENT-ID` vira `PLUGGY_CLIENT_ID`). Para gravar ou trocar um valor, no seu terminal: `GMF_KEYVAULT=<cofre> bash infra/azure/set-secret.sh NOME`. A troca é aplicada na próxima leitura dos segredos (até 30 minutos, ou na hora com `deploy.sh --refresh-secrets`), recriando o contêiner. Um nome terminado em `?` na lista é opcional: se o cofre não o tiver, é ignorado. Só valores de uma linha são aceitos.

## Limitação conhecida

A reversão restaura a imagem anterior, mas o contêiner volta a subir com os segredos atuais do cofre, não com os anteriores. Uma falha causada por um valor de segredo ruim exige corrigir o segredo.

## Voltar a uma versão específica

Publique de novo o commit desejado (um revert na `main`) e deixe o CI gerar a imagem. A VM adota a nova imagem sozinha.

## Remover tudo

`GMF_KEYVAULT=<cofre> bash infra/azure/99-teardown.sh` pede a digitação do nome do grupo de recursos e apaga VM, disco, IP, rede e cofre. O nome do cofre fica reservado por 7 dias, a menos que se rode `az keyvault purge`.

Para enviar de uma vez os segredos do seu `.env` local ao cofre: `GMF_KEYVAULT=<cofre> bash infra/azure/push-env.sh` (use `--dry-run` para ver só os nomes). Os valores são gravados entre aspas simples no ambiente do contêiner, porque os hashes de senha contêm `$`. Valores com aspas simples são recusados.
