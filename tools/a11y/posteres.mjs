/**
 * Põe um pôster SINTÉTICO em todos os títulos do banco de auditoria.
 *
 * A fixture semeada tem `poster_url` nulo em 94 de 94, então o card cai no
 * forro (gradient do id), que é escuro por construção — medir contraste ali
 * mede a premissa que o próprio Card.tsx diz ter caído. Branco puro é o pior
 * caso real de um pôster: é o teto de luminância que a imagem pode ter.
 *
 * uso: node --env-file=apps/api/.env .a11y/posteres.mjs branco|cinza|limpar
 */
import { deflateSync } from "node:zlib";
import { comBanco } from "./lib.mjs";

const crc32 = (buf) => {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** PNG sólido de 8x12 (a proporção do pôster), sem dependência. */
function pngSolido(r, g, b) {
  const w = 8,
    h = 12;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 3);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      raw[o + 1 + x * 3] = r;
      raw[o + 2 + x * 3] = g;
      raw[o + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const modo = process.argv[2] ?? "branco";
const url =
  modo === "limpar"
    ? null
    : `data:image/png;base64,${pngSolido(...(modo === "cinza" ? [128, 128, 128] : [255, 255, 255])).toString("base64")}`;

await comBanco(async (sql) => {
  await sql`update titles set poster_url = ${url}`;
  const [{ com }] = await sql`select count(*) filter (where poster_url is not null) as com from titles`;
  console.log(`poster_url ${modo}: ${com} títulos`);
});
process.exit(0);
