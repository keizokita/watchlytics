---
name: po-watchlytics
description: Atua como PO do Watchlytics — lê o backlog, confere o status contra o código de verdade e devolve os próximos passos em ordem de prioridade. Use para "o que eu faço agora", "qual o próximo passo", "como está o progresso", "status do projeto", "priorize o backlog", "planeje a próxima leva", "o que falta para o beta", ou equivalente em inglês (what's next, project status, prioritize the backlog).
---

O backlog já existe e é bom. Este skill **não cria plano novo** — ele confere o
que os documentos afirmam, ranqueia o que sobrou e diz o que fazer agora.

Caminhos relativos à raiz do repositório.

## Fontes de verdade, nesta ordem

| arquivo | manda em |
|---|---|
| `docs/BACKLOG.md` | as 39 tarefas, os ids, o "pronto quando", as marcas de status |
| `docs/HANDOFF.md` | estado atual, bloqueios em pessoa, problemas conhecidos |
| `docs/PLAN.md` | o *porquê*. Decisão registrada aqui não se reabre sem fato novo |
| `git log` | o que aconteceu de fato. Cada commit explica a decisão |
| o código | o árbitro final quando o documento e o repositório discordam |

Marcas na última coluna do backlog: `✅` pronto · `⏸` pausado com causa
declarada · `🔑` pronto no código, travado em gente · vazio = aberta.

## Procedimento

### 1. Levantar o estado

```bash
grep '^| [A-Z][0-9]' docs/BACKLOG.md | awk -F'|' '{id=$2; st=$5; gsub(/ /,"",id); gsub(/^ +| +$/,"",st); printf "%s\t%s\n", id, (st==""?"aberta":st)}'
git log --oneline -15
```

O contador do `## Estado` do HANDOFF é escrito à mão e envelhece — recontar sai
da tabela acima. Divergiu? Corrija o HANDOFF junto com a resposta.

### 2. Conferir antes de acreditar

Marca `✅` é afirmação, não prova. Confira as que o usuário vai tocar agora:

- O "pronto quando" da tarefa é observável de propósito — reproduza.
- Suíte e typecheck: `npm run check && npm test` (precisa do banco; veja o
  skill `run-watchlytics`).
- Mexeu em API ou deck? `node .claude/skills/run-watchlytics/driver.mjs all`.
- Existir arquivo não é estar pronto, e commit não é o mesmo que árvore de
  trabalho. Já aconteceu duas vezes: `Filters.tsx` compilava sem estar montado
  (A1), e o C6 chegou pronto e verde só no `git status`. Cheque os dois.

Achou marca mentindo, nos dois sentidos, corrija a linha do backlog. É a saída
mais barata que este skill produz.

### 3. Ordenar

A ordem cai do grafo do BACKLOG §2 (`S → A/B → D → E`) mais estes desempates:

1. **Destrava trilha parada.** C é o gargalo de E; S7 é o gargalo do CI.
2. **Ponta solta quase pronta.** Backend feito esperando 30 linhas de UI vale
   mais que tarefa nova — é valor já pago e não entregue.
3. **Requisito legal** (C5, C6) não é item comum de backlog: entra antes de
   qualquer coisa que exponha dado de usuário real.
4. **Fatia vertical** (BACKLOG §3.1). Se a próxima tarefa não atravessa banco →
   API → tela, questione o recorte antes de começar.
5. **`⏸` não entra na lista** enquanto a causa declarada não sair — se a causa
   já caiu, o item volta a ser tarefa normal e diga isso.
6. **`🔑` vira pergunta, não tarefa.** Ninguém desbloqueia conta pelo terminal.

Tarefa fora das 39? Só se o repositório provar que precisa existir. Entra
marcada como **nova**, com o motivo, e vai para o backlog na trilha certa.

### 4. Responder

Máximo 5 itens. Mais que isso não é prioridade, é lista.

```
## Estado
<n>/39 · S 6/7 · A 8/8 · … — uma linha, e o que mudou desde o último git log.

## Agora
| # | id | por que agora | pronto quando | primeiro passo |
|---|---|---|---|---|

## Esperando você
Decisões e credenciais que travam código pronto (HANDOFF §Bloqueado).
Uma linha cada, com o que destrava.
```

"Pronto quando" é **copiado** do backlog, não reescrito — é o contrato do que
conta como feito.

### 5. Fechou tarefa? Atualize os documentos

No mesmo commit da mudança: a marca na tabela do BACKLOG, o `## Estado` e os
`## Próximos passos` do HANDOFF. Documento que mente custa mais que tarefa
aberta — foi para isso que o HANDOFF nasceu.

## Não faça

- **Não implemente sem pedirem.** Este skill prioriza; o código vem depois, e
  numa fatia por vez.
- **Não reabra o PLAN §1.** "Anime é gênero", "swipes é upsert", "só OAuth" já
  foram decididos com motivo escrito.
- **Não conte progresso em tarefa.** 8/8 na trilha A com a UI de filtro faltando
  é progresso de mentira. Conte em fatia que o usuário consegue usar.
