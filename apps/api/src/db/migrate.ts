import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, pg } from "./client.ts";

// Relativo ao arquivo, não ao cwd: o release_command do Fly roda de /app.
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

// drizzle-kit não emite CREATE EXTENSION; o vector() do schema depende dela.
await pg`CREATE EXTENSION IF NOT EXISTS vector`;
await migrate(db, { migrationsFolder });
await pg.end();

console.log("migrations aplicadas");
