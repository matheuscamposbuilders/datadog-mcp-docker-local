# datadog-local-mcp

Servidor MCP (Model Context Protocol) local, empacotado em Docker, que expõe dados do Datadog a um cliente MCP (ex.: Claude Code) sobre stdio. **Estritamente somente leitura**: nenhuma rota de escrita é alcançável — nem por acidente, nem por um agente adversarial tentando contorná-lo. Veja [§Threat model](#threat-model) para o detalhamento de cada camada de defesa e suas limitações reais.

## Sumário

- [Como usar](#como-usar)
- [As 10 tools](#as-10-tools)
- [Configuração](#configuração)
- [§Scopes — pré-requisito nº 1](#scopes--pré-requisito-nº-1)
- [§Threat model](#threat-model)
- [Desenvolvimento](#desenvolvimento)

## Como usar

### 1. Build da imagem

```bash
docker build -t datadog-local-mcp:latest .
# ou
npm run docker:build
```

Build multi-stage (`deps` → `build` → `prod-deps` → `runtime`): a imagem final não contém `devDependencies` nem o código-fonte TypeScript, apenas `dist/` compilado, `node_modules/` de produção e `package.json`.

### 2. Registrar no Claude Code

O arquivo `.mcp.json` já está pronto neste repositório:

```json
{
  "mcpServers": {
    "datadog": {
      "command": "docker",
      "args": ["run","-i","--rm","--read-only",
        "--tmpfs","/tmp:rw,noexec,nosuid,size=16m",
        "--cap-drop","ALL","--security-opt","no-new-privileges:true",
        "--user","10001:10001","--pids-limit","128","--memory","256m",
        "-e","DD_API_KEY","-e","DD_APP_KEY","-e","DD_SITE",
        "datadog-local-mcp:latest"],
      "env": { "DD_API_KEY": "${DD_API_KEY}", "DD_APP_KEY": "${DD_APP_KEY}", "DD_SITE": "${DD_SITE:-datadoghq.com}" }
    }
  }
}
```

Exporte `DD_API_KEY`/`DD_APP_KEY`/`DD_SITE` no ambiente do seu shell (ou de um `.env` carregado por ele) antes de abrir o Claude Code. Isso é suficiente para o servidor funcionar.

### 3. `docker-compose.yml` (desenvolvimento/smoke manual)

Existe também um `docker-compose.yml`, mas é só para desenvolvimento e smoke-test manual local — o Claude Code em si fala com o servidor via `docker run` direto, conforme `.mcp.json` acima, não via compose.

## As 10 tools

Extraído de `src/tools/index.ts` (agregador) e dos módulos individuais em `src/tools/*.ts`. A ordem abaixo é a mesma ordem fixa registrada em `TOOLS` (validate, metrics, monitors, logs, spans, events) — essa ordem é congelada por snapshot em `test/contract/tool-registry.test.ts`.

| Tool | O que faz | Rota Datadog |
|---|---|---|
| `dd_validate_credentials` | Verifica se a API key configurada é aceita pelo Datadog. Health check; **não** valida a Application key nem seus scopes. | `GET /api/v1/validate` |
| `dd_query_timeseries` | Executa uma query de métrica timeseries e retorna a série resultante. | `GET /api/v1/query` |
| `dd_list_metrics` | Lista nomes de métricas que reportaram dado desde `from`. | `GET /api/v1/metrics` |
| `dd_get_metric_metadata` | Busca metadados (descrição, unidade, tipo) de uma métrica específica. | `GET /api/v1/metrics/{metric_name}` |
| `dd_list_monitors` | Lista monitores Datadog, com filtro opcional por nome/tags. | `GET /api/v1/monitor` |
| `dd_get_monitor` | Busca a definição completa de um monitor por id. | `GET /api/v1/monitor/{monitor_id}` |
| `dd_search_monitors` | Busca monitores por query de status/tipo/tags. | `GET /api/v1/monitor/search` |
| `dd_search_logs` | Busca eventos de log via query padrão Datadog. | `POST /api/v2/logs/events/search` |
| `dd_search_spans` | Busca spans de APM via query padrão de trace search. | `POST /api/v2/spans/events/search` |
| `dd_list_events` | Lista eventos (deploys, alertas, comentários, mudanças de config) em uma janela de tempo. | `GET /api/v1/events` |

## Configuração

Todas as variáveis são lidas em `src/config.ts` (`loadConfig`), que valida tudo antecipadamente (fail fast) e registra `DD_API_KEY`/`DD_APP_KEY` no redator de segredos antes de retornar — nada downstream consegue vazá-las em log ou texto de erro.

| Variável | Obrigatória | Default | Descrição |
|---|---|---|---|
| `DD_API_KEY` | sim | — | API key Datadog (nível org). Header `DD-API-KEY`. |
| `DD_APP_KEY` | sim | — | Application key Datadog. Header `DD-APPLICATION-KEY`. Veja [§Scopes](#scopes--pré-requisito-nº-1). |
| `DD_SITE` | não | `datadoghq.com` | Site Datadog. Ver `SUPPORTED_SITES` abaixo. |
| `DD_LOG_LEVEL` | não | `error` | Um de `silent`, `error`, `warn`, `info`, `debug`. |
| `DD_REQUEST_TIMEOUT_MS` | não | `30000` | Timeout por requisição HTTP, em ms (inteiro positivo). |
| `DD_MAX_RETRIES` | não | `3` | Máximo de retries (inteiro ≥ 0). |
| `DD_MAX_RETRY_WAIT_MS` | não | `30000` | Espera máxima entre retries, em ms (inteiro positivo). |
| `DD_MAX_CONCURRENCY` | não | `4` | Concorrência máxima de requisições (inteiro positivo). |
| `DD_MAX_RESPONSE_BYTES` | não | `100000` | Tamanho máximo de resposta aceito, em bytes (inteiro positivo). |

`SUPPORTED_SITES` (de `src/config.ts`): `datadoghq.com`, `us3.datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu`, `ap1.datadoghq.com`, `ap2.datadoghq.com`, `ddog-gov.com`. Qualquer outro valor de `DD_SITE` faz `loadConfig` lançar erro na inicialização.

### O truque do `-e NOME` sem valor no `.mcp.json`

Repare que os `args` do `.mcp.json` passam `-e DD_API_KEY` (sem `=valor`) para o `docker run`. Nessa forma, o Docker não lê o valor do array `args` — ele repassa por referência a variável de mesmo nome do ambiente do **processo `docker` que o Claude Code lança**. O bloco `"env"` do `.mcp.json` é o que popula esse ambiente (`"DD_API_KEY": "${DD_API_KEY}"`, expandido a partir do shell/ambiente onde o Claude Code roda).

Resultado prático: a credencial nunca fica escrita em texto claro dentro de `.mcp.json` (que é versionado), e não aparece na linha de comando visível em `ps aux` — só o nome da variável (`-e DD_API_KEY`) aparece ali, nunca o valor.

## §Scopes — pré-requisito nº 1

**Antes de tudo, crie a Application Key certa.** Ela deve pertencer a uma **service account** com role **"Datadog Read Only"**, e ter exatamente os scopes abaixo — nenhum `*_write`, nenhum scope administrativo, nada além do que cada rota usa. Extraído dos campos `scopes` de `ALLOWED_ROUTES` em `src/security/allowlist.ts`, a fonte de verdade:

| Rota | Scope necessário |
|---|---|
| `GET /api/v1/validate` | nenhum |
| `GET /api/v1/query` | `timeseries_query` |
| `GET /api/v1/metrics`, `GET /api/v1/metrics/{metric_name}` | `metrics_read` |
| `GET /api/v1/monitor`, `GET /api/v1/monitor/{id}`, `GET /api/v1/monitor/search` | `monitors_read` |
| `GET /api/v1/events` | `events_read` |
| `POST /api/v2/logs/events/search` | `logs_read_data` + `logs_read_index_data` |
| `POST /api/v2/spans/events/search` | `apm_read` |

Por que isso é o pré-requisito nº 1: o RBAC do **dono** da App Key é um teto por cima do scope da própria key — uma App Key com escopo mínimo, mas pertencente a um usuário/service account com permissões amplas, ainda herda esse teto. Por isso a exigência é dupla: role "Datadog Read Only" no dono **e** os scopes acima, exatos, na key.

Se a App Key não tiver o scope de uma rota, a chamada correspondente falha com `403` do próprio Datadog — essa é a camada L0 do threat model abaixo, e é a única inviolável a partir de dentro deste servidor.

**Nunca "teste" o guardrail emitindo uma escrita real contra a organização de produção.** A verificação de que a App Key é read-only é feita por **inspeção de scope na UI do Datadog** (Organization Settings → API Keys / Application Keys) e pelos testes automatizados deste repositório (`npm run verify`), nunca por tentativa de escrita real.

## §Threat model

Honesto sobre o que cada camada cobre — e o que não cobre. Nenhuma camada isolada é suficiente; a defesa é a composição de todas.

| Camada | O que cobre | O que **não** cobre |
|---|---|---|
| **L0 — scope read-only da App Key** | Única camada **inviolável** a partir de dentro do processo: o enforcement é feito pelo lado do Datadog. Se todas as outras camadas falharem, uma chamada de escrita ainda volta `403`. | Nada dentro do processo local — é uma garantia externa, não um controle deste código. |
| **L1 — allowlist por (método, rota ancorada)** | `ALLOWED_ROUTES` em `src/security/allowlist.ts` só permite os 10 pares exatos de (método, padrão de rota ancorado). "Read-only no Datadog" **não é sinônimo de GET-only** — busca de logs e de spans são `POST`. Por isso a allowlist é por par método+rota, nunca por verbo isolado. | Não impede uma rota de leitura legítima de ser chamada fora de contexto; não é proteção contra abuso de rate/volume. |
| **L2 — rejeição de método fora de GET/POST** | Roda **antes** de qualquer parsing de path — barreira que se sustenta mesmo se um padrão de rota tiver bug. | Não valida nada sobre o conteúdo do path por si só. |
| **L3 — body de POST montado por builder** | Os dois POSTs (`search_logs`, `search_spans`) têm o body **construído por um builder** a partir de schema Zod `.strict()` — nunca repassa JSON vindo do modelo/LLM diretamente para o Datadog. | Não impede um builder mal escrito de compor um body inválido; a defesa está na disciplina de nunca ter um caminho de repasse direto. |
| **L4 — guard em `globalThis.fetch`** | Instalado por `src/security/preload.ts`: intercepta qualquer `fetch` (inclusive de dependência transitiva) e valida contra a allowlist antes de deixar passar. **Não é airtight**: não enxerga `node:https`, `node:net`, `node:tls`, nem qualquer dependência que já tenha capturado uma referência ao `fetch` original antes do preload rodar. É um *tripwire* para erro nosso (uma chamada `fetch` perdida que escapou do chokepoint), não uma sandbox de rede. | Transporte de baixo nível fora de `fetch`; dependências que guardaram `fetch` antes do patch. |
| **L6 — lint (`eslint.config.js`)** | Regras `no-restricted-imports`/`-globals`/`-properties`/`-syntax` bloqueiam `node:http(s)`, `node:net`, `node:tls`, `undici`, `axios`, `node-fetch`, `eval`, `new Function(...)` etc. em tempo de desenvolvimento. É controle de **processo**, não de runtime: impede que uma fatia futura contorne o chokepoint HTTP sem ser pega no lint. | Não protege o runtime em produção — um bypass de lint (ex. `eslint-disable`) não é impedido em tempo de execução. |
| **L7 — hardening do container** | `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges:true`, usuário não-root `10001:10001`, `--pids-limit`, `--memory`. Protege **o host** e limita o raio de um RCE em dependência (o processo comprometido não consegue escrever no filesystem, escalar privilégio, nem consumir recursos ilimitados). | **Não é** o que impede escrita no Datadog — isso é papel de L0/L1. Não confundir as duas coisas: hardening de container é isolamento de host, não é enforcement de somente-leitura contra a API externa. |
| **L9 — Node.js permission model** | Ativo no `ENTRYPOINT` via `--experimental-permission --allow-fs-read=/app`. Verificado (fora do container, com `--allow-fs-read=$PWD`, e depois confirmado dentro do container — ver `Dockerfile`): o servidor sobe normalmente e devolve as 10 tools; em paralelo, uma chamada de controle a `require('node:child_process').execSync('id')` foi **bloqueada** com `ERR_ACCESS_DENIED` com a flag ativa, e executou normalmente sem a flag. A flag emite um `ExperimentalWarning` em stderr — inofensivo aqui, porque stdout é o canal JSON-RPC e stderr é só log. | `worker_threads` e `child_process` são o alvo coberto; não é um sandbox geral de I/O — outras APIs de filesystem além de leitura sob `/app` seguem restritas apenas pelo próprio `--allow-fs-read`, não por uma lista de negação abrangente. |
| **`redirect: 'error'` no chokepoint HTTP** | Faz o `fetch` do chokepoint (`src/http/datadog-client.ts`) **lançar** em vez de seguir um `3xx`. Sem isso, uma resposta de redirect faria o `fetch` reenviar automaticamente os headers `DD-API-KEY`/`DD-APPLICATION-KEY` para o host do `Location` — dentro da própria chamada, sem nunca passar de novo por L1 ou L4 (que só veem a URL de entrada). | Só cobre o chokepoint; não é uma camada independente de proteção de credencial contra outros vetores de exfiltração. |

### Achado da suíte adversarial: `assertAllowedUrl` e a checagem de host

A suíte adversarial (`test/security/`) identificou que a checagem de host **dentro de `assertAllowedUrl`** (`src/security/allowlist.ts`) é **estruturalmente inalcançável** pelos call sites reais deste servidor: o client Datadog deriva o `expectedHost` a partir do mesmo `baseUrl` que já usou para montar a própria URL da requisição, e o guard L4 passa como `expectedHost` o host extraído da própria URL que está validando — ou seja, nos dois call sites atuais, `parsed.host !== expectedHost` nunca pode ser verdadeiro, porque os dois lados vêm da mesma fonte.

Isso **não** é um bug a corrigir agora — a checagem continua como defesa em profundidade para call sites futuros que possam derivar `expectedHost` de uma fonte diferente da URL sendo validada. Mas hoje, a proteção efetiva de host contra um path malicioso vem de **outro lugar**: a rejeição de path absoluto/URL completa no client (que só aceita paths relativos e monta a URL final ele mesmo a partir do `baseUrl` configurado) e do próprio `allowHosts` do guard L4 (que rejeita hosts fora da lista antes mesmo de chegar em `assertAllowedUrl`). Documentar isso aqui existe para que ninguém confie na camada errada ao raciocinar sobre esse vetor.

### O que foi descartado deliberadamente (teatro de segurança)

- **Allowlist de egress por IP/DNS**: não distingue uma chamada de leitura de uma de escrita para o mesmo host — bloquearia ou permitiria as duas juntas, sem agregar nada que L1 já não resolva no nível certo (método+rota).
- **Dispatcher `undici` customizado**: dependência extra sem ganho de segurança real sobre o guard em `globalThis.fetch` já instalado — mais superfície, mesma cobertura.
- **A description das tools dizendo "read-only" / `readOnlyHint: true`**: isso é metadado para o cliente MCP exibir ao usuário, não enforcement. O enforcement real é L0–L9 acima; a annotation por si só não impede nada.

## Desenvolvimento

```bash
npm run verify   # lint + typecheck + test — deve ficar 100% verde antes de qualquer PR
```

`npm run verify` roda, em ordem: `eslint .` (inclui as regras L6 do threat model acima), `tsc --noEmit`, e `vitest run`. A suíte de testes (486 testes, 20 arquivos, na última execução) está organizada em camadas:

- **Unitário**: `test/config.test.ts`, `test/format.test.ts`, `test/logger.test.ts`, `test/http/*`, `test/schemas/*`, `test/tools/*` — comportamento de cada módulo isolado (validação de config, formatação de resultado, retry/paginação do client HTTP, schemas Zod de cada tool, handlers de tool).
- **Contrato**: `test/contract/tool-registry.test.ts`, com snapshot em `test/contract/__snapshots__/` — trava a lista e a ordem das 10 tools registradas em `src/tools/index.ts`; adicionar/remover/reordenar uma tool exige atualizar o snapshot conscientemente, nunca como efeito colateral. Inclui também um teste de integração via transporte MCP real.
- **Adversarial**: `test/security/*` — `matrix.test.ts` varre a matriz método×rota (incluindo combinações fora da allowlist, path traversal, encoding duplo, hosts falsos) contra `allowlist.ts`; `fetch-guard.test.ts` cobre o guard L4; `source-audit.test.ts` faz auditoria estática do código-fonte (grep estrutural) para garantir que nenhum outro ponto do código chama `fetch`/`http`/`net` fora do chokepoint.

`src/contracts.ts` está **congelado** desde a fatia T0 (scaffold): contém só tipos, sem lógica de runtime, e é consumido por todo o resto do código. Não deve ser editado sem uma revisão de fatia dedicada.

## Status de build e verificação (nesta rodada)

- `npm run verify`: **verde** — 486 testes, lint e typecheck limpos. Nenhum arquivo em `src/` ou `test/` foi tocado nesta rodada.
- `docker build -t datadog-local-mcp:latest .`: **executado com sucesso** nesta máquina (Docker Desktop disponível). Tamanho da imagem final: **209MB**, obtido com `docker images datadog-local-mcp:latest --format '{{.Size}}'` (esse é o tamanho total da imagem — `docker inspect ... --format '{{.Size}}'`, usado numa medição anterior deste README, reporta só o tamanho das camadas exclusivas da imagem, ~50.5MB, e não o tamanho total; foi essa métrica errada que produzia o valor "~48 MiB" reportado antes).
- Smoke stdio dentro do container, com as flags de hardening do `.mcp.json` e `DD_API_KEY=fake_key_12345678 DD_APP_KEY=fake_app_12345678 DD_SITE=datadoghq.com`: **executado** — `initialize` respondeu normalmente e `tools/list` devolveu as 10 tools; stderr só teve o `ExperimentalWarning` do L9.
- `docker inspect` no container em execução: **confirmado** — `ReadonlyRootfs: true`, `CapDrop: [ALL]`, usuário `10001:10001`, `PidsLimit: 128`.

Como o Docker esteve disponível nesta execução, todos os itens de aceite desta fatia foram verificados de ponta a ponta — nenhum ficou pendente por indisponibilidade de ambiente.
