#!/usr/bin/env node
/* Staible's test suite. No dependencies, no build: `node test/run.mjs`.

   It covers the calculation engine, the Hugging Face parser, and the hardware
   presets -- the three places a wrong answer is silent rather than loud. */
import { loadEngine } from "./harness.mjs";

let pass = 0, fail = 0, group = "";
const results = [];

function describe(name, fn) { group = name; console.log(`\n${name}`); fn(); }
function it(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) {
    fail++; results.push(`${group} > ${name}: ${e.message}`);
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ""} expected ${expected}, got ${actual}`);
}
function near(actual, expected, tol, msg) {
  if (Math.abs(actual - expected) > tol)
    throw new Error(`${msg || ""} expected ~${expected} (±${tol}), got ${actual}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || "expected truthy"); }

const E = loadEngine();

/* fixtures ---------------------------------------------------------------- */
const unified = { id: "u", name: "u", kind: "unified", ramGB: 16, vramGB: 0, bwGB: 83, wiredFrac: .75, ppRate: 149 };
const discrete = { id: "d", name: "d", kind: "discrete", ramGB: 32, vramGB: 24, bwGB: 800, ppRate: 3000 };
const cpuOnly = { id: "c", name: "c", kind: "cpu", ramGB: 8, vramGB: 0, bwGB: 25, osReserveGB: 2, ppRate: 25 };
const unknown = { id: "x", name: "x", kind: "unknown", ramGB: 0, vramGB: 0, bwGB: 0 };

const dense9b = { id: "m", name: "9b", weightsGB: 5.4, sizeGB: 5.68, params: 8.95, active: 8.95, kvPer1kMB: 40, maxCtx: 262144 };
const moe30b = { id: "moe", name: "30b-a3b", weightsGB: 18.56, sizeGB: 18.56, params: 30.53, active: 3.3, kvPer1kMB: 89, maxCtx: 262144 };
const tiny = { id: "t", name: "tiny", weightsGB: 1.67, sizeGB: 1.67, params: 2.7, active: 2.7, kvPer1kMB: 18, maxCtx: 131072 };
const huge = { id: "h", name: "huge", weightsGB: 60, sizeGB: 60, params: 100, active: 100, kvPer1kMB: 200, maxCtx: 131072 };

/* ------------------------------------------------------------------------- */
describe("budget: architecture decides the memory model", () => {
  it("unified reserves the OS share via the wired limit", () => {
    near(E.budget(unified).fast, 12, .01, "16 GB x 0.75");
  });
  it("discrete budgets VRAM, not system RAM", () => {
    near(E.budget(discrete).fast, 23.2, .01);
    ok(E.budget(discrete).slow > 0, "system RAM is the slow pool");
  });
  it("cpu-only has no second pool to spill into", () => {
    near(E.budget(cpuOnly).fast, 6, .01);
    eq(E.budget(cpuOnly).slow, 0);
  });
  it("unknown hardware refuses to produce a budget", () => {
    eq(E.budget(unknown).ok, false);
  });
  it("unified's slow pool stays fast; discrete's does not", () => {
    const u = E.budget(unified), d = E.budget(discrete);
    ok(u.bwSlow / u.bwFast > 0.5, "unified slow pool is same physical RAM");
    ok(d.bwSlow / d.bwFast < 0.35, "discrete slow pool is across PCIe");
    ok(u.bwSlow / u.bwFast > d.bwSlow / d.bwFast * 2,
       "unified must retain far more of its bandwidth when spilling");
  });
});

describe("kv cache", () => {
  it("grows linearly with context", () => {
    const a = E.kvGB(dense9b, 32768), b = E.kvGB(dense9b, 65536);
    near(b / a, 2, .001);
  });
  it("matches the measured 40 MB per 1k tokens", () => {
    near(E.kvGB(dense9b, 32768) * 1024 / 32, 40, .5);
  });
  it("q8_0 halves it", () => {
    const f16 = E.kvGB(dense9b, 32768);
    E.setKvBits(8);
    const q8 = E.kvGB(dense9b, 32768);
    E.setKvBits(16);
    near(q8 / f16, .5, .001);
  });
});

describe("evaluate: the four verdicts", () => {
  it("fits with headroom", () => {
    eq(E.evaluate(dense9b, unified, 4096).verdict, "good");
  });
  it("won't run when it exceeds total addressable memory", () => {
    eq(E.evaluate(huge, unified, 4096).verdict, "crit");
  });
  it("spills when past fast memory but within total", () => {
    eq(E.evaluate(moe30b, discrete, 262144).verdict, "serious");
  });
  it("a cpu-only box cannot spill, so it just fails", () => {
    eq(E.evaluate(dense9b, cpuOnly, 32768).verdict, "crit");
  });
  it("unknown hardware yields no verdict at all", () => {
    ok(E.evaluate(dense9b, unknown, 4096).unknown);
  });
  it("widening context can turn a fit into a failure", () => {
    eq(E.evaluate(dense9b, unified, 4096).verdict, "good");
    eq(E.evaluate(dense9b, unified, 524288).verdict, "crit");
  });
});

describe("the central claim: spilling differs by architecture", () => {
  /* This is the whole reason Staible exists rather than a generic VRAM
     calculator. If these two ever converge, the model has lost its point. */
  const spillPenalty = (dev, model, ctx) => {
    const r = E.evaluate(model, dev, ctx);
    ok(r.cpuFrac > 0.01, "fixture must actually spill");
    const full = E.budget(dev).bwFast / (model.weightsGB * Math.max(model.active / model.params, .12));
    return r.tok / full;                       // fraction of unspilled speed retained
  };
  it("unified degrades gently when layers land on CPU", () => {
    const big = { ...dense9b, weightsGB: 11.5 };
    ok(spillPenalty(unified, big, 32768) > .6, "unified spill should retain most speed");
  });
  it("discrete falls off a cliff for the same spill", () => {
    ok(spillPenalty(discrete, { ...moe30b, weightsGB: 26 }, 32768) < .7,
       "a PCIe spill should cost a large share of speed");
  });
  it("reproduces the measured M3 spill: 45% on CPU costs ~10% of speed", () => {
    /* Ground truth: qwen3.5:9b on an M3 Air, 15.4 tok/s at 100% fast memory,
       13.9 tok/s at a 45% CPU / 55% GPU split. */
    const b = E.budget(unified);
    const retained = 1 / (0.55 / b.bwFast + 0.45 / b.bwSlow) / b.bwFast;
    near(retained, 0.903, 0.03, "unified retention at 45% displaced");
  });
  it("reproduces the measured 4090 spill: 29% on CPU costs ~52% of speed", () => {
    /* Ground truth: qwen3-coder:30b on an RTX 4090, 172.5 tok/s at 100% GPU,
       83.0 tok/s at a 29% CPU / 71% GPU split. */
    const b = E.budget(discrete);
    const retained = 1 / (0.71 / b.bwFast + 0.29 / b.bwSlow) / b.bwFast;
    near(retained, 0.481, 0.03, "discrete retention at 29% displaced");
  });
  it("at an equal displaced fraction, a discrete spill costs far more", () => {
    /* Comparing retention between two different spills is meaningless -- they
       displace different fractions. Hold the fraction equal and compare the LOSS,
       which is the quantity the measurements actually pin: ~8x worse on discrete. */
    const retained = (dev, cpuFrac) => {
      const b = E.budget(dev);
      return 1 / ((1 - cpuFrac) / b.bwFast + cpuFrac / b.bwSlow) / b.bwFast;
    };
    for (const frac of [0.1, 0.29, 0.45]) {
      const lossU = 1 - retained(unified, frac);
      const lossD = 1 - retained(discrete, frac);
      ok(lossD / lossU > 4,
         `at ${frac * 100}% displaced, discrete loss should be >4x unified `
         + `(got ${(lossD / lossU).toFixed(1)}x)`);
    }
  });
});

describe("MoE: memory tracks total, speed tracks active", () => {
  it("an MoE outruns a dense model of the same file size", () => {
    const denseSame = { ...moe30b, active: moe30b.params };
    const a = E.evaluate(moe30b, discrete, 32768).tok;
    const b = E.evaluate(denseSame, discrete, 32768).tok;
    ok(a > b * 2, `MoE ${a.toFixed(0)} should far exceed dense ${b.toFixed(0)}`);
  });
  it("but occupies memory like its total size", () => {
    const denseSame = { ...moe30b, active: moe30b.params };
    near(E.evaluate(moe30b, discrete, 32768).total,
         E.evaluate(denseSame, discrete, 32768).total, .001);
  });
});

describe("maxCtxThatFits", () => {
  it("never exceeds the model's trained context", () => {
    ok(E.maxCtxThatFits(tiny, discrete) <= tiny.maxCtx);
  });
  it("is zero when the weights alone do not fit", () => {
    eq(E.maxCtxThatFits(huge, unified), 0);
  });
  it("agrees with evaluate at the boundary", () => {
    const m = E.maxCtxThatFits(dense9b, unified);
    ok(E.evaluate(dense9b, unified, m).verdict !== "crit", "the reported max must actually fit");
  });
});

describe("caveats accompany every calculation", () => {
  it("flags an unmeasured bandwidth", () => {
    const c = E.caveats(dense9b, { ...unified, bwMeasured: false }, 4096, E.evaluate(dense9b, unified, 4096));
    ok(c.some((x) => /not measured/i.test(x.t)));
  });
  it("flags context past the trained maximum", () => {
    const c = E.caveats(tiny, discrete, 262144, E.evaluate(tiny, discrete, 262144));
    ok(c.some((x) => x.lvl === "bad"));
  });
  it("always says speed is quoted at an empty context", () => {
    const c = E.caveats(dense9b, unified, 4096, E.evaluate(dense9b, unified, 4096));
    ok(c.some((x) => /empty context/i.test(x.t)));
  });
});

describe("parseHF: the traps a naive fetcher falls into", () => {
  const repo = (siblings, total = 8.95e9, ctx = 262144, id = "org/Thing-GGUF") =>
    JSON.stringify({ id, gguf: { total, context_length: ctx, architecture: "qwen35" }, siblings });

  it("reads params, quant, size and context", () => {
    const r = E.parseHF(repo([{ rfilename: "T-Q4_K_M.gguf", size: 5.68e9 }]));
    eq(r.params, 8.95); eq(r.quant, "Q4_K_M"); eq(r.sizeGB, 5.68); eq(r.maxCtx, 262144);
  });
  it("sums split shards into one quantisation", () => {
    const r = E.parseHF(repo([
      { rfilename: "T-Q4_K_M-00001-of-00002.gguf", size: 3e9 },
      { rfilename: "T-Q4_K_M-00002-of-00002.gguf", size: 2.68e9 },
    ]));
    eq(r.sizeGB, 5.68, "shards must be summed, not picked from");
  });
  it("excludes mmproj vision projectors", () => {
    const r = E.parseHF(repo([
      { rfilename: "T-Q4_K_M.gguf", size: 5.68e9 },
      { rfilename: "mmproj-T-Q4_K_M.gguf", size: 0.9e9 },
    ]));
    eq(r.sizeGB, 5.68, "a projector is not weights");
  });
  it("rejects a file too small for the parameter count", () => {
    /* The real case: gemma-4-12B published a 0.25 GB Q4_0 fragment. */
    let threw = false;
    try { E.parseHF(repo([{ rfilename: "T-Q4_0.gguf", size: 0.25e9 }], 11.91e9)); }
    catch { threw = true; }
    ok(threw, "an implausible size must be rejected, not reported");
  });
  it("detects MoE from the repo name and leaves active params unset", () => {
    const r = E.parseHF(repo([{ rfilename: "T-Q4_K_M.gguf", size: 18.56e9 }],
                             30.53e9, 262144, "org/Qwen3-Coder-30B-A3B-GGUF"));
    ok(r.moe, "A3B in the name means mixture-of-experts");
  });
  it("refuses a repo with no GGUF parameter count", () => {
    let threw = false;
    try { E.parseHF(JSON.stringify({ id: "a/b", siblings: [] })); } catch { threw = true; }
    ok(threw);
  });
});

describe("hardware presets", () => {
  it("the M3 preset reproduces the measured machine", () => {
    /* Ground truth: an M3 Air measured 83 GB/s effective and 149 prompt tok/s.
       If the derate factor drifts, this is the only test that would notice. */
    const m3 = E.findPreset("Apple Silicon/M3");
    ok(m3, "M3 preset must exist");
    near(Math.round(m3.bw * E.DERATE), 83, 2, "effective bandwidth");
    near(Math.round(m3.bw * E.DERATE * E.PP.unified), 149, 4, "prompt rate");
  });
  it("every preset carries a positive bandwidth and a known architecture", () => {
    for (const [groupName, list] of Object.entries(E.PRESETS))
      for (const p of list) {
        ok(p.bw > 0, `${groupName}/${p.n} has no bandwidth`);
        ok(["unified", "discrete", "cpu"].includes(p.kind), `${groupName}/${p.n} bad kind`);
        if (p.kind === "discrete") ok(p.vram > 0, `${groupName}/${p.n} discrete needs VRAM`);
        else ok(!p.vram, `${groupName}/${p.n} non-discrete should not declare VRAM`);
      }
  });
  it("preset names are unique within a group", () => {
    for (const [groupName, list] of Object.entries(E.PRESETS)) {
      const names = list.map((p) => p.n);
      eq(new Set(names).size, names.length, `${groupName} has duplicates`);
    }
  });
  it("findPreset returns null for an unknown key", () => {
    eq(E.findPreset("Nope/Nothing"), null);
  });
});

describe("shipped defaults stay self-consistent", () => {
  /* The social preview card once claimed a machine spilled where the engine
     says it will not run at all. These pin the defaults the docs describe. */
  const dev = (n) => E.DEFAULT_DEVICES.find((d) => d.name === n || d.id === n);
  const mod = (n) => E.DEFAULT_MODELS.find((m) => m.name === n || m.id === n);

  it("every default model has positive weights and a context limit", () => {
    for (const m of E.DEFAULT_MODELS) {
      ok(m.weightsGB > 0, `${m.name} weights`);
      ok(m.maxCtx > 0, `${m.name} maxCtx`);
      ok(m.active > 0 && m.active <= m.params, `${m.name} active params`);
    }
  });
  it("every configured default device produces a budget", () => {
    for (const d of E.DEFAULT_DEVICES)
      if (d.kind !== "unknown") ok(E.budget(d).ok, `${d.name} has no budget`);
  });
  it("a 16 GB laptop cannot run a 22 GB model", () => {
    eq(E.evaluate(mod("qwen3.6:35b-a3b"), dev("m3-air"), 32768).verdict, "crit");
  });
  it("the small CPU box runs nothing large", () => {
    eq(E.evaluate(mod("qwen3.5:9b"), dev("ryzen-mini"), 32768).verdict, "crit");
  });
  it("the measured 4090 constants stayed measured", () => {
    const coder = mod("qwen3-coder:30b");
    ok(coder.kvMeasured, "qwen3-coder:30b KV is a measurement");
    near(coder.kvPer1kMB, 105.6, .01);
    near(dev("rtx-4090").ppRate, 10201, 1, "measured prompt rate");
  });
  it("the measured gemma KV cost stayed measured", () => {
    const g = mod("gemma4:12b-it-qat");
    ok(g.kvMeasured, "gemma4:12b-it-qat KV is a measurement, not an estimate");
    near(g.kvPer1kMB, 3.1, .01);
    ok(g.kvPer1kMB < E.estKv(g.params) / 5,
       "sliding-window KV must stay far below the parameter-count estimate");
  });
});

/* ------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("\nfailures:"); results.forEach((r) => console.log("  - " + r)); }
process.exit(fail ? 1 : 0);
