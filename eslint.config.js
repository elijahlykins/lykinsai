import globals from "globals";
import pluginJs from "@eslint/js";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginUnusedImports from "eslint-plugin-unused-imports";

const FILES = [
  "src/components/**/*.{js,mjs,cjs,jsx}",
  "src/pages/**/*.{js,mjs,cjs,jsx}",
  "src/Layout.jsx",
];

// The recommended sets have to be their own entries. Spreading them into the
// same object as our own `rules` looks like it layers them, but the later key
// replaces the earlier one outright — so every recommended rule was being
// dropped, `no-undef` included. A component missing an import passed lint and
// only failed once it rendered.
export default [
  { files: FILES, ...pluginJs.configs.recommended },
  { files: FILES, ...pluginReact.configs.flat.recommended },
  {
    files: FILES,
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    plugins: {
      react: pluginReact,
      "react-hooks": pluginReactHooks,
      "unused-imports": pluginUnusedImports,
    },
    rules: {
      // unused-imports reports these instead, and can autofix them.
      "no-unused-vars": "off",
      "react/jsx-uses-vars": "error",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
      "react/prop-types": "off",
      "react/react-in-jsx-scope": "off",
      // Apostrophes and quotes in copy render fine and reading them escaped is
      // worse. Left on, this one rule was 171 of the 179 reports and would have
      // buried anything worth acting on.
      "react/no-unescaped-entities": "off",
      // `catch {}` is how a best-effort call says it doesn't care why it failed.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "react/no-unknown-property": [
        "error",
        { ignore: ["cmdk-input-wrapper", "toast-close"] },
      ],
      "react-hooks/rules-of-hooks": "error",
    },
  },
];
