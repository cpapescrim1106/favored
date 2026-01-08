import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import prettierPluginRecommended from "eslint-plugin-prettier/recommended";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

import type { ConfigWithExtends } from "typescript-eslint";

const rootDir = dirname(fileURLToPath(import.meta.url));
const rootPath = (path: string) => join(rootDir, path);

/**
 * ALL_PACKAGES_RULES
 * are applied to the whole project
 */
const allPackagesRules: ConfigWithExtends["rules"] = {
  "no-unused-vars": "off",
  "no-useless-escape": "off",
  "react-hooks/error-boundaries": "off",
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      args: "after-used",
      ignoreRestSiblings: true,
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
    },
  ],
  eqeqeq: "error",
  "no-else-return": "error",
  "prefer-const": [
    "error",
    {
      destructuring: "any",
      ignoreReadBeforeAssign: false,
    },
  ],
  "no-console": ["warn", { allow: ["warn", "error", "info"] }],
  "no-new-wrappers": "error",
  "@typescript-eslint/consistent-type-imports": [
    "error",
    {
      disallowTypeAnnotations: true,
      fixStyle: "separate-type-imports",
      prefer: "type-imports",
    },
  ],
  "react/function-component-definition": [
    "error",
    {
      namedComponents: "arrow-function",
    },
  ],
};

export default defineConfig([
  // order of each config is important, please change them with extreme caution

  includeIgnoreFile(rootPath(".gitignore")),
  globalIgnores([".next/*", "node_modules/*", "public/*", "**/*.d.ts"]),
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    name: "GlobalsConfig",
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    name: "ReactConfig",
    ...reactPlugin.configs.flat.recommended,
    ...reactPlugin.configs.flat["jsx-runtime"],
    settings: {
      react: {
        version: "detect",
      },
    },
  },
  {
    name: "ReactHooksConfig",
    ...reactHooksPlugin.configs.flat.recommended,
  },
  {
    name: "NextConfig",
    plugins: {
      "@next/next": nextPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
    },
  },

  /* CUSTOM RULES */
  {
    name: "GlobalRules",
    rules: allPackagesRules,
  },

  prettierPluginRecommended,
]);
