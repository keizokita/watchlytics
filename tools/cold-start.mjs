#!/usr/bin/env node
/**
 * cold-start — mede o que a primeira pessoa vê quando a máquina do Fly está
 * suspensa.
 *
 * O `fly.toml` tem `min_machines_running = 0` com `auto_stop_machines =
 * "suspend"`, e o comentário lá afirma três coisas que nunca foram medidas:
 * que o boot cobra "~6s", que o proxy responde 5xx enquanto a máquina sobe, e
 * que "o cliente retenta em 5xx, o que cobre o caso". O `Login.tsx` espera
 * `COLD_START_MS = 8000` antes da segunda tentativa — um número que também é
 * suposição até alguém medir.
 *
 * SÓ LEITURA. Não faz deploy, não toca no `fly.toml`, não muda
 * `min_machines_running`. Subir para 1 custa dinheiro e é decisão do usuário.
 *
 *   node tools/cold-start.mjs --idle 30,120,300,600
 *
 * Cada período de ociosidade é um evento frio próprio: a sonda acorda a
 * máquina, então medir "suspende depois de quanto tempo?" exige esperar de
 * novo do zero a cada ponto.
 *
 * A rota sondada é `/v1/auth/me` sem token. Ela responde 401 vindo da
 * aplicação, então 401 prova que a requisição ATRAVESSOU o proxy e chegou no
 * Fastify — que é o que distingue "máquina de pé" de "proxy respondendo
 * sozinho". Qualquer outra coisa (5xx, timeout, corpo do Fly) é a subida.
 */
const arg = (nome, padrao) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
};

const PROXY = arg("proxy", "https://watchlytics.pages.dev");
const DIRETO = arg("api", "https://watchlytics-api.fly.dev");
const ROTA = arg("rota", "/v1/auth/me");
const IDLE = arg("idle", "30,120,300,600").split(",").map(Number);
/** Quanto tempo seguir sondando depois de acordar a máquina. */
const JANELA_MS = Number(arg("janela", 40000));
/** Intervalo entre sondas durante a subida — o que o visitante veria se
 *  recarregasse. 250ms dá resolução sem virar carga. */
const PASSO_MS = Number(arg("passo", 250));

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const agora = () => performance.now();

/**
 * Uma sonda. Devolve status e tempo; erro de rede vira status 0 com o nome,
 * porque "a conexão morreu" é uma resposta ao visitante tanto quanto um 502.
 */
async function sondar(url) {
  const t0 = agora();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    const corpo = await res.text();
    return {
      ms: agora() - t0,
      status: res.status,
      fly: res.headers.get("fly-request-id") ? "fly" : "",
      // O Fly devolve o erro do proxy em texto; guardo um trecho porque é
      // literalmente o que a pessoa veria se abrisse o link.
      trecho: res.ok || res.status === 401 ? "" : corpo.trim().slice(0, 120),
    };
  } catch (e) {
    return { ms: agora() - t0, status: 0, fly: "", trecho: String(e.name ?? e) };
  }
}

/** 401 da aplicação é o sinal de "chegou no Fastify". */
const chegou = (r) => r.status === 401;

/**
 * Um evento frio: espera `idleS` sem tocar em nada, depois dispara a sonda que
 * ACORDA e, em paralelo, uma sequência de sondas a cada `PASSO_MS` — que é o
 * visitante recarregando enquanto espera.
 */
async function evento(idleS) {
  process.stderr.write(`\n[${new Date().toISOString()}] ocioso por ${idleS}s…\n`);
  await dormir(idleS * 1000);

  const t0 = agora();
  const linhas = [];
  const registrar = (alvo, r) =>
    linhas.push({ t: agora() - t0, alvo, ...r });

  // A primeira sonda de cada alvo sai junto: uma delas acorda a máquina, e as
  // duas veem a subida a partir do mesmo instante.
  const despertar = [
    sondar(PROXY + ROTA).then((r) => registrar("proxy", r)),
    sondar(DIRETO + ROTA).then((r) => registrar("direto", r)),
  ];

  // Enquanto isso, o visitante impaciente.
  const repetidas = (async () => {
    while (agora() - t0 < JANELA_MS) {
      await dormir(PASSO_MS);
      registrar("proxy(recarga)", await sondar(PROXY + ROTA));
      if (linhas.filter(chegou).length >= 3) break;
    }
  })();

  await Promise.all([...despertar, repetidas]);
  linhas.sort((a, b) => a.t - b.t);

  const primeiraOk = linhas.find(chegou);
  const ruins = linhas.filter((r) => !chegou(r));
  const segunda = await sondar(PROXY + ROTA); // máquina já de pé

  return { idleS, linhas, primeiraOk, ruins, segunda };
}

const ms = (x) => `${(x / 1000).toFixed(2)}s`;

for (const idleS of IDLE) {
  const e = await evento(idleS);

  // NÃO adivinhe "estava fria" pela latência. A primeira versão desta
  // ferramenta fazia isso e errou: retomar de suspensão custou 0,42s, a
  // heurística leu como "quente", e daí saiu a conclusão falsa de que a
  // máquina não tinha suspendido. Só o log do Fly sabe, e ele é leitura:
  //   flyctl machines list -a watchlytics-api --json
  // O `start` com timestamp igual ao da sonda é a prova de que estava fria.
  console.log(`\n══ ocioso ${idleS}s`);
  for (const l of e.linhas) {
    console.log(
      `   t+${ms(l.t).padStart(6)}  ${l.alvo.padEnd(14)} ` +
        `http=${String(l.status).padStart(3)}  ${ms(l.ms).padStart(6)}` +
        (l.trecho ? `  «${l.trecho}»` : ""),
    );
  }
  if (e.primeiraOk) {
    console.log(
      `   → primeira resposta da aplicação em ${ms(e.primeiraOk.t)} ` +
        `(${e.ruins.length} respostas ruins antes)`,
    );
  } else {
    console.log(`   → a aplicação NÃO respondeu dentro de ${ms(JANELA_MS)}`);
  }
  console.log(`   → com a máquina de pé: http=${e.segunda.status} ${ms(e.segunda.ms)}`);
  console.log(
    `   → confira se ela ESTAVA suspensa: \`flyctl machines list -a watchlytics-api --json\`` +
      ` deve trazer um \`start\` com timestamp deste evento.`,
  );
}
