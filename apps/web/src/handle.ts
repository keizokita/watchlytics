import {
  HANDLE_MIN,
  HANDLE_RESERVED,
  handleAvailability,
  handleInput,
  handleRegex,
  sessionUser,
  type SessionUser,
} from "@watchlytics/contract";
import { authedFetch } from "./session.ts";

/**
 * β8 — a decisão do handle, fora do componente.
 *
 * Separado do `HandleGate.tsx` pelo mesmo motivo do `ageGate.ts`: a suíte da
 * web roda em `node --test`, sem DOM, então lógica dentro do .tsx é lógica sem
 * teste. Aqui é módulo puro de validação e de fetch; o que sobra no .tsx é o
 * debounce e o foco, que só o navegador prova (o driver do run-watchlytics).
 *
 * As regras NÃO são reescritas aqui: `handleRegex`, `HANDLE_RESERVED` e
 * `handleInput` vêm do contrato, que é a mesma fonte que a api usa na borda.
 * Divergir significaria erro que só aparece depois de submeter.
 */

/** Busca em Set: a lista tem 18 nomes hoje e é consultada a cada tecla. */
const RESERVADOS = new Set<string>(HANDLE_RESERVED);

/**
 * O que dá para digitar e o que o handle é.
 *
 * `@` na frente porque o campo mostra um `@` de moldura e colar `@fulano`
 * é o gesto natural; minúscula porque é o que o contrato grava (`toLowerCase`),
 * e transformar é melhor que acusar de errado quem apertou Shift.
 */
export const normalizar = (raw: string) =>
  raw.trim().replace(/^@+/, "").toLowerCase();

export type HandleVerdict =
  /** Ainda não dá para julgar: vazio, ou no meio de um prefixo legal. */
  | { kind: "short" }
  /** Tem caractere que a regra não aceita, ou não começa com letra. */
  | { kind: "invalid" }
  /** Reservado. Decidido aqui, sem gastar requisição — a lista é do contrato. */
  | { kind: "unavailable" }
  | { kind: "ok"; handle: string };

/**
 * Julga o que está no campo AGORA, a cada tecla.
 *
 * "Curto" não é erro: quem digitou `ke` está no meio da palavra, e pintar erro
 * ali acusa o certo. Mas `1ke` já é erro na primeira tecla — o que está errado
 * não melhora digitando mais.
 */
export function validar(raw: string): HandleVerdict {
  const handle = normalizar(raw);

  if (handle.length < HANDLE_MIN) {
    // Prefixo legal do que a regra aceita: vazio, ou letra seguida do resto.
    const prefixo = handle === "" || /^[a-z][a-z0-9_]*$/.test(handle);
    return prefixo ? { kind: "short" } : { kind: "invalid" };
  }
  if (!handleRegex.test(handle)) return { kind: "invalid" };
  if (RESERVADOS.has(handle)) return { kind: "unavailable" };
  return { kind: "ok", handle };
}

/**
 * `desconhecido` não é "livre" nem "ocupado": é a rota não ter respondido.
 *
 * Cobre o 404 de propósito. A trilha A corre em paralelo e pode ainda não ter
 * publicado a rota — isso é o backend não ter chegado, e não um problema com o
 * handle que a pessoa escolheu. Cobre também o 429 do rate limit e a rede
 * caindo: nenhum deles é motivo para acusar quem está digitando.
 */
export type Disponibilidade = "livre" | "ocupado" | "desconhecido";

/**
 * Consulta a disponibilidade. Nunca lança, e nunca bloqueia o envio.
 *
 * É uma resposta ADIANTADA, não a decisão: quem decide é o `POST`, que resolve
 * a corrida entre duas pessoas escolhendo o mesmo handle no mesmo segundo. Por
 * isso todo desfecho ruim daqui vira `desconhecido` em vez de erro na tela — e
 * o detalhe vai para o console, que é onde quem depura procura (errors.ts).
 *
 * Quem faz o debounce é o componente: sem ele cada tecla vira uma requisição e
 * o rate limit da rota derruba justamente quem está digitando.
 */
export async function checarDisponibilidade(
  handle: string,
): Promise<Disponibilidade> {
  try {
    const res = await authedFetch(
      `/v1/auth/handle/available?handle=${encodeURIComponent(handle)}`,
    );
    if (!res.ok) {
      console.warn(`/v1/auth/handle/available respondeu ${res.status}`);
      return "desconhecido";
    }
    const body = handleAvailability.parse(await res.json());
    return body.available ? "livre" : "ocupado";
  } catch (e) {
    console.warn("a disponibilidade do handle não respondeu", e);
    return "desconhecido";
  }
}

export type Escolha =
  /** A sessão como o SERVIDOR a vê agora, com a porta já fechada. */
  | { kind: "ok"; user: SessionUser }
  /** Alguém chegou primeiro entre a consulta e o envio. */
  | { kind: "taken" }
  /** O contrato reprovou na borda. A tela não deixa chegar aqui. */
  | { kind: "invalid" };

/**
 * Grava a escolha. É definitiva: não há troca no v1.
 *
 * Falha de rede, de servidor e o 404 da rota que ainda não existe LANÇAM, e não
 * viram desfecho: é a convenção do resto da web (errors.ts), e quem chama pinta
 * `mensagem(e)` — genérico para a pessoa, detalhado no console. Transformar um
 * 404 em "esse handle não serve" culparia a pessoa pela trilha A não ter
 * chegado.
 *
 * Só o 409 é lido como tomado — é o que a rota responde tanto para o handle já
 * ocupado quanto para a conta que já escolheu uma vez.
 *
 * A resposta é o `sessionUser` inteiro, e é ele que volta para a sessão local.
 * Remontar `{ ...user, handle, needsHandle: false }` aqui daria o mesmo
 * resultado hoje e seria uma segunda verdade sobre quem está logado: quem sabe
 * o que ficou gravado é o servidor, e ele está dizendo.
 */
export async function escolherHandle(raw: string): Promise<Escolha> {
  const parsed = handleInput.safeParse({ handle: normalizar(raw) });
  if (!parsed.success) return { kind: "invalid" };

  const res = await authedFetch("/v1/auth/handle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parsed.data),
  });
  if (res.status === 409) return { kind: "taken" };
  if (!res.ok) throw new Error(`/v1/auth/handle respondeu ${res.status}`);
  return { kind: "ok", user: sessionUser.parse(await res.json()) };
}
