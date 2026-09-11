import { ageGateInput, ageGateResponse } from "@watchlytics/contract";
import { authedFetch } from "./session.ts";

/**
 * β2 — a decisão da porta de idade, fora do componente.
 *
 * Separado do `AgeGate.tsx` porque a suíte da web roda em `node --test`, sem
 * DOM: lógica dentro do .tsx é lógica sem teste. Aqui é um módulo puro de
 * fetch, e o teste cobre os quatro desfechos.
 */
export type AgeVerdict =
  /** Passou: a conta segue, e o servidor já gravou o ano. */
  | { kind: "ok" }
  /** Abaixo do piso. Nada foi gravado, e não há segunda tentativa. */
  | { kind: "refused"; minAge: number }
  /** Não é um ano — nem chega a sair do dispositivo. */
  | { kind: "invalid" };

/**
 * Manda o ano e devolve o que a tela tem que mostrar.
 *
 * Quem decide se o ano basta é o SERVIDOR, não esta função: é ele que guarda o
 * ano, apaga a sessão na recusa e responde `ok: false`. Repetir a conta de
 * idade aqui criaria a mesma regra em dois lugares, e o cliente é justamente o
 * lado que não dá para acreditar.
 *
 * O intervalo do ano (`ageGateInput`) é validado antes da rede por outro
 * motivo: "1" ou "dois mil" não é resposta, é digitação pela metade, e mandar
 * isso para o servidor transformaria um erro de forma em recusa de idade.
 *
 * Falha de rede ou de servidor LANÇA, e não devolve um desfecho: é a convenção
 * do resto da web (errors.ts), e não dá para confundir com recusa quem chama.
 * Confundir os dois trancaria fora quem tem idade por causa de um 500.
 */
export async function submitBirthYear(raw: string): Promise<AgeVerdict> {
  // `Number("")` é 0 e `Number("abc")` é NaN — os dois reprovam no contrato.
  const parsed = ageGateInput.safeParse({ birthYear: Number(raw.trim()) });
  if (!parsed.success) return { kind: "invalid" };

  const res = await authedFetch("/v1/auth/age", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // `parsed.data`, e não o que a tela tinha: o corpo leva o ano e só o ano.
    body: JSON.stringify(parsed.data),
  });
  if (!res.ok) throw new Error(`/v1/auth/age respondeu ${res.status}`);

  const body = ageGateResponse.parse(await res.json());
  return body.ok ? { kind: "ok" } : { kind: "refused", minAge: body.minAge };
}
