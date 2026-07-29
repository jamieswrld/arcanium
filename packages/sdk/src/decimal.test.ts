import test from "node:test";
import assert from "node:assert/strict";
import { applyBps, formatUnits, parseUnits, subtractBps } from "./decimal.js";

test("parseUnits handles 6-decimal quote amounts exactly", () => {
  assert.equal(parseUnits("52.5", 6), 52_500_000n);
  assert.equal(parseUnits("0.000001", 6), 1n);
  assert.equal(parseUnits("100000", 6), 100_000_000_000n);
});

test("parseUnits rejects excess precision instead of rounding", () => {
  assert.throws(() => parseUnits("0.0000001", 6), RangeError);
});

test("parseUnits rejects malformed input", () => {
  assert.throws(() => parseUnits("1e6", 6), SyntaxError);
  assert.throws(() => parseUnits("", 6), SyntaxError);
  assert.throws(() => parseUnits("1,000", 6), SyntaxError);
});

test("formatUnits round-trips without float drift", () => {
  assert.equal(formatUnits(52_500_000n, 6), "52.5");
  assert.equal(formatUnits(1n, 18), "0.000000000000000001");
  assert.equal(formatUnits(1_000_000_000n * 10n ** 18n, 18), "1000000000");
  assert.equal(formatUnits(-1_500_000n, 6), "-1.5");
});

test("15% bridge fee math is exact", () => {
  const gross = parseUnits("100", 6);
  assert.equal(applyBps(gross, 1500n), 15_000_000n);
  assert.equal(subtractBps(gross, 1500n), 85_000_000n);
});

test("30/70 split covers the whole amount for even quantities", () => {
  const fees = 1_000_000n;
  const creator = applyBps(fees, 3000n);
  const protocol = fees - creator;
  assert.equal(creator, 300_000n);
  assert.equal(protocol, 700_000n);
});
