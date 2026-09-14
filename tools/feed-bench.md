# Latência do `/v1/feed` contra o catálogo real — medição de 2026-09-13

O PLAN §4 define um gatilho: **"Feed p95 > 200ms → cache de página por (user,
hash dos filtros), e aí entra Redis"**. Esse número nunca tinha sido medido. A
única medição que existia era o `EXPLAIN` do A6, sobre a fixture de 94 títulos.

Esta é a medição contra os **9830 títulos** do catálogo ingerido.

**Veredito: o gatilho não é atingido pelo uso do beta.** O p95 de um usuário
sozinho fica entre 57ms e 81ms — 2,5× abaixo dos 200ms. O gatilho só aparece
quando a API é saturada de propósito, num regime ~90× mais pesado que o beta.

E esses 81ms são pessimistas: **~40ms de cada requisição medida aqui são o
encaminhador de porta do podman, não o app** (§"Os ~40ms são a porta publicada
do container"). Tirando isso, a resposta é da ordem de 33ms. Produção tem outros
custos — Neon do outro lado da rede, e o cold start do Fly, que este relatório
**não** mede e é o que o primeiro convidado vai sentir.

**Nada foi otimizado.** A decisão sobre o cache é do usuário e está no PLAN.

## Números

`node tools/feed-bench.mjs`, 100 amostras por cenário (mais 10 de aquecimento
fora do relógio), conta com 400 swipes, tempo medido pelo cliente (ida e volta
HTTP completa, incluindo o parse do JSON).

| cenário | p50 | p95 | p99 | max |
|---|---|---|---|---|
| conta vazia, sem filtro | 63,8ms | 66,9ms | 69,4ms | 72,2ms |
| conta com 400 swipes, sem filtro | 73,2ms | 81,1ms | 94,0ms | 99,8ms |
| filtro combinado (tipo+gênero+ano) | 53,9ms | 57,0ms | 57,8ms | 58,6ms |
| paginação: página 2 | 74,3ms | 80,1ms | 87,7ms | 100,0ms |
| paginação: página 3 | 74,6ms | 79,0ms | 84,3ms | 85,1ms |

(Os cinco cenários acima rodam com uma requisição em voo por vez. Os números
são de uma execução; uma segunda execução independente reproduziu todos dentro
de ~4ms — o maior desvio foi o p95 da paginação, 78,7ms contra 80,1ms.)

As quatro perguntas, respondidas:

1. **p50/p95 com histórico.** 73,2ms e 81,1ms. O histórico de 400 swipes custa
   ~10ms sobre a conta vazia — é o anti-join contra `swipes` e o boost por
   gênero. Continua 2,5× abaixo do gatilho.
2. **Filtro combinado NÃO é o caminho mais caro — é o mais barato.** 53,9ms,
   ~20ms *abaixo* do feed sem filtro. O filtro corta os candidatos de 9430 para
   1435 antes do score, e o `EXPLAIN` confirma: `Execution Time` cai de 34,6ms
   para 5,8ms. A expectativa de que o filtro doesse estava invertida.
3. **A paginação se mantém.** Página 2 (74,3ms) e página 3 (74,6ms) custam o
   mesmo que a página 1 (73,2ms). O keyset faz o que prometia: a diferença entre
   as três páginas está dentro do ruído de medição. Não há degradação por
   profundidade — que é exatamente o que um `OFFSET` teria dado.
4. **`EXPLAIN ANALYZE` da query real** (abaixo), tirada de `feedPage().toSQL()`,
   o mesmo caminho do teste A6 — não de uma query reescrita à mão.

## O que acontece sob carga

O beta convida 10 a 30 pessoas, então a medição de usuário sozinho é só o piso.
Com requisições em voo ao mesmo tempo:

| em voo | p50 | p95 | vazão |
|---|---|---|---|
| 1 | 73,2ms | 81,1ms | ~13,5 req/s |
| 10 | 105,6ms | 109,7ms | ~92 req/s |
| 30 | 208,1ms | 310,7ms | ~92 req/s |

A vazão empaca em ~92 req/s entre 10 e 30 em voo: da 10 em diante a API está
saturada e concorrência extra vira fila, não trabalho. É por isso que o p95 sobe
para 310,7ms com 30 em voo — **o gatilho de 200ms é atingido ali**, e só ali.

**Mas 30 requisições em voo não são 30 usuários do beta.** O deck vem de 20 em
20 e o cliente pede o próximo quando restam 5 (`PAGE = 20`, `feed.ts`): são ~15
swipes por requisição. Uma pessoa swipando rápido, um swipe a cada 2s, gera uma
requisição de feed a cada ~30s. Trinta pessoas swipando ao mesmo tempo, o dia
todo, dão **~1 req/s** — contra os ~92 req/s medidos como teto. A folga é de
duas ordens de grandeza.

## De onde vem o tempo

Cada resposta do `/v1/feed` faz três idas ao banco, não uma. Medidas de fora da
rota, direto no banco:

| passo | p50 | p95 |
|---|---|---|
| `requireUserId`: SELECT em `users` pela PK | 0,1ms | 0,3ms |
| `recomputeWeights`: agregado de `swipes` | 1,2ms | 2,9ms |
| `recomputeWeights`: UPDATE do `taste_vector` | 0,6ms | 0,7ms |
| `feedPage`: a query do deck | 65,2ms | 70,1ms |

A consulta de autenticação e o recálculo do boost somam <2ms: o `ponytail:` do
`auth.ts` ("uma consulta pela PK em toda requisição autenticada... some no dia em
que aparecer no perfil de latência") pode continuar dormindo, e o do
`weightsFor` também. **Quase toda a resposta é a query do deck.**

E dentro dela havia uma sobra: `EXPLAIN (ANALYZE, SERIALIZE, TIMING OFF)` diz
que o servidor fecha em 21,4ms, e o cliente cronometra 65ms para a mesma query.
**Os ~40ms de diferença não são do Watchlytics. São do podman.**

### Os ~40ms são a porta publicada do container

A primeira redação deste relatório registrou esses ~40ms como "entre o Postgres
terminar e as linhas virarem objetos no Node" e especulou que fosse
decodificação do `postgres.js`. **Estava errado.** Quatro medições fecham o
caso:

1. **Não é CPU.** `process.cpuUsage()` em volta da chamada acusa **0,76ms** de
   CPU para uma chamada de 40ms. Os outros 39ms são espera.
2. **Não é o Postgres.** O mesmo `select * from titles limit 20` rodado *dentro*
   do container responde em **0,8ms**; rodado do host, pela porta publicada,
   em **41,7ms** — e a partir da segunda chamada na mesma conexão, em 0,3ms.
   Isso com `psql`, que não tem uma linha de Node nem de `postgres.js`.
3. **Não é o loopback do host.** Um servidor TCP em Node mandando 60000 bytes
   para um cliente Node em `127.0.0.1`, sem podman no meio: **0,12ms**.
4. **O custo depende do recorte em pacotes, não do volume.** Pela porta
   publicada, `select repeat('x', N)` custa 41ms para N=30000, **0,56ms** para
   N=35000, 41ms para 40000 e 45000, 0,55ms para 50000. Não monotônico, e
   sempre ~40ms redondos quando aparece.

Quarenta milissegundos redondos, dependentes de fronteira de pacote e com a CPU
parada, são a assinatura do **ACK atrasado do Linux (40ms) encontrando o
algoritmo de Nagle** — aqui, no encaminhador de porta em espaço de usuário que o
podman rootless põe entre `localhost:5433` e o container. O `psql` paga uma vez
por conexão; o `postgres.js` paga **toda chamada**, mesmo com `max: 1` e a mesma
conexão reusada (medido: 20 chamadas seguidas, todas entre 81ms e 87ms, com o
servidor respondendo em 42ms — sobra constante de 38,3ms).

### O que isso muda

**Todo número medido por HTTP neste relatório carrega ~40ms que produção não
vai ter.** O p50 de 73,2ms é ~33ms de Watchlytics mais ~40ms de encaminhador. A
folga contra o gatilho de 200ms é, portanto, **maior** do que a tabela mostra —
o veredito não muda de sinal, fica mais confortável.

E **a conclusão que eu tinha tirado sobre o Redis estava invertida.** Eu havia
escrito que o cache de página atacaria "a fatia menor" porque dois terços do
tempo estariam depois do banco. Não estão: fora deste ambiente, a query do deck
é praticamente a resposta inteira. **Se um dia o gatilho do PLAN §4 for
atingido, o cache de página ataca exatamente a fatia certa.** O PLAN está certo
e eu estava errado.

A consequência menos óbvia: a vazão de ~92 req/s da tabela anterior também é
pessimista. Cada requisição segura uma conexão ~40ms a mais do que precisaria,
então o teto real desta máquina é mais alto — o que só aumenta a folga.

A parte que continua verdadeira é a barata: autenticação e recálculo do boost
somam menos de 2ms. Os dois `ponytail:` que preveem "some no dia em que aparecer
no perfil de latência" continuam dormindo com razão.

## Os planos

Sem filtro, conta com 400 swipes (9430 candidatos):

```
Limit  (actual time=34.527..34.532 rows=20)
  ->  Sort  (actual time=34.526..34.530 rows=20)
        Sort Method: top-N heapsort  Memory: 59kB
        ->  Hash Right Anti Join  (actual time=9.0..29.6 rows=9430)
              ->  Bitmap Heap Scan on swipes  (actual time=0.05..0.16 rows=400)
                    ->  Bitmap Index Scan on swipes_user_id_title_id_pk  (rows=400)
              ->  Hash  (rows=9830)
                    ->  Seq Scan on titles  (actual time=0.004..3.304 rows=9830)
              SubPlan 1 -> Aggregate (loops=9430)
Planning Time: 0.245 ms
Serialization: time=0.060 ms  output=15kB  format=text
Execution Time: 34.639 ms
```

Com filtro combinado, `Execution Time: 5.752 ms` — o `Seq Scan on titles` passa
a remover 8388 linhas pelo filtro e sobram 1435 candidatos para pontuar.

Duas leituras:

- **O índice de `swipes` está sendo usado** (`Bitmap Index Scan on
  swipes_user_id_title_id_pk`), que é o que o teste A6 exige. Ele continua
  válido com o catálogo real, não só com a fixture.
- **`titles` é varrida inteira quando não há filtro**, e o `SubPlan` do boost
  roda uma vez por candidato — 9430 vezes. É exatamente o teto que o `ponytail:`
  de `feedPage` já nomeia ("a subquery calcula o score de todo candidato antes
  de cortar... passando de ~50k títulos, materializar o top-N por score num CTE
  antes do boost é o próximo passo"). Com 9830 títulos isso custa 34ms e cabe.
  O comentário está certo e o gatilho dele ainda não chegou.

## Método, e o que a medição não prova

- **Banco:** cópia do banco de desenvolvimento (`createdb -T watchlytics
  wl_s4`), 9830 títulos, os mesmos do catálogo ingerido. Não houve ingestão
  nova: o catálogo real já estava no banco de dev, e copiar custa segundos
  contra as horas de um `npm run ingest`.
- **Contas:** 30 contas iguais por grupo, criadas em SQL com `birth_year` e
  `handle_chosen` preenchidos (sem isso o `/v1/feed` responde 403 e a medição
  mediria a porta). Cada uma com os mesmos 400 swipes sobre o topo do score,
  metade like e metade dislike. Várias contas porque `requireUserId` limita
  **120 req/min por conta** — com uma só, metade da amostra viraria 429.
- **Relógio:** `performance.now()` em volta do `fetch` inteiro, no cliente. O
  `responseTime` que o Fastify loga bate com ele (p50 75,8ms sobre 600
  requisições): em localhost o HTTP custa ~1ms, então o número do cliente é o
  número do servidor.
- **Máquina:** i7-10750H (12 threads), 15GB, Postgres 17.10 em podman com
  `shared_buffers` de 128MB, Node 25.4.0. **API, Postgres e o gerador de carga
  dividem a mesma máquina** — nos cenários concorrentes eles disputam CPU entre
  si, o que puxa a vazão medida para baixo.

O que esta medição **não** prova:

- **Não é produção.** Lá a API é uma máquina no Fly (`gru`, com auto-suspend) e
  o banco é Neon, do outro lado da rede. Aqui o banco está a um socket de
  distância, todos os buffers dão `shared hit`, e há os ~40ms do encaminhador do
  podman que produção não tem. Em compensação, a latência de rede até o Neon vai
  somar a cada uma das **três** idas ao banco por requisição — e essa conta não
  dá para fazer daqui.
- **Não mede o cold start.** É a lacuna que mais importa para o beta: com
  `min_machines_running = 0`, a primeira requisição depois da suspensão é o
  número que a pessoa vê ao abrir o link, e ele não é 81ms nem 33ms — é a
  máquina do Fly acordando. Medir isso exige produção, não bancada. **Enquanto
  ninguém medir, o "p95 do feed" deste relatório não é o que o primeiro
  convidado vai sentir.**
- **A vazão de ~92 req/s é desta máquina**, com o gerador de carga disputando
  CPU e cada requisição segurando a conexão 40ms a mais por causa do
  encaminhador. É um piso pessimista, não um dimensionamento.
- **O número de um mesmo cenário varia com o estado da máquina.** O mesmo
  `EXPLAIN` da query do deck deu 21,4ms durante as execuções do benchmark e
  42ms mais tarde, sem mudança nenhuma no banco ou na query. Compare execuções
  entre si, não contra números avulsos deste documento.

## Reproduzir

```bash
podman exec watchlytics-db createdb -U dev -T watchlytics wl_s4
# apps/api/.env: DATABASE_URL=...wl_s4  PORT=3003
cd apps/api && node --env-file-if-exists=.env src/server.ts &
node tools/feed-bench.mjs --conc 10     # e --conc 30 para o regime saturado
```

A ferramenta cria e apaga as contas de bancada sozinha (`bench-<marca>-*`, e
`users` cascateia para `swipes`). A última linha da saída é um JSON com todos os
números, para diffar entre execuções.
