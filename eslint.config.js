const {
    defineConfig,
} = require("eslint/config");

const tsParser = require("@typescript-eslint/parser");
const typescriptEslint = require("@typescript-eslint/eslint-plugin");
const globals = require("globals");
const js = require("@eslint/js");

const {
    FlatCompat,
} = require("@eslint/eslintrc");

const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

module.exports = defineConfig([{
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
        parser: tsParser,
        globals: {
            ...globals.browser,
            ...globals.node,
        },
    },

    plugins: {
        "@typescript-eslint": typescriptEslint,
    },

    extends: compat.extends(
        "expo",
        "plugin:react/recommended",
        "plugin:@typescript-eslint/recommended",
    ),

    rules: {
        "no-console": "warn",
        "eqeqeq": "off",
        "curly": "error",
        "semi": ["error", "always"],
        "quotes": ["error", "double"],
        "indent": ["warn", 4, { "SwitchCase": 1 }],
        "@typescript-eslint/no-unused-vars": "off",
        "eol-last": ["error", "always"],
    },
}]);
