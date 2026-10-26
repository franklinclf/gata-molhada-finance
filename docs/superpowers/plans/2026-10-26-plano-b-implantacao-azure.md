# Gata Molhada Finance, Plano B: implantação no Azure (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Colocar o `/healthz` da aplicação no ar em HTTPS, numa VM do Azure, com implantação automática por busca da imagem, segredos no Key Vault e reversão automática em caso de falha.

**Architecture:** O CI publica a imagem no GitHub Container Registry. Uma VM Ubuntu no Azure roda a aplicação e o Caddy (HTTPS automático) em Docker Compose. Um timer do systemd executa `deploy/deploy.sh` a cada 2 minutos: atualiza os arquivos de implantação, lê os segredos do Key Vault com a identidade gerenciada da VM, baixa a imagem, troca o contêiner e volta à versão anterior se a nova não ficar saudável. A infraestrutura é criada por scripts da CLI do Azure (`infra/azure/`).

**Tech Stack:** Docker, Docker Compose v2, Caddy 2, Ubuntu 24.04 LTS, systemd, cloud-init, Azure CLI, Azure Key Vault (RBAC), GitHub Actions, GitHub Container Registry. Scripts em bash, compatíveis com bash 3.2 (macOS) e bash 5 (Ubuntu).

## Global Constraints

- Repositório público: nenhum segredo, id de assinatura, endereço IP real nem dado pessoal em arquivos versionados, testes ou documentação. Valores específicos (nome do cofre, rótulo DNS) vêm de variáveis de ambiente, nunca de arquivos do repositório.
- Segredos só no Azure Key Vault. Valores de segredo nunca aparecem em argumentos de comando, logs, no chat nem em arquivos versionados. Quem digita um segredo é o usuário, em terminal próprio, com `infra/azure/set-secret.sh`.
- A VM não expõe nada além de 80 e 443. O SSH fica fechado, salvo se o usuário informar `GMF_ADMIN_IP`. A manutenção padrão usa `az vm run-command`.
- Até o Plano F (autenticação), a aplicação publicada só serve `/healthz`. Nada com dados financeiros pode ser exposto antes disso.
- Todos os recursos do Azure ficam no grupo de recursos `rg-gmf` (nome configurável), para poderem ser removidos juntos.
- Quem executa este plano não faz commit, push, nem apaga recursos do Azure. O usuário decide commits e envios. Os scripts de remoção exigem digitação interativa, então uma execução automática sem terminal aborta.
- Scripts em bash com `set -euo pipefail`, sem recursos exclusivos do bash 4 (arrays associativos, `mapfile`, `${var,,}` fora do CI). No CI (Ubuntu) `${GITHUB_REPOSITORY,,}` é permitido.
- Identificadores e comentários em inglês. Documentação em português.
- Só consultas de leitura e o registro de provedores (`Microsoft.Compute`, `Microsoft.Network`, `Microsoft.KeyVault`, já feito) foram executados contra o Azure. Os comandos `az` de criação foram escritos a partir da documentação da CLI e não foram rodados. Cada comando `az` pode precisar de ajuste ao primeiro uso.

## Aprovações e decisões necessárias (perguntas ao usuário, não passos)

- **B1** (Tarefa 1): posso criar `Dockerfile`, `.dockerignore` e substituir `.github/workflows/ci.yml` pela versão com os jobs `image` e `publish`?
- **B2** (Tarefa 4): o usuário libera no sandbox, pelo Dashboard (aba Domains), os hosts `management.azure.com` e `login.microsoftonline.com`, e depois `<nome-do-cofre>.vault.azure.net`. Cada entrada libera o host e todos os subdomínios, em todas as sessões futuras.
- **B3** (Tarefa 1, passo final): o usuário torna o pacote `gata-molhada-finance` do GitHub Container Registry público, para a VM baixar a imagem sem credenciais (a imagem não contém segredos).
- **B4** (Tarefa 5): posso criar os recursos do Azure abaixo, que consomem o crédito de estudante? Grupo de recursos, IP público estático, grupo de segurança de rede, Key Vault, VM Linux com disco de 30 GB e identidade gerenciada. O consumo estimado não foi verificado.
- **D1** região (padrão `chilecentral`; veja o achado abaixo), **D2** tamanho da VM (padrão `Standard_B2ats_v2`, x86, 2 vCPU e 1 GiB), **D3** rótulo DNS único (o endereço será `<rótulo>.<região>.cloudapp.azure.com`), **D4** nome único do Key Vault (3 a 24 caracteres, letras, dígitos e hífens), **D5** IP do administrador para abrir o SSH (opcional).

Achado de 2026-10-26 (consultas somente de leitura com a CLI): a política da assinatura de estudante só permite as regiões `southafricanorth`, `chilecentral`, `italynorth`, `brazilsouth` e `belgiumcentral`. Nenhum tamanho da série B está disponível em `brazilsouth`, `italynorth` e `belgiumcentral`, e `Standard_B1s` não está disponível em nenhuma região permitida. `Standard_B2ats_v2` (AMD, x86, Gen1 e Gen2, 2 vCPU, 1 GiB, sem disco temporário) está disponível em `chilecentral` e `southafricanorth`, e é coberto pelas 750 horas mensais gratuitas por 12 meses da oferta Azure for Students. Em `brazilsouth` os menores tamanhos disponíveis são os da série F e D v7 (por exemplo `Standard_F1als_v7`, 1 vCPU e 2 GiB), cobrados do crédito de US$ 100, com preço não verificado. Por isso os padrões passaram a `chilecentral` e `Standard_B2ats_v2`. Hospedar os dados fora do Brasil é uma decisão do usuário. Preços de lista consultados na API pública de preços (USD, `chilecentral`): VM `B2ats_v2` Linux US$ 0,0132 por hora (cerca de US$ 9,64 por mês, mas coberta pelas 750 horas gratuitas); IP público Standard estático US$ 0,005 por hora (cerca de US$ 3,65 por mês); disco SSD padrão E4 de 32 GiB US$ 3,36 por mês mais US$ 0,364 de montagem; disco HDD S4 de 32 GiB US$ 2,15 por mês; Key Vault Standard US$ 0,03 por 10 mil operações; tráfego de saída gratuito nos primeiros 100 GB. Por isso o disco do sistema usa HDD (`Standard_LRS`): estimativa de cerca de US$ 6 por mês (IP, disco e cofre) com a VM gratuita, contra cerca de US$ 7,7 com SSD. Os valores são de lista e não consideram franquias gratuitas que a assinatura possa ter para IP e disco. Não verificado: se Key Vault, IP público e as demais peças existem em `chilecentral` (os scripts falham cedo se algo faltar) e se 1 GiB de RAM basta (o cloud-init cria 1 GiB de swap por precaução).

Aviso de ambiente: o sandbox do Claude Code não permite abrir portas de escuta, não alcança o Docker Hub e bloqueia hosts fora da lista liberada. Por isso as imagens são construídas e testadas só no CI, e os testes dos scripts usam dublês de `docker`, `curl`, `git` e `az`.

---

### Task 1: Imagem Docker, smoke test no CI e publicação (depende de B1)

**Files:**
- Create: `Dockerfile`, `.dockerignore`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `src/`, `migrations/` e `package.json` do Plano A; variáveis `PORT`, `DB_PATH`, `APP_VERSION` lidas por `src/config.ts`.
- Produces: imagem `ghcr.io/franklinclf/gata-molhada-finance` com as tags `latest` e `sha-<7 primeiros caracteres do commit>`, publicada a cada push na `main` depois dos jobs `verify` e `image`. Contêiner com usuário `node`, volume `/data`, `HEALTHCHECK` em `/healthz` e variável `APP_VERSION` igual ao commit.

- [ ] **Step 1: Confirmar B1 e criar o `Dockerfile`**

```dockerfile
FROM node:22-slim

ARG GIT_SHA=dev
LABEL org.opencontainers.image.source="https://github.com/franklinclf/gata-molhada-finance"

ENV APP_VERSION=${GIT_SHA} \
    DB_PATH=/data/gmf.sqlite \
    PORT=8080

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY migrations ./migrations

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
```

- [ ] **Step 2: Criar o `.dockerignore`**

```
.git
.github
.idea
node_modules
data
docs
deploy
infra
tests
scripts
.env
.env.*
*.md
```

- [ ] **Step 3: Substituir `.github/workflows/ci.yml`**

O workflow mantém o job `verify` e acrescenta `image` (constrói a imagem e faz um teste de fumaça de `/healthz`) e `publish` (só em push na `main`, depois dos dois anteriores). Ao salvar, confira se `actions/checkout@v4` e `actions/setup-node@v4` ainda são as versões atuais.

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test

  image:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - name: Build image
        run: docker build --build-arg GIT_SHA="${GITHUB_SHA}" -t gmf:ci .
      - name: Smoke test
        run: |
          docker run -d --name gmf -p 8080:8080 gmf:ci
          for i in $(seq 1 30); do
            if curl -fsS http://127.0.0.1:8080/healthz; then
              echo
              exit 0
            fi
            sleep 1
          done
          docker logs gmf
          exit 1

  publish:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    needs: [verify, image]
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - name: Build and push
        env:
          REGISTRY_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          REGISTRY_USER: ${{ github.actor }}
        run: |
          IMAGE="ghcr.io/${GITHUB_REPOSITORY,,}"
          echo "${REGISTRY_TOKEN}" | docker login ghcr.io -u "${REGISTRY_USER}" --password-stdin
          docker build --build-arg GIT_SHA="${GITHUB_SHA}" -t "${IMAGE}:latest" -t "${IMAGE}:sha-${GITHUB_SHA::7}" .
          docker push "${IMAGE}:latest"
          docker push "${IMAGE}:sha-${GITHUB_SHA::7}"
```

- [ ] **Step 4: Validar a sintaxe localmente**

Run: `ruby -ryaml -e 'y=YAML.load_file(".github/workflows/ci.yml"); puts y["jobs"].keys.join(",")'`
Expected: `verify,image,publish`.

O Dockerfile só pode ser construído no CI (o sandbox não alcança o Docker Hub). A validação real é o job `image`.

- [ ] **Step 5: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: `Dockerfile`, `.dockerignore` e `.github/workflows/ci.yml` listados. O usuário decide o commit e abre um pull request para o CI rodar o job `image`.

- [ ] **Step 6: Depois do primeiro merge na `main` (passos do usuário, B3)**

1. Conferir no GitHub, em Actions, que os três jobs terminaram verdes.
2. Em github.com, no perfil, aba Packages, abrir `gata-molhada-finance`, Package settings, e mudar a visibilidade para Public (o nome exato dos menus não foi verificado).
3. Num terminal sem login no ghcr, rodar `docker pull ghcr.io/franklinclf/gata-molhada-finance:latest`. Expected: a imagem é baixada sem pedir credenciais.

---

### Task 2: Arquivos de implantação da VM, com testes

**Files:**
- Create: `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/secrets.list`
- Create: `deploy/fetch-secrets.sh`, `deploy/deploy.sh`, `deploy/install.sh`
- Create: `deploy/systemd/gmf-deploy.service`, `deploy/systemd/gmf-deploy.timer`
- Test: `deploy/tests/fetch-secrets.test.sh`, `deploy/tests/deploy.test.sh`, `deploy/tests/stubs/docker`, `deploy/tests/stubs/git`, `deploy/tests/stubs/sha256sum`, `deploy/tests/stubs/curl`

**Interfaces:**
- Consumes: a imagem da Tarefa 1; `/etc/gmf/vm.env` na VM, com `GMF_HOST` e `GMF_KEYVAULT`.
- Produces: `fetch-secrets.sh` escreve `/run/gmf/app.env` (modo 600) com um `NOME_COM_UNDERSCORES=valor` por segredo listado em `secrets.list`, trocando hífens por sublinhados; `deploy.sh` faz a implantação com reversão e guarda a imagem ruim em `/var/lib/gmf/.failed-image-id`; backups em `/var/lib/gmf/backups/pre-deploy-*.sqlite`. Variáveis de ambiente de teste: `GMF_VM_ENV`, `GMF_APP_DIR`, `GMF_DATA_DIR`, `GMF_ENV_OUT`, `GMF_SECRETS_LIST`, `GMF_HEALTH_TIMEOUT`, `GMF_KEEP_BACKUPS`, `GMF_IMAGE_REPO`.

- [ ] **Step 1: Criar os dublês de teste**

Crie `deploy/tests/stubs/docker`:

```bash
#!/usr/bin/env bash
# Test double for the docker CLI. State lives in $STUB_STATE, one file per fact.
s="$STUB_STATE"
get() { if [[ -f "$s/$1" ]]; then cat "$s/$1"; fi; }

case "$1" in
  pull)
    exit 0 ;;
  image)
    shift 2
    if [[ "${1:-}" == "-f" ]]; then get latest_id; exit 0; fi
    if [[ "${1:-}" == "gmf-rollback:previous" && -f "$s/previous_id" ]]; then exit 0; fi
    exit 1 ;;
  inspect)
    shift
    fmt="$2"
    [[ -f "$s/current_id" ]] || exit 1
    case "$fmt" in
      *Image*) get current_id ;;
      *Health*) get health ;;
      *Labels*) get env_hash ;;
    esac ;;
  exec)
    echo "$*" >> "$s/exec.log"
    exit "${STUB_EXEC_EXIT:-0}" ;;
  tag)
    echo "$2" > "$s/previous_id"
    exit 0 ;;
  logs)
    echo "stub container logs"
    exit 0 ;;
  compose)
    echo "$*" >> "$s/compose.log"
    if [[ "${!#}" == "app" ]]; then
      if [[ "${GMF_IMAGE:-}" == "gmf-rollback:previous" ]]; then
        cp "$s/previous_id" "$s/current_id"
        echo healthy > "$s/health"
      else
        cp "$s/latest_id" "$s/current_id"
        echo "${STUB_NEW_HEALTH:-healthy}" > "$s/health"
      fi
      echo "${GMF_ENV_HASH:-}" > "$s/env_hash"
    fi
    exit 0 ;;
esac
echo "docker stub: unhandled call: $*" >&2
exit 99
```

Crie `deploy/tests/stubs/git`:

```bash
#!/usr/bin/env bash
# Test double for git: the deploy only calls `git -C <dir> pull ...`.
exit 0
```

Crie `deploy/tests/stubs/sha256sum`:

```bash
#!/usr/bin/env bash
# Test double for GNU sha256sum on machines that only have shasum.
exec shasum -a 256 "$@"
```

Crie `deploy/tests/stubs/curl`:

```bash
#!/usr/bin/env bash
# Test double for curl: answers the metadata token call and Key Vault secret reads.
url=""
for arg in "$@"; do
  case "$arg" in http*) url="$arg" ;; esac
done

case "$url" in
  *metadata/identity/oauth2/token*)
    echo '{"access_token":"stub-token"}' ;;
  *.vault.azure.net/secrets/MISSING-SECRET*)
    exit 22 ;;
  *.vault.azure.net/secrets/MULTILINE-SECRET*)
    printf '{"value":"line1\\nline2"}\n' ;;
  *.vault.azure.net/secrets/*)
    name="${url##*/secrets/}"
    name="${name%%\?*}"
    printf '{"value":"value-of-%s"}\n' "$name" ;;
  *)
    echo "curl stub: unhandled url: $url" >&2
    exit 99 ;;
esac
```

- [ ] **Step 2: Escrever os testes que falham**

Crie `deploy/tests/fetch-secrets.test.sh`:

```bash
#!/usr/bin/env bash
# Tests for fetch-secrets.sh using a stubbed curl. Run: bash deploy/tests/fetch-secrets.test.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../fetch-secrets.sh"
failures=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "ok   - $label"
  else
    echo "FAIL - $label"
    echo "       expected: $expected"
    echo "       actual:   $actual"
    failures=$((failures + 1))
  fi
}

new_env() {
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/bin" "$tmp/run"
  cp "$here/stubs/curl" "$tmp/bin/curl"
  chmod +x "$tmp/bin/curl"
  echo "GMF_KEYVAULT=kv-test" > "$tmp/vm.env"
  export PATH="$tmp/bin:$PATH" GMF_VM_ENV="$tmp/vm.env" GMF_ENV_OUT="$tmp/run/app.env" GMF_SECRETS_LIST="$tmp/secrets.list"
}

# 1. Reads secrets, skips comments and blanks, maps dashes to underscores.
new_env
printf '# comment\n\nPIERRE-API-KEY\nGMF-SMOKE-TEST\n' > "$GMF_SECRETS_LIST"
bash "$script"
check "writes mapped variable names and values" \
  $'PIERRE_API_KEY=value-of-PIERRE-API-KEY\nGMF_SMOKE_TEST=value-of-GMF-SMOKE-TEST' "$(cat "$GMF_ENV_OUT")"
check "output file is readable only by the owner" "-rw-------" "$(ls -l "$GMF_ENV_OUT" | cut -c1-10)"

# 2. A missing secret fails and keeps the previous file untouched.
new_env
echo "OLD=1" > "$GMF_ENV_OUT"
printf 'GOOD-SECRET\nMISSING-SECRET\n' > "$GMF_SECRETS_LIST"
if bash "$script" 2> /dev/null; then rc=0; else rc=$?; fi
check "fails when a secret cannot be read" "nonzero" "$([[ $rc -ne 0 ]] && echo nonzero || echo zero)"
check "keeps the previous environment file" "OLD=1" "$(cat "$GMF_ENV_OUT")"
check "leaves no temporary files behind" "app.env" "$(ls "$tmp/run")"

# 3. Rejects invalid names and multi-line values.
new_env
printf 'bad_name\n' > "$GMF_SECRETS_LIST"
if bash "$script" 2> /dev/null; then rc=0; else rc=$?; fi
check "rejects a name with underscores" "nonzero" "$([[ $rc -ne 0 ]] && echo nonzero || echo zero)"

new_env
printf 'MULTILINE-SECRET\n' > "$GMF_SECRETS_LIST"
if bash "$script" 2> /dev/null; then rc=0; else rc=$?; fi
check "rejects a multi-line value" "nonzero" "$([[ $rc -ne 0 ]] && echo nonzero || echo zero)"

if (( failures > 0 )); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
```

Crie `deploy/tests/deploy.test.sh`:

```bash
#!/usr/bin/env bash
# Tests for deploy.sh using stubbed docker, git and sha256sum.
# Run: bash deploy/tests/deploy.test.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
deploy_dir="$here/.."
failures=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "ok   - $label"
  else
    echo "FAIL - $label"
    echo "       expected: $expected"
    echo "       actual:   $actual"
    failures=$((failures + 1))
  fi
}

state() { cat "$STUB_STATE/$1" 2> /dev/null || echo "<none>"; }
app_ups() { grep -c ' up .* app$' "$STUB_STATE/compose.log" 2> /dev/null || true; }

setup() {
  tmp="$(mktemp -d)"
  export STUB_STATE="$tmp/state"
  mkdir -p "$STUB_STATE" "$tmp/bin" "$tmp/app/deploy" "$tmp/data" "$tmp/run"
  cp "$here/stubs/docker" "$here/stubs/git" "$here/stubs/sha256sum" "$tmp/bin/"
  chmod +x "$tmp/bin/"*
  cp "$deploy_dir/deploy.sh" "$tmp/app/deploy/deploy.sh"
  printf '#!/usr/bin/env bash\necho "GMF_SMOKE_TEST=x" > "$GMF_ENV_OUT"\n' > "$tmp/app/deploy/fetch-secrets.sh"
  chmod +x "$tmp/app/deploy/"*.sh
  echo "GMF_HOST=example.test" > "$tmp/vm.env"
  export PATH="$tmp/bin:$PATH" GMF_VM_ENV="$tmp/vm.env" GMF_APP_DIR="$tmp/app" \
    GMF_DATA_DIR="$tmp/data" GMF_ENV_OUT="$tmp/run/app.env" GMF_HEALTH_TIMEOUT=3
  unset STUB_NEW_HEALTH STUB_EXEC_EXIT
}

run_deploy() {
  if bash "$tmp/app/deploy/deploy.sh" > "$tmp/out.log" 2>&1; then rc=0; else rc=$?; fi
}

setup

# 1. First deploy on an empty host.
echo "sha256:aaa" > "$STUB_STATE/latest_id"
run_deploy
check "first deploy succeeds" "0" "$rc"
check "first deploy runs the latest image" "sha256:aaa" "$(state current_id)"
check "first deploy recreates the app once" "1" "$(app_ups)"

# 2. Nothing changed: no new app container.
run_deploy
check "unchanged image is a no-op" "0" "$rc"
check "unchanged image does not recreate the app" "1" "$(app_ups)"

# 3. A healthy update takes a database backup and keeps the previous image.
touch "$tmp/data/gmf.sqlite"
echo "sha256:bbb" > "$STUB_STATE/latest_id"
run_deploy
check "healthy update succeeds" "0" "$rc"
check "healthy update runs the new image" "sha256:bbb" "$(state current_id)"
check "healthy update remembers the previous image" "sha256:aaa" "$(state previous_id)"
check "healthy update backs up the database first" "1" "$(grep -c 'VACUUM INTO' "$STUB_STATE/exec.log")"

# 4. An unhealthy update rolls back and records the bad image.
echo "sha256:ccc" > "$STUB_STATE/latest_id"
export STUB_NEW_HEALTH=unhealthy
run_deploy
check "unhealthy update fails the deploy" "1" "$rc"
check "unhealthy update rolls back to the previous image" "sha256:bbb" "$(state current_id)"
check "unhealthy update marks the image as bad" "sha256:ccc" "$(cat "$tmp/data/.failed-image-id")"

# 5. The known-bad image is not retried.
before="$(app_ups)"
run_deploy
check "known bad image is skipped without error" "0" "$rc"
check "known bad image does not recreate the app" "$before" "$(app_ups)"

# 6. A newer image after a failure is deployed and clears the marker.
echo "sha256:ddd" > "$STUB_STATE/latest_id"
export STUB_NEW_HEALTH=healthy
run_deploy
check "newer image after a failure deploys" "0" "$rc"
check "newer image becomes current" "sha256:ddd" "$(state current_id)"
check "failure marker is cleared" "no" "$([[ -f "$tmp/data/.failed-image-id" ]] && echo yes || echo no)"

# 7. A failed backup of a healthy app aborts the deploy.
echo "sha256:eee" > "$STUB_STATE/latest_id"
export STUB_EXEC_EXIT=1
run_deploy
check "failed backup aborts the deploy" "1" "$rc"
check "failed backup leaves the current image running" "sha256:ddd" "$(state current_id)"

# 8. Old pre-deploy backups are pruned to the configured count.
unset STUB_EXEC_EXIT
mkdir -p "$tmp/data/backups"
for n in 1 2 3 4; do
  touch -t "20260101010${n}" "$tmp/data/backups/pre-deploy-$n.sqlite"
done
export GMF_KEEP_BACKUPS=2
echo "sha256:fff" > "$STUB_STATE/latest_id"
run_deploy
check "update after a failed backup deploys once the backup works" "0" "$rc"
check "keeps only the newest backups" "pre-deploy-3.sqlite pre-deploy-4.sqlite" "$(ls "$tmp/data/backups" | tr '\n' ' ' | sed 's/ $//')"

if (( failures > 0 )); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `chmod +x deploy/tests/*.sh deploy/tests/stubs/* && bash deploy/tests/fetch-secrets.test.sh`
Expected: falha porque `deploy/fetch-secrets.sh` não existe (`No such file or directory`).

- [ ] **Step 4: Criar `fetch-secrets.sh`**

```bash
#!/usr/bin/env bash
# Writes the container environment file from Azure Key Vault, using the VM's
# managed identity. Existing output is replaced only if every secret was read.
set -euo pipefail

VM_ENV="${GMF_VM_ENV:-/etc/gmf/vm.env}"
SECRETS_LIST="${GMF_SECRETS_LIST:-/opt/gmf/deploy/secrets.list}"
OUT="${GMF_ENV_OUT:-/run/gmf/app.env}"

# shellcheck disable=SC1090
source "$VM_ENV"
: "${GMF_KEYVAULT:?GMF_KEYVAULT is not set in $VM_ENV}"

mkdir -p "$(dirname "$OUT")"
umask 077
tmp="$(mktemp "${OUT}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

token="$(curl -fsS -H 'Metadata: true' \
  'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net' \
  | jq -er .access_token)"

while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  if [[ ! "$name" =~ ^[A-Za-z0-9-]+$ ]]; then
    echo "invalid secret name: $name" >&2
    exit 1
  fi
  value="$(curl -fsS -H "Authorization: Bearer $token" \
    "https://${GMF_KEYVAULT}.vault.azure.net/secrets/${name}?api-version=7.4" | jq -er .value)"
  if [[ "$value" == *$'\n'* ]]; then
    echo "secret $name has a newline; only single-line values are supported" >&2
    exit 1
  fi
  printf '%s=%s\n' "${name//-/_}" "$value" >> "$tmp"
done < "$SECRETS_LIST"

chmod 600 "$tmp"
mv "$tmp" "$OUT"
trap - EXIT
```

- [ ] **Step 5: Criar `deploy.sh`**

```bash
#!/usr/bin/env bash
# Pull-based deploy. Fetches secrets, pulls the image, switches the app
# container and rolls back to the previous image if the new one is not healthy.
set -euo pipefail

VM_ENV="${GMF_VM_ENV:-/etc/gmf/vm.env}"
APP_DIR="${GMF_APP_DIR:-/opt/gmf}"
DATA_DIR="${GMF_DATA_DIR:-/var/lib/gmf}"
ENV_OUT="${GMF_ENV_OUT:-/run/gmf/app.env}"
IMAGE_REPO="${GMF_IMAGE_REPO:-ghcr.io/franklinclf/gata-molhada-finance}"
HEALTH_TIMEOUT="${GMF_HEALTH_TIMEOUT:-60}"
KEEP_BACKUPS="${GMF_KEEP_BACKUPS:-5}"
FAILED_MARKER="$DATA_DIR/.failed-image-id"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Update the deploy files first, then restart this script so it runs the new version.
if [[ "${1:-}" != "--no-pull" ]]; then
  git -C "$APP_DIR" pull --ff-only --quiet || log "git pull failed, using the current deploy files"
  exec "$0" --no-pull
fi

# shellcheck disable=SC1090
source "$VM_ENV"
export GMF_HOST

compose() { docker compose --env-file "$VM_ENV" -f "$APP_DIR/deploy/docker-compose.yml" "$@"; }

wait_healthy() {
  local waited=0 status
  while (( waited < HEALTH_TIMEOUT )); do
    status="$(docker inspect -f '{{.State.Health.Status}}' gmf-app 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && return 0
    [[ "$status" == "unhealthy" ]] && return 1
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

"$APP_DIR/deploy/fetch-secrets.sh"
env_hash="$(sha256sum "$ENV_OUT" | cut -d' ' -f1)"

docker pull --quiet "$IMAGE_REPO:latest" > /dev/null
new_id="$(docker image inspect -f '{{.Id}}' "$IMAGE_REPO:latest")"
cur_id="$(docker inspect -f '{{.Image}}' gmf-app 2>/dev/null || true)"
cur_health="$(docker inspect -f '{{.State.Health.Status}}' gmf-app 2>/dev/null || true)"
cur_env_hash="$(docker inspect -f '{{index .Config.Labels "gmf.env-hash"}}' gmf-app 2>/dev/null || true)"

if [[ -f "$FAILED_MARKER" && "$(cat "$FAILED_MARKER")" == "$new_id" ]]; then
  log "image $new_id already failed its health check; waiting for a newer one"
  compose up -d --no-deps caddy > /dev/null
  exit 0
fi

if [[ "$new_id" == "$cur_id" && "$cur_health" == "healthy" && "$env_hash" == "$cur_env_hash" ]]; then
  compose up -d --no-deps caddy > /dev/null
  exit 0
fi

if [[ -n "$cur_id" && -f "$DATA_DIR/gmf.sqlite" ]]; then
  mkdir -p "$DATA_DIR/backups"
  backup="/data/backups/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
  if ! docker exec gmf-app node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/gmf.sqlite');d.exec(\"VACUUM INTO '${backup}'\");d.close()"; then
    if [[ "$cur_health" == "healthy" ]]; then
      log "database backup failed while the current version is healthy; aborting the deploy"
      exit 1
    fi
    log "database backup failed, but the current version is not healthy; continuing"
  fi
fi

if [[ -n "$cur_id" ]]; then
  docker tag "$cur_id" gmf-rollback:previous
fi

log "deploying $new_id"
export GMF_ENV_HASH="$env_hash"
compose up -d --no-deps --force-recreate app

if ! wait_healthy; then
  log "new version failed its health check; rolling back"
  docker logs --tail 50 gmf-app || true
  echo "$new_id" > "$FAILED_MARKER"
  if docker image inspect gmf-rollback:previous > /dev/null 2>&1; then
    GMF_IMAGE=gmf-rollback:previous compose up -d --no-deps --force-recreate app
    log "rolled back to the previous image"
  else
    log "no previous image to roll back to"
  fi
  exit 1
fi

rm -f "$FAILED_MARKER"
compose up -d --no-deps caddy > /dev/null

# shellcheck disable=SC2012
{ ls -1t "$DATA_DIR"/backups/pre-deploy-*.sqlite 2> /dev/null || true; } | tail -n +"$((KEEP_BACKUPS + 1))" | while IFS= read -r old; do
  rm -f -- "$old"
done
log "deployed $new_id"
```

- [ ] **Step 6: Criar a lista de segredos, o Compose, o Caddyfile e a instalação**

Crie `deploy/secrets.list`:

```
# Key Vault secret names read at deploy time, one per line.
# Letters, digits and dashes only. Dashes become underscores in the container
# environment (PIERRE-API-KEY becomes PIERRE_API_KEY).
GMF-SMOKE-TEST
```

Crie `deploy/docker-compose.yml`:

```yaml
name: gmf

services:
  app:
    image: ${GMF_IMAGE:-ghcr.io/franklinclf/gata-molhada-finance:latest}
    container_name: gmf-app
    restart: unless-stopped
    env_file:
      - /run/gmf/app.env
    labels:
      gmf.env-hash: ${GMF_ENV_HASH:-none}
    volumes:
      - /var/lib/gmf:/data
    expose:
      - "8080"

  caddy:
    image: caddy:2
    container_name: gmf-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    environment:
      GMF_HOST: ${GMF_HOST:?GMF_HOST is required}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
```

Crie `deploy/Caddyfile`:

```
{$GMF_HOST} {
	encode zstd gzip
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		-Server
	}
	reverse_proxy app:8080
}
```

Crie `deploy/install.sh`:

```bash
#!/usr/bin/env bash
# One-time setup on the VM: installs the systemd units that run the deploy.
set -euo pipefail

SRC=/opt/gmf/deploy/systemd

chmod 0755 /opt/gmf/deploy/deploy.sh /opt/gmf/deploy/fetch-secrets.sh
install -m 0644 "$SRC/gmf-deploy.service" /etc/systemd/system/gmf-deploy.service
install -m 0644 "$SRC/gmf-deploy.timer" /etc/systemd/system/gmf-deploy.timer
systemctl daemon-reload
systemctl enable --now gmf-deploy.timer
```

Crie `deploy/systemd/gmf-deploy.service`:

```ini
[Unit]
Description=Gata Molhada Finance deploy
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/opt/gmf/deploy/deploy.sh
TimeoutStartSec=300
```

Crie `deploy/systemd/gmf-deploy.timer`:

```ini
[Unit]
Description=Run the Gata Molhada Finance deploy every 2 minutes

[Timer]
OnBootSec=1min
OnUnitInactiveSec=2min
AccuracySec=15s

[Install]
WantedBy=timers.target
```

- [ ] **Step 7: Tornar os scripts executáveis e rodar os testes**

Run: `chmod +x deploy/*.sh deploy/tests/*.sh deploy/tests/stubs/* && bash -n deploy/deploy.sh && bash -n deploy/fetch-secrets.sh && bash -n deploy/install.sh && bash deploy/tests/fetch-secrets.test.sh && bash deploy/tests/deploy.test.sh`
Expected: `all checks passed` nas duas suítes (7 verificações em `fetch-secrets` e 21 em `deploy`). O `deploy.test.sh` cobre: primeiro deploy, deploy sem mudança, atualização saudável com backup, atualização com falha e reversão, imagem ruim ignorada, imagem nova depois da falha, backup falho abortando o deploy, e poda de backups.

- [ ] **Step 8: Validar os arquivos YAML**

Run: `ruby -ryaml -e 'c=YAML.load_file("deploy/docker-compose.yml"); puts c["services"].keys.join(",")'`
Expected: `app,caddy`.

- [ ] **Step 9: Ponto de verificação (sem commit)**

Run: `git status --short && npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: os arquivos novos de `deploy/` listados e `# fail 0` na suíte do Node.

---

### Task 3: Scripts da CLI do Azure e cloud-init, com teste

**Files:**
- Create: `infra/azure/env.sh`, `infra/azure/05-preflight.sh`, `infra/azure/10-network.sh`, `infra/azure/20-keyvault.sh`, `infra/azure/30-vm.sh`, `infra/azure/set-secret.sh`, `infra/azure/99-teardown.sh`, `infra/azure/cloud-init.yaml`
- Test: `infra/azure/tests/set-secret.test.sh`

**Interfaces:**
- Consumes: variáveis `GMF_DNS_LABEL` e `GMF_KEYVAULT` (obrigatórias), e `GMF_LOCATION`, `GMF_RG`, `GMF_VM_NAME`, `GMF_VM_SIZE`, `GMF_ADMIN_USER`, `GMF_SSH_PUBKEY`, `GMF_PIP_NAME`, `GMF_NSG_NAME`, `GMF_ADMIN_IP`, `GMF_USER_OBJECT_ID` (opcionais, com padrões em `env.sh`).
- Produces: o conjunto de recursos descrito em B4; o endereço `https://<GMF_DNS_LABEL>.<GMF_LOCATION>.cloudapp.azure.com`; `set-secret.sh NOME` grava um segredo no cofre lendo o valor do terminal sem eco.

- [ ] **Step 1: Escrever o teste que falha**

Crie `infra/azure/tests/set-secret.test.sh`:

```bash
#!/usr/bin/env bash
# Tests for set-secret.sh with a stubbed az. Run: bash infra/azure/tests/set-secret.test.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../set-secret.sh"
failures=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "ok   - $label"
  else
    echo "FAIL - $label"
    echo "       expected: $expected"
    echo "       actual:   $actual"
    failures=$((failures + 1))
  fi
}

tmp="$(mktemp -d)"
mkdir -p "$tmp/bin"
cat > "$tmp/bin/az" << 'EOF'
#!/usr/bin/env bash
echo "$*" >> "$AZ_LOG"
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--file" ]]; then
    cp "$2" "$AZ_CAPTURE"
    ls -l "$2" | cut -c1-10 > "$AZ_CAPTURE.perms"
  fi
  shift
done
EOF
chmod +x "$tmp/bin/az"
export PATH="$tmp/bin:$PATH" AZ_LOG="$tmp/az.log" AZ_CAPTURE="$tmp/captured" GMF_KEYVAULT=kv-test

printf 'sk-secret-value\n' | bash "$script" PIERRE-API-KEY > /dev/null 2>&1
check "passes the value through a file" "sk-secret-value" "$(cat "$tmp/captured")"
check "the temporary file is private" "-rw-------" "$(cat "$tmp/captured.perms")"
check "the value never appears in the az arguments" "0" "$(grep -c 'sk-secret-value' "$tmp/az.log" || true)"
check "targets the right vault and name" "1" "$(grep -c -- '--vault-name kv-test --name PIERRE-API-KEY' "$tmp/az.log")"

if printf 'x\n' | bash "$script" bad_name > /dev/null 2>&1; then rc=0; else rc=$?; fi
check "rejects invalid names" "nonzero" "$([[ $rc -ne 0 ]] && echo nonzero || echo zero)"

if printf '\n' | bash "$script" EMPTY-VALUE > /dev/null 2>&1; then rc=0; else rc=$?; fi
check "rejects an empty value" "nonzero" "$([[ $rc -ne 0 ]] && echo nonzero || echo zero)"

if GMF_KEYVAULT= bash "$script" ANY-NAME < /dev/null > /dev/null 2>&1; then rc=0; else rc=$?; fi
check "requires GMF_KEYVAULT" "nonzero" "$([[ $rc -ne 0 ]] && echo nonzero || echo zero)"

if (( failures > 0 )); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `chmod +x infra/azure/tests/*.sh && bash infra/azure/tests/set-secret.test.sh`
Expected: falha porque `infra/azure/set-secret.sh` não existe.

- [ ] **Step 3: Criar as configurações compartilhadas e o `set-secret.sh`**

Crie `infra/azure/env.sh`:

```bash
#!/usr/bin/env bash
# Shared settings for the Azure scripts. Override any value from the environment.
export GMF_LOCATION="${GMF_LOCATION:-chilecentral}"
export GMF_RG="${GMF_RG:-rg-gmf}"
export GMF_VM_NAME="${GMF_VM_NAME:-vm-gmf}"
export GMF_VM_SIZE="${GMF_VM_SIZE:-Standard_B2ats_v2}"
export GMF_ADMIN_USER="${GMF_ADMIN_USER:-azureuser}"
export GMF_SSH_PUBKEY="${GMF_SSH_PUBKEY:-$HOME/.ssh/id_ed25519_gmf_vm.pub}"
export GMF_PIP_NAME="${GMF_PIP_NAME:-pip-gmf}"
export GMF_NSG_NAME="${GMF_NSG_NAME:-nsg-gmf}"
export GMF_ADMIN_IP="${GMF_ADMIN_IP:-}"

# Exits with a message if any of the named variables is empty.
require() {
  local name
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      echo "Set $name before running this script." >&2
      exit 1
    fi
  done
}
```

Crie `infra/azure/set-secret.sh`:

```bash
#!/usr/bin/env bash
# Stores one secret in Key Vault. The value is read from the terminal without echo
# and never appears in the process list or the shell history.
# Usage: infra/azure/set-secret.sh SECRET-NAME
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
require GMF_KEYVAULT

name="${1:?usage: set-secret.sh SECRET-NAME}"
if [[ ! "$name" =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "Secret names allow letters, digits and dashes only." >&2
  exit 1
fi

read -r -s -p "Value for $name: " value
echo
if [[ -z "$value" ]]; then
  echo "Empty value; nothing stored." >&2
  exit 1
fi

umask 077
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
printf '%s' "$value" > "$tmp"
az keyvault secret set --vault-name "$GMF_KEYVAULT" --name "$name" --file "$tmp" --encoding utf-8 --output none
echo "Stored $name in $GMF_KEYVAULT."
```

- [ ] **Step 4: Criar os demais scripts e o cloud-init**

Crie `infra/azure/05-preflight.sh`:

```bash
#!/usr/bin/env bash
# Read-only checks (plus provider registration) before creating anything.
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"

echo "== Account"
az account show --query "{name:name, id:id, state:state, user:user.name}" --output table

echo "== Resource providers"
for ns in Microsoft.Compute Microsoft.Network Microsoft.KeyVault; do
  state="$(az provider show --namespace "$ns" --query registrationState --output tsv)"
  echo "$ns: $state"
  if [[ "$state" != "Registered" ]]; then
    az provider register --namespace "$ns" --wait
  fi
done

echo "== VM size $GMF_VM_SIZE in $GMF_LOCATION"
az vm list-skus --location "$GMF_LOCATION" --size "$GMF_VM_SIZE" --resource-type virtualMachines \
  --query "[].{name:name, restrictions:restrictions[].reasonCode}" --output table
echo "An empty restrictions column means the size is available. If the list is empty or restricted, choose another size or region."
```

Crie `infra/azure/10-network.sh`:

```bash
#!/usr/bin/env bash
# Resource group, static public IP with a DNS label, and the network security group.
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
require GMF_DNS_LABEL

az group create --name "$GMF_RG" --location "$GMF_LOCATION" --output none

az network public-ip create --resource-group "$GMF_RG" --name "$GMF_PIP_NAME" --location "$GMF_LOCATION" \
  --sku Standard --allocation-method Static --dns-name "$GMF_DNS_LABEL" --output none

az network nsg create --resource-group "$GMF_RG" --name "$GMF_NSG_NAME" --location "$GMF_LOCATION" --output none

az network nsg rule create --resource-group "$GMF_RG" --nsg-name "$GMF_NSG_NAME" --name allow-web \
  --priority 100 --direction Inbound --access Allow --protocol Tcp \
  --source-address-prefixes Internet --destination-port-ranges 80 443 --output none

# SSH stays closed unless an admin IP is given. Without it, use `az vm run-command` for maintenance.
if [[ -n "$GMF_ADMIN_IP" ]]; then
  az network nsg rule create --resource-group "$GMF_RG" --nsg-name "$GMF_NSG_NAME" --name allow-ssh-admin \
    --priority 110 --direction Inbound --access Allow --protocol Tcp \
    --source-address-prefixes "$GMF_ADMIN_IP/32" --destination-port-ranges 22 --output none
fi

az network public-ip show --resource-group "$GMF_RG" --name "$GMF_PIP_NAME" \
  --query "{ip:ipAddress, fqdn:dnsSettings.fqdn}" --output table
```

Crie `infra/azure/20-keyvault.sh`:

```bash
#!/usr/bin/env bash
# Key Vault with RBAC. The signed-in user may manage secrets; the VM identity gets read access in 30-vm.sh.
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
require GMF_KEYVAULT

az keyvault create --resource-group "$GMF_RG" --name "$GMF_KEYVAULT" --location "$GMF_LOCATION" \
  --enable-rbac-authorization true --retention-days 7 --output none

kv_id="$(az keyvault show --name "$GMF_KEYVAULT" --query id --output tsv)"
user_id="${GMF_USER_OBJECT_ID:-$(az ad signed-in-user show --query id --output tsv)}"

az role assignment create --assignee-object-id "$user_id" --assignee-principal-type User \
  --role "Key Vault Secrets Officer" --scope "$kv_id" --output none

echo "Key Vault ready: https://$GMF_KEYVAULT.vault.azure.net"
```

Crie `infra/azure/30-vm.sh`:

```bash
#!/usr/bin/env bash
# The VM: Ubuntu 24.04, system-assigned identity, cloud-init that clones the repo and installs the deploy timer.
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
require GMF_DNS_LABEL GMF_KEYVAULT

if [[ ! -f "$GMF_SSH_PUBKEY" ]]; then
  echo "SSH public key not found: $GMF_SSH_PUBKEY (create one with: ssh-keygen -t ed25519 -f ${GMF_SSH_PUBKEY%.pub})" >&2
  exit 1
fi

host="${GMF_DNS_LABEL}.${GMF_LOCATION}.cloudapp.azure.com"
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
sed -e "s/__HOST__/${host}/g" -e "s/__KEYVAULT__/${GMF_KEYVAULT}/g" "$(dirname "$0")/cloud-init.yaml" > "$rendered"

az vm create --resource-group "$GMF_RG" --name "$GMF_VM_NAME" --location "$GMF_LOCATION" \
  --image Canonical:ubuntu-24_04-lts:server:latest --size "$GMF_VM_SIZE" \
  --admin-username "$GMF_ADMIN_USER" --ssh-key-values "$GMF_SSH_PUBKEY" --authentication-type ssh \
  --public-ip-address "$GMF_PIP_NAME" --nsg "$GMF_NSG_NAME" \
  --assign-identity '[system]' --custom-data "$rendered" \
  --os-disk-size-gb 30 --storage-sku Standard_LRS \
  --os-disk-delete-option Delete --nic-delete-option Delete --output none

principal_id="$(az vm show --resource-group "$GMF_RG" --name "$GMF_VM_NAME" --query identity.principalId --output tsv)"
kv_id="$(az keyvault show --name "$GMF_KEYVAULT" --query id --output tsv)"

az role assignment create --assignee-object-id "$principal_id" --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" --scope "$kv_id" --output none

echo "VM created. The app will be served at https://$host once the first image is published."
```

Crie `infra/azure/99-teardown.sh`:

```bash
#!/usr/bin/env bash
# Deletes the whole resource group (VM, disk, IP, network, Key Vault). Asks for confirmation.
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"

read -r -p "Type the resource group name ($GMF_RG) to delete everything in it: " answer
if [[ "$answer" != "$GMF_RG" ]]; then
  echo "Aborted."
  exit 1
fi

az group delete --name "$GMF_RG" --yes --no-wait
echo "Deletion started. A deleted Key Vault keeps its name for 7 days; to reuse the name run:"
echo "  az keyvault purge --name ${GMF_KEYVAULT:-<vault>} --location $GMF_LOCATION"
```

Crie `infra/azure/cloud-init.yaml`:

```yaml
#cloud-config
package_update: true
packages:
  - docker.io
  - docker-compose-v2
  - git
  - curl
  - jq

write_files:
  - path: /etc/gmf/vm.env
    permissions: '0644'
    content: |
      GMF_HOST=__HOST__
      GMF_KEYVAULT=__KEYVAULT__

runcmd:
  - fallocate -l 1G /swapfile
  - chmod 600 /swapfile
  - mkswap /swapfile
  - swapon /swapfile
  - echo '/swapfile none swap sw 0 0' >> /etc/fstab
  - systemctl enable --now docker
  - git clone --depth 1 https://github.com/franklinclf/gata-molhada-finance.git /opt/gmf
  - mkdir -p /var/lib/gmf/backups
  - chown -R 1000:1000 /var/lib/gmf
  - bash /opt/gmf/deploy/install.sh
```

- [ ] **Step 5: Rodar o teste e validar a sintaxe**

Run: `chmod +x infra/azure/*.sh && for f in infra/azure/*.sh infra/azure/tests/*.sh; do bash -n "$f" || echo "ERRO: $f"; done; bash infra/azure/tests/set-secret.test.sh`
Expected: nenhuma linha `ERRO` e `all checks passed` (7 verificações).

- [ ] **Step 6: Validar o cloud-init renderizado**

Run: `sed -e "s/__HOST__/demo.example/g" -e "s/__KEYVAULT__/kv-demo/g" infra/azure/cloud-init.yaml > /tmp/ci-rendered.yaml && ruby -ryaml -e 'y=YAML.load_file("/tmp/ci-rendered.yaml"); puts "packages=#{y["packages"].size} runcmd=#{y["runcmd"].size}"'; head -1 /tmp/ci-rendered.yaml`
Expected: `packages=5 runcmd=10` e `#cloud-config` na primeira linha.

- [ ] **Step 7: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: os arquivos de `infra/azure/` listados.

---

### Task 4: Sessão da CLI do Azure no sandbox (depende de B2 e das decisões D1 a D5)

**Files:** nenhum arquivo do repositório.

**Interfaces:**
- Consumes: CLI do Azure instalada e `az login` feito pelo usuário (feitos: versão 2.91.0, assinatura "Azure for Students" habilitada).
- Produces: uma sessão em que `az` alcança o Azure a partir do sandbox, e o resultado de `05-preflight.sh`.

- [ ] **Step 1: Confirmar o login**

Run: `az account show --query "{assinatura:name, estado:state}" --output table`
Expected: `Azure for Students` e `Enabled`.

- [ ] **Step 2: Liberar os hosts (B2, ação do usuário)**

O sandbox devolve `403 Forbidden` no túnel do proxy para `management.azure.com`. O usuário adiciona, pelo Dashboard (aba Domains), `management.azure.com` e `login.microsoftonline.com`. Cada entrada libera o host e seus subdomínios para todas as sessões futuras. O `graph.microsoft.com` não é necessário se o usuário informar `GMF_USER_OBJECT_ID`. Depois da escolha do nome do cofre (D4), libera-se também `<nome-do-cofre>.vault.azure.net`.

- [ ] **Step 3: Testar uma chamada de leitura**

Run: `az group list --query "[].name" --output tsv`
Expected: lista vazia ou os grupos existentes, sem `Unable to connect to proxy`. Se aparecer um erro de certificado TLS, o usuário roda `claude ssl-verify` e o problema é tratado antes de seguir.

- [ ] **Step 4: Rodar a verificação prévia**

Run: `GMF_LOCATION=<D1> GMF_VM_SIZE=<D2> bash infra/azure/05-preflight.sh`
Expected: a assinatura habilitada; `Microsoft.Compute`, `Microsoft.Network` e `Microsoft.KeyVault` como `Registered` (o script registra os que faltarem, o que é inofensivo); e o tamanho da VM listado com a coluna `restrictions` vazia. Se a lista vier vazia ou com restrições, voltar a D1 ou D2 e repetir.

---

### Task 5: Criar a infraestrutura (depende de B4, D1 a D5 e da Tarefa 4)

**Files:** nenhum arquivo do repositório.

**Interfaces:**
- Consumes: os scripts da Tarefa 3; as decisões D1 a D5; um par de chaves SSH da VM em `$GMF_SSH_PUBKEY` (padrão `~/.ssh/id_ed25519_gmf_vm.pub`), criado pelo usuário com `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_gmf_vm`.
- Produces: a VM em execução, o cofre com a permissão de leitura para a identidade da VM e o segredo de teste `GMF-SMOKE-TEST`.

- [ ] **Step 1: Criar rede e grupo de recursos**

Run: `export GMF_DNS_LABEL=<D3> GMF_KEYVAULT=<D4> GMF_LOCATION=<D1> GMF_VM_SIZE=<D2>; bash infra/azure/10-network.sh`
Expected: uma tabela com o IP público e o FQDN `<D3>.<D1>.cloudapp.azure.com`.

- [ ] **Step 2: Criar o cofre**

Run: `bash infra/azure/20-keyvault.sh`
Expected: `Key Vault ready: https://<D4>.vault.azure.net`. O script usa `az ad signed-in-user show`, que chama o Microsoft Graph e pode estar bloqueado no sandbox. Sem o Graph, obtenha o id de objeto a partir do token do ARM e exporte antes de rodar o script (o token não é exibido):

```bash
export GMF_USER_OBJECT_ID="$(az account get-access-token --query accessToken -o tsv | python3 -I -c "import sys,json,base64; t=sys.stdin.read().strip().split('.')[1]; print(json.loads(base64.urlsafe_b64decode(t+'=='*2))['oid'])")"
```

- [ ] **Step 3: Guardar o segredo de teste (ação do usuário, em terminal próprio)**

O usuário roda `GMF_KEYVAULT=<D4> bash infra/azure/set-secret.sh GMF-SMOKE-TEST` e digita um valor qualquer sem importância. Expected: `Stored GMF-SMOKE-TEST in <D4>.`

- [ ] **Step 4: Criar a VM**

Run: `bash infra/azure/30-vm.sh`
Expected: `VM created. The app will be served at https://<D3>.<D1>.cloudapp.azure.com once the first image is published.` Se o tamanho ou a imagem forem recusados (por exemplo, geração 2 não suportada), ajustar D2 ou usar o URN da imagem `Canonical:ubuntu-24_04-lts:server-gen1:latest` em `30-vm.sh`.

- [ ] **Step 5: Acompanhar o cloud-init**

Run: `az vm run-command invoke --resource-group rg-gmf --name vm-gmf --command-id RunShellScript --scripts "cloud-init status --long; systemctl is-active docker; systemctl list-timers gmf-deploy.timer --no-pager" --query "value[0].message" --output tsv`
Expected: `status: done`, `active` e o timer `gmf-deploy.timer` na lista. Se ainda estiver `running`, esperar alguns minutos e repetir.

---

### Task 6: Primeira implantação e verificação em HTTPS

**Files:** nenhum arquivo do repositório.

**Interfaces:**
- Consumes: imagem pública da Tarefa 1 (B3), VM e cofre da Tarefa 5.
- Produces: `https://<D3>.<D1>.cloudapp.azure.com/healthz` respondendo `ok` com o commit publicado.

- [ ] **Step 1: Esperar o primeiro ciclo do timer**

O timer roda a cada 2 minutos. A leitura do Key Vault pode falhar nos primeiros minutos, até a permissão da identidade da VM propagar. O timer tenta de novo sozinho.

Run: `az vm run-command invoke --resource-group rg-gmf --name vm-gmf --command-id RunShellScript --scripts "journalctl -u gmf-deploy --no-pager -n 30; docker ps --format '{{.Names}} {{.Status}}'" --query "value[0].message" --output tsv`
Expected: uma linha `deployed sha256:...` no registro e os contêineres `gmf-app` (saudável) e `gmf-caddy` em execução.

- [ ] **Step 2: Chamar o endpoint público**

Run: `curl -sS https://<D3>.<D1>.cloudapp.azure.com/healthz`
Expected: `{"status":"ok","version":"<40 caracteres do commit>","schemaVersion":1,"time":"..."}`. O certificado é emitido pelo Caddy na primeira requisição, o que pode levar alguns segundos. Se der erro de certificado, conferir `docker logs gmf-caddy` na VM e se as portas 80 e 443 estão abertas.

- [ ] **Step 3: Conferir que o SSH está fechado**

Run: `nc -z -w 5 <D3>.<D1>.cloudapp.azure.com 22; echo "exit=$?"`
Expected: `exit=1` (porta fechada), a menos que `GMF_ADMIN_IP` tenha sido definido.

---

### Task 7: Ensaios de falha e documentação

**Files:**
- Create: `deploy/README.md`

**Interfaces:**
- Consumes: a VM em execução da Tarefa 6.
- Produces: evidência de que a rotação de segredo e a reversão funcionam, e um guia de operação.

- [ ] **Step 1: Ensaio de rotação de segredo**

O usuário troca o valor de `GMF-SMOKE-TEST` com `set-secret.sh`. Depois de até 2 minutos:

Run: `az vm run-command invoke --resource-group rg-gmf --name vm-gmf --command-id RunShellScript --scripts "journalctl -u gmf-deploy --no-pager -n 10" --query "value[0].message" --output tsv`
Expected: uma nova linha `deploying sha256:...` seguida de `deployed ...` (a mudança no hash do ambiente recria o contêiner).

- [ ] **Step 2: Ensaio de reversão**

O timer pode agir antes do ensaio, então ele é parado primeiro e religado no fim.

1. Parar o timer: `az vm run-command invoke -g rg-gmf -n vm-gmf --command-id RunShellScript --scripts "systemctl stop gmf-deploy.timer" -o none`.
2. O usuário troca o valor de `GMF-SMOKE-TEST` com `set-secret.sh` (isso muda o hash do ambiente e força uma recriação do contêiner).
3. Rodar a implantação com um limite de saúde de 1 segundo, impossível de cumprir:

Run: `az vm run-command invoke -g rg-gmf -n vm-gmf --command-id RunShellScript --scripts "GMF_HEALTH_TIMEOUT=1 /opt/gmf/deploy/deploy.sh --no-pull; echo exit=\$?; docker ps --format '{{.Names}} {{.Status}}'" --query "value[0].message" -o tsv`
Expected: `new version failed its health check; rolling back`, `rolled back to the previous image`, `exit=1`, e `gmf-app` saudável de novo.

4. Limpar e religar: `az vm run-command invoke -g rg-gmf -n vm-gmf --command-id RunShellScript --scripts "rm -f /var/lib/gmf/.failed-image-id; systemctl start gmf-deploy.timer" -o none`. O marcador precisa sair porque, neste ensaio, a imagem "ruim" é a mesma que está no ar, e ele faria o timer ignorar qualquer mudança de segredo até uma imagem nova.

- [ ] **Step 3: Criar o guia de operação**

Crie `deploy/README.md`:

````markdown
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
````

- [ ] **Step 4: Ponto de verificação (sem commit)**

Run: `git status --short`
Expected: `deploy/README.md` listado. O usuário decide os commits e o push.

---

## Fora deste plano

- Autenticação do app e rotas com dados (Plano F). Até lá, só o `/healthz` está no ar.
- Backup noturno para fora da VM e monitoramento (Plano H). Este plano só cobre a cópia antes de cada implantação.
- Domínio próprio. O endereço `*.cloudapp.azure.com` basta; um domínio do pacote de estudante pode ser apontado depois com um registro A para o IP estático, trocando `GMF_HOST` em `/etc/gmf/vm.env`.

## Auto-revisão contra o design

- Seção 9 (hospedagem): VM x86, Docker, Caddy com HTTPS automático, SQLite no disco da VM e SSH restrito estão nas Tarefas 2, 3 e 5. O domínio gratuito do pacote de estudante virou opcional, porque o rótulo DNS do Azure já fornece HTTPS.
- Segredos no Key Vault com identidade gerenciada (ajuste aprovado depois da primeira versão do design): Tarefas 2, 3 e 5. O GitHub não guarda segredos de produção.
- Seção 10 (CI/CD): publicação da imagem e implantação por busca pela VM, com reversão: Tarefas 1, 2 e 7. A imagem não leva `.env` nem `data/` (`.dockerignore`).
- Seção 12, etapa 1 (`/healthz` implantado): Tarefa 6.
- Cópia do banco antes de cada implantação: Tarefa 2. Backup externo noturno fica para o Plano H.
