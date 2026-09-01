/**
 * C1 — shim de autenticação.
 *
 * ponytail: lê um usuário fixo do ambiente para destravar as trilhas A, B e D
 * antes de existir OAuth. SAI no merge de C2 — não deixe virar bypass
 * permanente. Em produção DEV_USER_ID não é definida, então toda rota
 * autenticada responde 401 até C2 entrar.
 */
export function requireUserId(): string {
  const id = process.env["DEV_USER_ID"];
  if (id) return id;

  const err = new Error("não autenticado") as Error & { statusCode: number };
  err.statusCode = 401;
  throw err;
}
