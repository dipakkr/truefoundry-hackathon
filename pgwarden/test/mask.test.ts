import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMasker } from "../src/mask.js";

const m = createMasker("test-mask-key");

function randomString(rnd: () => number): string {
  const alphabet = "aAbBcCdDeEzZ09.-_ 5";
  const len = 1 + Math.floor(rnd() * 4);
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
  return s;
}
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("masking (CONTRACTS §4)", () => {
  test("mask(a) == mask(b) <=> a == b, and lower(mask(a)) == lower(mask(b)) <=> lower(a) == lower(b)", () => {
    const rnd = mulberry32(20260926);
    const pool = Array.from({ length: 400 }, () => randomString(rnd));
    for (const a of pool)
      for (const b of pool) {
        assert.equal(m.mask(a) === m.mask(b), a === b);
        assert.equal(m.mask(a)!.toLowerCase() === m.mask(b)!.toLowerCase(), a.toLowerCase() === b.toLowerCase());
        assert.equal(m.maskEmail(`${a}@x.com`) === m.maskEmail(`${b}@x.com`), a === b);
      }
  });

  test("an L1 case-variant pair stays a lower()-duplicate but not an exact duplicate", () => {
    const a = m.maskEmail("Priya.Sharma@gmail.com")!, b = m.maskEmail("priya.sharma@gmail.com")!;
    assert.notEqual(a, b);
    assert.equal(a.toLowerCase(), b.toLowerCase());
    assert.notEqual(a, "Priya.Sharma@gmail.com");
  });

  test("case, digits, punctuation and the domain are preserved in shape", () => {
    const out = m.maskEmail("Ab.C-9_x+1@Gmail.COM")!;
    assert.match(out, /^[A-Z][a-z]\.[A-Z]-\d_[a-z]\+\d@Gmail\.COM$/);
    assert.match(m.mask("+91 98765-43210")!, /^\+\d\d \d{5}-\d{5}$/);
    assert.equal(m.mask("Üï ✓"), "Üï ✓"); // non-ASCII passes through
  });

  test("deterministic per key, different across keys, nulls pass through", () => {
    assert.equal(createMasker("test-mask-key").mask("Hello World"), m.mask("Hello World"));
    assert.notEqual(createMasker("other-key").mask("Hello World"), m.mask("Hello World"));
    assert.equal(m.mask(null), null);
    assert.equal(m.maskEmail(null), null);
  });
});
