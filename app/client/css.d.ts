// `import "./styles.css"` is a bundler convention, not something TypeScript knows.
// Vite understands it natively; tsc needs to be told. The import is erased before
// bundling (build-client.mjs stubs it out) because Tailwind emits the CSS separately.
declare module "*.css";
