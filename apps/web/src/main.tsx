import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  feedResponse,
  type FeedResponse,
  type Title,
} from "@watchlytics/contract";
import { AgeGate, AgeGateRecusa, recusaDaPorta } from "./AgeGate.tsx";
import { Alerta } from "./Alerta.tsx";
import { Deck } from "./Deck.tsx";
import { Filters, toParams, type FeedFilters } from "./Filters.tsx";
import { Friends, NotificationsBadge } from "./Friends.tsx";
import { Library } from "./Library.tsx";
import { Login, useSession } from "./Login.tsx";
import { authedFetch } from "./session.ts";
import { Onboarding } from "./Onboarding.tsx";
import { drop, enqueue, startFlushing } from "./swipeQueue.ts";
import { mensagem } from "./errors.ts";
import { FEEDBACK_URL, t } from "./strings.ts";

/** Busca mais cards quando restam estes: o swipe não pode esperar rede. */
const REFILL_AT = 5;

/**
 * Espera antes de reabrir o feed quando a resposta veio velha. Casa com o
 * FLUSH_MS de swipeQueue.ts: é o tempo que os últimos swipes levam para sair
 * da fila local e chegar ao servidor.
 */
const STALE_RETRY_MS = 3500;

async function fetchFeed(
  filters: FeedFilters,
  cursor: string | null,
  recycle: boolean,
): Promise<FeedResponse> {
  const p = toParams(filters);
  if (cursor) p.set("cursor", cursor);
  // `recycle` é z.stringbool no contrato — vai como string, não como boolean.
  if (recycle) p.set("recycle", "true");
  const res = await authedFetch(`/v1/feed?${p}`);
  if (!res.ok) throw new Error(`feed respondeu ${res.status}`);
  return feedResponse.parse(await res.json());
}

function App() {
  const [filters, setFilters] = useState<FeedFilters>({});
  /** Degrau 2 da escada: o usuário aceitou rever o que já descartou. */
  const [recycle, setRecycle] = useState(false);
  const [queue, setQueue] = useState<Title[]>([]);
  /** O que o servidor afrouxou para não devolver deck vazio (A5). */
  const [relaxed, setRelaxed] = useState<string[]>([]);
  /** Sobe quando uma página volta com tudo que esta sessão já decidiu. */
  const [stale, setStale] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  /** B7 — só o último. Pilha maior é confusa e ninguém pediu. */
  const [undoable, setUndoable] = useState<Title | null>(null);

  /**
   * Já decididos nesta sessão. O servidor filtra pelo que está gravado, mas a
   * primeira página de um recorte novo pode sair antes de o POST chegar.
   */
  const decided = useRef(new Set<string>());
  const loading = useRef(false);
  /** Próxima página. `null` depois de uma resposta = o servidor não tem mais. */
  const cursor = useRef<string | null>(null);
  const end = useRef(false);
  /** Sobe a cada recorte novo: descarta resposta de filtro antigo ainda em voo. */
  const gen = useRef(0);

  const more = useCallback(async () => {
    if (loading.current || end.current) return;
    loading.current = true;
    const mine = gen.current;
    try {
      const page = await fetchFeed(filters, cursor.current, recycle);
      if (mine !== gen.current) return; // o recorte mudou; esta página é lixo
      cursor.current = page.nextCursor;
      end.current = page.nextCursor === null;
      const fresh = page.items.filter((i) => !decided.current.has(i.id));
      setRelaxed(page.relaxed ?? []);
      setQueue((q) => [...q, ...fresh]);
      // Página inteira já decidida nesta sessão: o servidor ainda não recebeu
      // os últimos swipes. A resposta não vale como fim de feed — marca para
      // reabrir depois do flush, senão a tela para no degrau errado.
      if (page.items.length > 0 && fresh.length === 0) setStale((n) => n + 1);
      setError(null);
    } catch (e) {
      if (mine === gen.current) {
        setError(mensagem(e));
      }
    } finally {
      if (mine === gen.current) {
        loading.current = false;
        setReady(true);
      }
    }
  }, [filters, recycle]);

  useEffect(() => {
    startFlushing();
  }, []);

  /**
   * Recorte novo é feed novo: cursor e fila do anterior não valem mais. A
   * semente do ruído viaja dentro do cursor, então reaproveitá-lo depois de
   * mudar o filtro traria a página seguinte do recorte antigo.
   *
   * ponytail: sem debounce — digitar um ano dispara uma busca por tecla. Vira
   * problema quando o cálculo de peso por gênero doer, não antes.
   */
  useEffect(() => {
    gen.current++;
    cursor.current = null;
    end.current = false;
    loading.current = false;
    // Reciclar é pedir de volta o que esta sessão já decidiu — a memória local
    // que evita o título reaparecer é justamente o que atrapalha aqui.
    if (recycle) decided.current.clear();
    setQueue([]);
    setRelaxed([]);
    setReady(false);
    void more();
  }, [more, recycle]);

  /**
   * Fim da paginação com a fila vazia: reabre o feed.
   *
   * A escada de degradação só responde a uma requisição que volta vazia, e a
   * última ainda trouxe itens — sem reabrir, a tela para no aviso da página
   * anterior e o degrau ("rever os descartados", "acabou") nunca chega.
   *
   * Para sozinho: a resposta vazia é a definitiva, não mexe em `stale` nem em
   * `queue.length`, e sem dependência nova o efeito não reentra. Só rearma
   * enquanto o servidor estiver atrasado em relação à fila de swipes.
   */
  useEffect(() => {
    if (!ready || error || queue.length > 0 || !end.current) return;
    const id = setTimeout(
      () => {
        cursor.current = null;
        end.current = false;
        void more();
      },
      stale ? STALE_RETRY_MS : 0,
    );
    return () => clearTimeout(id);
  }, [ready, error, queue.length, stale, more]);

  const onDecide = useCallback(
    (title: Title, direction: 1 | -1) => {
      decided.current.add(title.id);
      setUndoable(title);
      setQueue((q) => {
        const rest = q.filter((i) => i.id !== title.id);
        if (rest.length <= REFILL_AT) void more();
        return rest;
      });

      // Vai para a fila durável, não direto para a rede: o card já saiu da
      // tela e o swipe não pode depender de a requisição dar certo.
      enqueue({
        titleId: title.id,
        direction,
        clientTs: new Date().toISOString(),
      });
    },
    [more],
  );

  const onUndo = useCallback(() => {
    const title = undoable;
    if (!title) return;

    setUndoable(null);
    decided.current.delete(title.id);
    setQueue((q) => (q.some((i) => i.id === title.id) ? q : [title, ...q]));
    setRelaxed([]);

    // Se ainda estava na fila local, o undo não precisa da rede.
    if (!drop(title.id)) {
      void authedFetch(`/v1/swipes/${title.id}`, {
        method: "DELETE",
      }).catch(
        (e: unknown) => console.error("undo não chegou ao servidor", e),
      );
    }
  }, [undoable]);

  /** Só os degraus que nomeiam um filtro; os outros têm mensagem própria. */
  const loosened = relaxed.flatMap((r) => t.relaxedNames[r] ?? []);
  const offer = relaxed.includes("recycle-offer");

  return (
    <>
      <Filters
        value={filters}
        onChange={(next) => {
          setFilters(next);
          // A oferta de reciclagem valia para o recorte anterior.
          setRecycle(false);
        }}
      />

      {loosened.length > 0 && (
        <p className="notice">{t.relaxedBanner(loosened)}</p>
      )}
      {relaxed.includes("dislikes") && <p className="notice">{t.recycled}</p>}

      {error ? (
        // `foco`: este painel nasce no lugar do deck, e com ele somem os
        // botões Pass/Undo/Like — inclusive o que estava com o foco.
        <Alerta className="notice deck-slot error" foco>
          <p>{error}</p>
          <button type="button" className="link" onClick={() => void more()}>
            {t.retry}
          </button>
        </Alerta>
      ) : !ready ? (
        <p className="notice deck-slot loading">{t.loading}</p>
      ) : queue.length === 0 ? (
        <div className="notice deck-slot empty">
          <p>{offer ? t.recycleOffer : t.exhausted}</p>
          {offer ? (
            <button
              type="button"
              className="link"
              onClick={() => setRecycle(true)}
            >
              {t.recycleAction}
            </button>
          ) : (
            <p className="notice-hint">{t.exhaustedHint}</p>
          )}
          {undoable && (
            <button type="button" className="link" onClick={onUndo}>
              {t.undo}
            </button>
          )}
        </div>
      ) : (
        <Deck
          items={queue}
          onDecide={onDecide}
          onUndo={onUndo}
          canUndo={undoable !== null}
        />
      )}
    </>
  );
}

/**
 * D4 — o deck só abre depois do onboarding, e é o `Onboarding` que decide:
 * ele consulta a rota na montagem e chama `onDone` na hora se já cumpriu. Um
 * componente só, uma requisição só — o App nem monta antes disso, então o
 * feed não é buscado durante os 20 swipes de entrada.
 *
 * ponytail: o portão é do deck, não do shell. As outras telas continuam
 * alcançáveis pela nav durante o onboarding; travar a navegação inteira é
 * decisão de produto, não de código.
 */
function Home() {
  const [onboarded, setOnboarded] = useState(false);
  return onboarded ? (
    <App />
  ) : (
    <Onboarding onDone={() => setOnboarded(true)} />
  );
}

/**
 * Navegação pelo hash — duas telas não pagam um router.
 *
 * ponytail: vira react-router na terceira rota, ou na primeira que precisar de
 * parâmetro de caminho (o perfil público de D5 já precisa).
 */
/**
 * Porta de entrada de quem ainda não logou.
 *
 * Existe porque sem ela o shell montava o app inteiro sem sessão: Onboarding,
 * Library e Friends disparavam chamadas autenticadas, todas voltavam 401 — o
 * certo, do lado da api — e o cliente pintava o primeiro 401 como erro fatal.
 * Um visitante novo via um card vermelho em vez de um convite.
 */
function SignedOut() {
  return (
    <div className="signed-out">
      <style>{`
        .signed-out { max-width: 32rem; text-align: center; display: grid; gap: 0.75rem; }
        .signed-out h1 { margin: 0; font-size: 1.6rem; line-height: 1.2; }
        .signed-out p { margin: 0; color: var(--muted); line-height: 1.5; }
      `}</style>
      <h1>{t.signedOutTitle}</h1>
      <p>{t.signedOutBody}</p>
    </div>
  );
}

function Root() {
  const user = useSession();
  const [hash, setHash] = useState(() => location.hash);

  useEffect(() => {
    const onHash = () => setHash(location.hash);
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const inLibrary = hash.startsWith("#/library");
  const inFriends = hash.startsWith("#/friends");
  /**
   * Recusado na porta de idade: a conta foi apagada e a sessão local, jogada
   * fora. O shell é quem pinta o aviso, porque ele é a única parte que
   * sobrevive a não haver mais usuário nenhum.
   */
  const recusa = recusaDaPorta();

  return (
    <div className="shell">
      <style>{`
        /* Flex, não grid: o alinhamento vertical aqui é feito por margem auto,
           e margem auto de item de grid centraliza dentro da própria faixa em
           vez de disputar a folga da coluna inteira.

           A folga sobra em janela alta de desktop. Quem a consome são as duas
           margens auto abaixo: sem elas o shell inteiro flutuava no meio da
           página (ver o comentário do body no index.html). */
        .shell {
          display: flex; flex-direction: column; align-items: center;
          gap: 1.25rem;
          /* o item de grid do body já estica; isto é o piso quando não estica */
          min-height: 100%;
          /* Largura explícita porque o justify-items do body deixa este item
             shrink-to-fit: sem isto, um filho com width 100% resolve contra o
             CONTEÚDO do shell — ou seja, contra o próprio elemento que está
             vazando — e não contra a tela. Era por isso que a tela de amigos
             cortava a aba "Alerts" em 360px. Os filhos seguem centralizados
             pelo align-items acima. */
          width: 100%;
        }
        /* Rodapé no fim da página em toda tela. Sozinha, esta margem já põe o
           conteúdo no topo: toda a folga vai para cima da atribuição. */
        .shell .attribution { margin-top: auto; }
        .shell nav { display: flex; gap: 0.5rem; }
        /* Ver o comentário do <main> abaixo: marco na árvore, nada no layout. */
        .shell main { display: contents; }
        /* Deslogada, a nav é só o botão de entrar, e ele tem que vir DEPOIS do
           que explica o app — senão a pessoa lê o call-to-action antes de
           saber para o que está entrando. */
        .shell nav.below { order: 2; }
        /* --tap, e não a altura que o padding der: os links da nav eram os
           únicos alvos interativos do app abaixo do piso de 44px que o resto
           respeita (medidos em 34px de altura na auditoria). Passam o mínimo
           AA de 24x24 da WCAG 2.5.8, mas são o controle mais usado da tela, e
           a régua aqui é a do app. Os 10px que isto acrescenta entram na
           --deck-reserve. */
        .shell nav a {
          display: inline-flex; align-items: center;
          min-height: var(--tap);
          padding: 0.4rem 0.9rem; border-radius: var(--r-pill); text-decoration: none;
          color: var(--muted); font-size: 0.9rem; font-weight: 600;
        }
        .shell nav a[aria-current="page"] {
          color: var(--fg); background: var(--surface);
        }
        .shell .attribution {
          order: 3;
          max-width: 26rem;
          text-align: center;
          font-size: 0.75rem;
          line-height: 1.4;
        }
        .shell .attribution a { color: var(--muted); text-decoration: none; }
        /* Em linha própria e com folga: colado na atribuição do TMDB, o convite
           lia como a primeira frase do texto legal, e ninguém clica em texto
           legal. */
        .shell .attribution .feedback {
          display: block; margin-bottom: 0.6rem; text-decoration: underline;
        }
        .shell .attribution a:hover { color: var(--fg); }
        .shell .attribution a:focus-visible {
          outline: 2px solid var(--fg); outline-offset: 3px; border-radius: 4px;
        }
      `}</style>
      {/* Recusado, a nav some inteira — inclusive o botão de entrar. Oferecer
          "Sign in" a quem acabou de ser recusado seria oferecer a volta pela
          porta que acabou de fechar. */}
      {recusa === null && (
        <nav className={user ? undefined : "below"}>
          {/* Sem sessão as três telas são 401: link que não leva a lugar nenhum
              é pior que link ausente.

              β2 — e com a porta de idade aberta a nav também sai: "não passa da
              tela" inclui não contornar por um link. */}
          {user && !user.needsAgeGate ? (
            <>
              <a href="#/" aria-current={inLibrary || inFriends ? undefined : "page"}>
                {t.navDeck}
              </a>
              <a href="#/library" aria-current={inLibrary ? "page" : undefined}>
                {t.navLibrary}
              </a>
              <a href="#/friends" aria-current={inFriends ? "page" : undefined}>
                {t.navFriends}
                <NotificationsBadge />
              </a>
            </>
          ) : null}
          <Login />
        </nav>
      )}
      {/* O <main> é o marco que faltava: a auditoria achou `navigation` e
          `contentinfo` na árvore de acessibilidade e nada em volta do conteúdo,
          então quem navega por marco não tinha como pular a chrome e cair na
          tela. `display: contents` no CSS acima: o elemento existe para a
          árvore e some do layout — os filhos continuam sendo itens de flex do
          .shell, que é o que faz as margens `auto` dos filtros e do rodapé
          funcionarem. */}
      <main>
        {recusa !== null ? (
          <AgeGateRecusa minAge={recusa} />
        ) : user === undefined ? null : !user ? (
          <SignedOut />
        ) : user.needsAgeGate ? (
          // β2 — antes de qualquer tela, e antes de qualquer requisição de
          // dado: a idade é condição para a conta existir, não uma etapa do
          // onboarding.
          <AgeGate user={user} />
        ) : inLibrary ? (
          <Library />
        ) : inFriends ? (
          <Friends />
        ) : (
          <Home />
        )}
      </main>

      {/* Atribuição exigida pelos termos do TMDB. Fica no shell, e não numa
          tela "sobre", porque a condição é ser visível — tela que ninguém abre
          não cumpre. `order: 3` a mantém por último mesmo quando a nav desce
          para depois do conteúdo na home deslogada. */}
      <footer className="attribution">
        {/* β5 — o caminho de retorno. Fica no shell, e fora do `user &&` de
            propósito: quem não consegue entrar é justamente quem mais precisa
            conseguir contar isso. Sem `target="_blank"`: `mailto:` não abre
            aba, abre o cliente de e-mail. */}
        <a className="feedback" href={FEEDBACK_URL}>
          {t.feedbackLink}
        </a>
        <a href="https://www.themoviedb.org/" target="_blank" rel="noreferrer noopener">
          {t.tmdbAttribution}
        </a>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
