# Operação da implantação

A VM executa `deploy/deploy.sh` a cada 2 minutos (timer `gmf-deploy.timer`). Cada execução atualiza os arquivos de implantação, lê os segredos do Key Vault, baixa `ghcr.io/franklinclf/gata-molhada-finance:latest` e troca o contêiner se a imagem ou os segredos mudaram. Se a versão nova não ficar saudável em 60 segundos, volta à anterior e ignora essa imagem até outra ser publicada.

## Comandos úteis (sem SSH)

Troque `rg-gmf` e `vm-gmf` se usou outros nomes.

- Registro da implantação: `az vm run-command invoke -g rg-gmf -n vm-gmf --command-id RunShellScript --scripts "journalctl -u gmf-deploy --no-pager -n 50" --query "value[0].message" -o tsv`
- Estado dos contêineres: `... --scripts "docker ps --format '{{.Names}} {{.Status}}'"`
- Registro do app: `... --scripts "docker logs --tail 100 gmf-app"`
- Forçar uma implantação agora: `... --scripts "systemctl start gmf-deploy.service"`
- Backups do banco antes de cada implantação: `/var/lib/gmf/backups/pre-deploy-*.sqlite` (os 5 mais recentes).

## Segredos

Cada nome em `deploy/secrets.list` precisa existir no Key Vault. Hífens viram sublinhados no ambiente (`PIERRE-API-KEY` vira `PIERRE_API_KEY`). Para gravar ou trocar um valor, no seu terminal: `GMF_KEYVAULT=<cofre> bash infra/azure/set-secret.sh NOME`. A troca é aplicada no próximo ciclo (até 2 minutos), recriando o contêiner. Só valores de uma linha são aceitos.

## Limitação conhecida

A reversão restaura a imagem anterior, mas o contêiner volta a subir com os segredos atuais do cofre, não com os anteriores. Uma falha causada por um valor de segredo ruim exige corrigir o segredo.

## Voltar a uma versão específica

Publique de novo o commit desejado (um revert na `main`) e deixe o CI gerar a imagem. A VM adota a nova imagem sozinha.

## Remover tudo

`GMF_KEYVAULT=<cofre> bash infra/azure/99-teardown.sh` pede a digitação do nome do grupo de recursos e apaga VM, disco, IP, rede e cofre. O nome do cofre fica reservado por 7 dias, a menos que se rode `az keyvault purge`.

Para enviar de uma vez os segredos do seu `.env` local ao cofre: `GMF_KEYVAULT=<cofre> bash infra/azure/push-env.sh` (use `--dry-run` para ver só os nomes). Os valores são gravados entre aspas simples no ambiente do contêiner, porque os hashes de senha contêm `$`. Valores com aspas simples são recusados.
