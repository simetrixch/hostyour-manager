import tseslint from "typescript-eslint";

// The baseline lint rules. File-scoped rules (routes.ts function length,
// top-level `new` only in boot/wire.ts) are added as those files land. The load-bearing
// boundary laws live in .dependency-cruiser.cjs; this is the per-file hygiene layer.
export default tseslint.config(
  {
    ignores: [
      "web/dist/**",
      "node_modules/**",
      "server/db/migrations/**",
      "*.config.ts",
      "*.config.js",
      ".dependency-cruiser.cjs",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-console": "error",                                   // pino only
      "no-throw-literal": "error",                             // typed errors only
      "@typescript-eslint/no-explicit-any": "error",           // no implicit any
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }], // files stay under 400 lines
    },
  },
);
