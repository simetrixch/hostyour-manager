import { defineConfig } from "drizzle-kit";

// Schema is split one-file-per-writer; drizzle-kit reads them all.
export default defineConfig({
  dialect: "sqlite",
  schema: "./server/db/schema/*.ts",
  out: "./server/db/migrations",
});
