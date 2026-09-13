/* Load index.html's script into Node with a DOM stub, so the calculation engine
   can be tested without a browser and without splitting the single-file design.

   The stub is deliberately dumb: every element is a bag of mutable properties.
   That is enough for the render pass to run to completion at import time, which
   is all the tests need -- they exercise the pure functions underneath. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");

function makeElement() {
  const el = {
    value: "", textContent: "", innerHTML: "", className: "", style: {},
    dataset: {}, selectedIndex: 0, returnValue: "",
    appendChild() {}, removeChild() {}, remove() {}, focus() {}, blur() {},
    setAttribute() {}, getAttribute: () => null, scrollIntoView() {},
    addEventListener() {}, removeEventListener() {},
    showModal() {}, close() {}, submit() {},
    querySelector: () => makeElement(), querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
  return el;
}

export function loadEngine() {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const start = html.indexOf("<script>");
  const end = html.lastIndexOf("</script>");
  if (start < 0 || end < 0) throw new Error("no <script> block found in index.html");
  const source = html.slice(start + "<script>".length, end);

  const byId = new Map();
  const document = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeElement());
      return byId.get(id);
    },
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    createElement: () => makeElement(),
    documentElement: makeElement(),
    body: makeElement(),
    addEventListener() {},
  };
  const store = new Map();
  const sandbox = {
    document,
    window: { addEventListener() {}, open() {}, matchMedia: () => ({ matches: false }) },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    structuredClone, JSON, Math, Object, Array, String, Number, Boolean,
    Date, RegExp, Error, Map, Set, isNaN, parseInt, parseFloat,
    console, encodeURIComponent, decodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // Expose every top-level binding so tests can reach the pure functions.
  vm.runInContext(source + "\n;globalThis.__engine = {" +
    ["budget", "evaluate", "kvGB", "maxCtxThatFits", "caveats", "parseHF",
     "findPreset", "DERATE", "PP", "PRESETS", "CTX_STEPS", "OVERHEAD",
     "DEFAULT_DEVICES", "DEFAULT_MODELS", "estKv", "devices", "models", "fmtCtx", "gb"]
      .map((n) => `${n}: typeof ${n} !== "undefined" ? ${n} : undefined`).join(", ") +
    "};", sandbox, { filename: "index.html:<script>" });

  const engine = sandbox.__engine;
  if (!engine.evaluate) throw new Error("engine did not expose evaluate()");
  // Some tests need to vary KV precision, which the page holds in a module-level let.
  engine.setKvBits = (b) => vm.runInContext(`kvBits = ${Number(b)};`, sandbox);
  return engine;
}
