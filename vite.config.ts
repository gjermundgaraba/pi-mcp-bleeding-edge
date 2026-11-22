import ultraciteFmt from "ultracite/oxfmt";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";
import { defineConfig } from "vite-plus";

const testFiles = ["tests/**/*.ts"];

export default defineConfig({
  fmt: {
    ...ultraciteFmt,
    ignorePatterns: [...(ultraciteFmt.ignorePatterns ?? []), "AGENTS.md"],
  },
  lint: {
    env: { node: true },
    extends: [core, antiSlop, vitest],
    ignorePatterns: [...(core.ignorePatterns ?? [])],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    options: {
      typeAware: true,
      typeCheck: true,
      denyWarnings: true,
      reportUnusedDisableDirectives: "deny",
    },
    overrides: [
      {
        // Server logging is deprecated by MCP 2026-07-28 (SEP-2577) but stays in the
        // specification for twelve months, and 2025-era servers still send it.
        files: ["log.ts", "connection/connection.ts"],
        rules: { "typescript/no-deprecated": "off" },
      },
      {
        // Only the SDK's low-level server lets a test server page its resources.
        files: ["tests/fixtures/stdio-paging.ts"],
        rules: { "typescript/no-deprecated": "off" },
      },
      {
        // The one place a value from an MCP message is typed as the JSON it was parsed from.
        files: ["tools/json.ts"],
        rules: { "typescript/no-unsafe-type-assertion": "off" },
      },
      {
        // The SDK's Client reports a closed transport only through its onclose property.
        files: ["connection/connection.ts"],
        rules: { "unicorn/prefer-add-event-listener": "off" },
      },
      {
        files: testFiles,
        plugins: ["vitest"],
        rules: {
          "typescript/no-non-null-assertion": "off",
          "vitest/max-expects": "off",
          "vitest/prefer-describe-function-title": "off",
          "vitest/prefer-to-be-falsy": "off",
          "vitest/prefer-to-be-truthy": "off",
          "no-template-curly-in-string": "off",
        },
      },
    ],
    rules: {
      "sort-keys": "off",
      "max-classes-per-file": "off",
      "no-await-in-loop": "off",
      "require-await": "off",
      "typescript/consistent-return": "off",
      "no-use-before-define": [
        "error",
        { classes: false, functions: false, ignoreTypeReferences: true },
      ],
      complexity: "off",
      "max-nested-callbacks": "off",
      "no-bitwise": "off",
      "unicorn/filename-case": ["error", { cases: { kebabCase: true } }],
      "func-names": ["error", "as-needed", { generators: "never" }],
      "no-redeclare": "off",
      "promise/prefer-await-to-callbacks": "off",
      "typescript/array-type": [
        "error",
        { default: "array-simple", readonly: "array-simple" },
      ],
      "unicorn/no-array-method-this-argument": "off",
      "unicorn/throw-new-error": "off",
      "anti-slop/require-safety-comment-for-type-assertion": "off",
      "anti-slop/no-unknown-parameters": "off",
      "anti-slop/no-unknown-returns": "off",
      "anti-slop/no-conditional-empty-object-spread": "off",
      "unicorn/text-encoding-identifier-case": "off",
      "default-case": "off",
      "typescript/switch-exhaustiveness-check": "error",
      "unicorn/no-useless-undefined": "off",
      "no-useless-return": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
      // Zod parses data that crosses a trust boundary (config and stored files); these rules
      // demanded the same ceremony for internal values, without adding a guarantee.
      "anti-slop/no-runtime-typeof": "off",
      "anti-slop/no-unsafe-dictionary-type": "off",
      "anti-slop/no-object-parameters": "off",
      "anti-slop/no-known-value-widening": "off",
      "promise/avoid-new": "off",
      "typescript/no-misused-spread": "off",
      "func-style": "off",
      "typescript/method-signature-style": "off",
    },
  },
  staged: { "*": "vp check --fix" },
  test: {
    environment: "node",
    exclude: ["**/node_modules/**"],
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/**/*.integration.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/**/*.integration.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
