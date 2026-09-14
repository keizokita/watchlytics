# Cold start em produção — medição de 2026-09-14

O relatório do feed ([feed-bench.md](./feed-bench.md)) deixou uma lacuna
nomeada: *"enquanto ninguém medir, o p95 deste relatório não é o que o primeiro
convidado vai sentir"*. Isto mede essa lacuna — parcialmente, e a parte que
falta está nomeada no fim.

Produção medida: `main` em **`7db225c`** (merge do #67). O commit é inferido do
`origin/main`, não lido da máquina.

**Veredito: a máquina suspende, e retomar dela custa 0,42s a 0,57s. O proxy do
Fly SEGURA a requisição — não houve um único 5xx.** A pessoa que abre o link com
a máquina dormindo espera meio segundo e não vê erro nenhum.

**Mas isso cobre um dos dois caminhos.** `suspend → resume` foi medido;
`stopped → start`, que é o boot de verdade, não. Ver §"O que falta".

## O que foi medido

Dois eventos frios, cada um com a suspensão **confirmada no log de eventos do
Fly**, não deduzida da latência.

| evento | dormiu | primeira resposta | com a máquina de pé | respostas ruins |
|---|---|---|---|---|
| 1 | ~7min (recém-suspensa) | **0,42s** | 0,04s | 0 |
| 2 | 7min17s | **0,57s** | 0,04s | 0 |

Durante a subida, uma sonda a cada 250ms — o visitante impaciente recarregando.
Nenhuma delas pegou 5xx, PM11 ou timeout. Todas receberam 401 da aplicação, que
é a resposta correta para `/v1/auth/me` sem token e prova que a requisição
atravessou o proxy e chegou no Fastify.

### O ciclo completo, pelo log do Fly

```
04:50:44.640  started     start       flyd    ← a sonda do evento 1 acorda
04:58:17.693  started     cordon      proxy   ← 7min33s depois, começa a fechar
04:58:27.812  suspending  suspension  proxy
04:58:28.780  suspended   suspension  flyd
05:05:45.192  starting    start       proxy   ← a sonda do evento 2 acorda
05:05:45.322  started     start       flyd
```

Três números que saem daí:

- **Ociosidade até suspender: ~7min33s** (`start` 04:50:44 → `cordon` 04:58:17).
  O comentário do `Login.tsx` fala em *"meio minuto de ociosidade"* — isso não
  vale hoje, e é uma ordem de grandeza de diferença.
- **Retomada dentro do Fly: 130ms** (`starting` 05:05:45.192 → `started`
  05:05:45.322). O resto dos 0,57s medidos é DNS, TLS e a viagem até `gru`.
- **Quem inicia é o `proxy`**, não um agendador: ele recebeu a requisição,
  mandou subir e segurou a conexão até a aplicação responder. É por isso que o
  visitante não vê erro.

O `~6s de boot` prometido pelo `fly.toml` não descreve este caminho. Retomar de
suspensão restaura um snapshot de memória; não é dar boot.

## O que falta, e o que custaria

`auto_stop_machines = "suspend"` produz `suspend → resume`. Mas uma máquina pode
estar **parada** em vez de suspensa — depois de um deploy, ou se o Fly converter
suspenso em parado por tempo ou pressão do host. Aí a primeira requisição paga
boot de verdade, e é plausível que seja lá que o PM11 histórico nasceu (o
`0f37532`, que criou o retry de 8s do `Login.tsx` depois de um login perdido).

Essa reconstrução **não exige** que o comportamento do Fly tenha mudado, e por
isso é mais provável que a alternativa. Mas é reconstrução, não registro:
ninguém tem o log daquele dia.

O cenário do beta é justamente esse — ninguém usa das 23h às 9h, e a primeira
pessoa da manhã abre o link. Dez horas não são os sete minutos medidos aqui.

Três formas de fechar a lacuna, **em ordem de custo**:

1. **Esperar o próximo deploy — custo zero, e vai acontecer sozinho.**
   `on: push: branches: [main]` implanta a cada merge, e deploy substitui
   máquina: é `start`, não `resume`. Quem estiver olhando o log quando rodar vê
   o caminho que falta, e a primeira requisição depois dele é a medição.
2. **Olhar o log na primeira manhã — custo zero, janela curta.** Depois de uma
   noite sem tráfego, um `flyctl machines list -a watchlytics-api --json` logo
   após a primeira requisição ainda carrega o que aconteceu de madrugada.
   **A janela é curta porque o log guarda exatamente 5 eventos** — qualquer
   atividade empurra os antigos para fora. Não adianta olhar à tarde.
3. **`flyctl machine stop` e sondar — custo: produzir o defeito em quem abrir o
   link naquele instante.** É a única forma de provocar na hora, e é ação
   destrutiva contra produção. Decisão do usuário, não de quem mede.

## O que o cliente faz quando a API não responde

Isto é leitura de código e não depende da medição.

O `fly.toml` afirma *"o cliente retenta em 5xx, o que cobre o caso"*. É verdade
**para um caminho só**: `Login.tsx:108-111` retenta `POST
/v1/auth/oauth/google` uma vez, depois de `COLD_START_MS = 8000`. Foi escrito
para o `code` de uso único do Google e cobre o que se propôs a cobrir.

Todo o resto do app passa por `authedFetch` (`session.ts:64-74`), que retenta
**só em 401**, para renovar o access. Em 5xx ele devolve a resposta a quem
chamou. O proxy do Pages (`functions/_proxy.js`) é repasse puro.

Disso sai um caminho que o comentário do `fly.toml` não cobre:

> **O boot trata "servidor indisponível" e "você não tem sessão" como a mesma
> coisa.** A pessoa que TEM sessão válida no cookie vê que foi deslogada, sem
> erro e sem aviso.

São **três portas**, não uma — quem consertar só a primeira fecha um terço:

- `session.ts:39` — `if (!res.ok) return false`: 503 é `!ok` como 401.
- `session.ts:44` — o `catch`: API fora do ar, sem resposta nenhuma, vira
  `false` igual.
- `Login.tsx:131` — `me.ok ? … : null`: 503 no `/v1/auth/me` manda para a
  entrada mesmo com o refresh tendo dado certo.

**`authedFetch` não está afetado**, e a primeira versão deste relatório
sugeria que estivesse: ele só chama `refreshAccess` quando a resposta é
exatamente 401 (`session.ts:72`), então um 503 sai por ali direto, sem passar
pelo refresh. O estrago é do `resume()`, no boot — que é o caso descrito, mas o
alcance é menor do que "todo o app". Correção da sessão que revisou.

**Nenhuma verificação que existe hoje pega isso.** A tela deslogada já produz
401 em `/v1/auth/refresh` por definição — é o estado normal de quem não tem
sessão. Então "fui deslogado por engano" é byte a byte igual a "não tenho
sessão": mesma tela, mesmo console, mesma asserção verde. O `driver.mjs` não
passa por ali porque planta sessão.

**Nesta medição o gatilho nunca apareceu:** nas duas janelas frias, 9 sondas,
**todas 401** — nenhum 5xx, nenhum timeout, nenhum erro de rede. Procurei o
disparo por 5xx e não achei, e continua sem observação até hoje.

**O gatilho existe, e está em outro lugar.** A revisão desta trilha reproduziu o
mesmo sintoma com **429**, não 5xx: `/v1/auth/refresh` passa pelo `limitByIp`
(`routes/auth.ts:516`), teto de 20/min, e 429 é `!res.ok` como qualquer outro —
`driver all` duas vezes seguidas desloga. Vale registrar por que isso importa
para quem lê uma medição: eu tinha descartado o cold start como gatilho, o que
poderia ter arquivado o caso; o que a medição descartou foi **um** gatilho, não
o defeito. Sem ela, a correção teria sido publicada como "cold start desloga",
que é falso.

A única observação histórica do caminho que eu procurava é o PM11 que gerou o
`0f37532`, e ela veio do `stopped → start`, que esta medição não cobre.

Com o proxy segurando a requisição, **cold start não é mais o gatilho
frequente** desse defeito. Mas ele continua alcançável por 5xx de qualquer
origem — uma piscada do Neon, a janela de troca de máquina num deploy, o Fly
reiniciando por conta. A frequência cai de previsível para eventual; a
existência não muda. Eventual, num beta de duas semanas com trinta pessoas, não
é zero.

O conserto não é acrescentar retentativa: é `refreshAccess` parar de colapsar as
duas condições numa resposta só. Só uma delas justifica mandar a pessoa para a
tela de entrada. **`apps/web/src/session.ts` é território web — esta trilha
levanta o caso, não o conserta.**

O teste que prova isso não precisa de produção nem de cold start: um stub
devolvendo 503 em `/v1/auth/refresh` e a asserção de que a sessão sobrevive.
Fica verde para sempre, independente do que o Fly faça.

## Nota de método: o erro que esta medição quase publicou

A primeira versão desta ferramenta decidia "estava fria" pela latência da
primeira resposta. Com a retomada custando 0,42s e o `fly.toml` prometendo
"~6s", ela imprimiu **"estava quente"** para uma máquina que estava suspensa — e
daí saiu, por escrito e mandada a outra sessão, a conclusão de que a máquina não
suspendia e de que o `min_machines_running = 0` era inerte. O log do Fly
desmentiu.

Pior que isso: com dois eventos frios medidos e nenhum 5xx, a conclusão natural
seria **"o retry de 8s do `Login.tsx` cobre um caso que não acontece, dá para
remover"**. Essa recomendação teria passado em qualquer revisão que conferisse o
número, porque o número está certo. O que estava errado era o escopo do que ele
mede: `resume` não é `start`, e o retry existe por causa de um incidente real no
outro caminho.

É a terceira vez no mesmo par de trilhas que a forma se repete — a coisa medida
não é a coisa que a afirmação promete (ver o `EXPLAIN` sobre fixture de 94, e os
40ms do encaminhador do podman em [feed-bench.md](./feed-bench.md)). A diferença
é que aqui a afirmação teria mandado apagar código de proteção.

A ferramenta não tenta mais adivinhar: ela imprime os tempos e manda conferir o
log, que é a única fonte que sabe.

## Reproduzir

```bash
node tools/cold-start.mjs --idle 900
flyctl machines list -a watchlytics-api --json   # o `start` prova que estava fria
```

Leitura apenas: nenhum deploy, nada tocado no `fly.toml`, `min_machines_running`
intocado. Subir para 1 custa dinheiro e é decisão do usuário — e, pelo que está
medido aqui, hoje não se justifica pela espera: meio segundo não é o que dói.

**Requer silêncio de verdade.** Qualquer requisição de outra sessão à API ou ao
Pages reinicia o relógio de ociosidade, e a medição sai descrevendo o tráfego de
quem passou por ali. Uma janela foi descartada por isso nesta medição. Combine
antes, e pergunte **quem já tocou produção nos últimos dez minutos** — silêncio
prometido não conserta janela já corrida.
