import { describe, expect, it } from "vitest";
import { evaluateCurve, insertCurveKey, scaleCurveKeys, type CurveKey } from "../src/animation.ts";

const key = (time: number, value: number, patch: Partial<CurveKey> = {}): CurveKey => ({
  id: crypto.randomUUID(), time, value, interpolation: "bezier", tangentMode: "auto", ...patch,
});
const frozen = (keys: CurveKey[]): readonly CurveKey[] => Object.freeze(keys.map(value => Object.freeze(value)));
const weighted = () => frozen([
  key(-3, -1, { tangentMode: "fixed", outSlope: .4, outWeight: .2 }),
  key(-1, 0, { tangentMode: "fixed", inSlope: -.3, outSlope: 1.8, inWeight: .3, outWeight: .65, broken: true }),
  key(2, 1, { tangentMode: "fixed", inSlope: -.4, outSlope: .3, inWeight: .15, outWeight: .6, broken: true }),
  key(4, 2, { tangentMode: "fixed", inSlope: -.5, inWeight: .25 }),
]);

describe("pure curve insertion", () => {
  it.each([-.999, -.25, .125, 1.999])("preserves weighted curve and neighboring segments at %s", coordinate => {
    const source = weighted(), before = structuredClone(source);
    const result = insertCurveKey(source, coordinate);
    expect(result.keys.find(k => k.id === result.id)!.time).toBe(coordinate);
    expect(result.keys[0]).toBe(source[0]); expect(result.keys[4]).toBe(source[3]);
    expect(result.keys[1].inSlope).toBe(source[1].inSlope);
    expect(result.keys[3].outSlope).toBe(source[2].outSlope);
    for (let i = 0; i <= 1000; i++) {
      const time = -4 + i * .009;
      expect(evaluateCurve(result.keys, time)).toBeCloseTo(evaluateCurve(source, time)!, 8);
    }
    expect(source).toEqual(before);
  });

  it.each(["auto", "spline", "clamped", "flat"] as const)("freezes %s tangents without changing adjacent curves", tangentMode => {
    const source = frozen([key(-3, -1, { tangentMode }), key(-1, 0, { tangentMode }), key(2, 1, { tangentMode }), key(4, .5, { tangentMode })]);
    const result = insertCurveKey(source, .35);
    expect(result.keys[1].tangentMode).toBe("fixed"); expect(result.keys[3].tangentMode).toBe("fixed");
    for (let i = 0; i <= 500; i++) expect(evaluateCurve(result.keys, -3 + i * .014)).toBeCloseTo(evaluateCurve(source, -3 + i * .014)!, 9);
  });

  it.each(["linear", "step"] as const)("preserves %s curves, full turns and endpoint holds", interpolation => {
    const source = frozen([key(-.5, -360, { interpolation }), key(.5, 720, { interpolation })]);
    let result = insertCurveKey(source, .125);
    result = insertCurveKey(result.keys, -1); result = insertCurveKey(result.keys, 1);
    for (const time of [-2, -1, -.5, 0, .124999, .125, .125001, .499999, .5, 2]) {
      expect(evaluateCurve(result.keys, time)).toBeCloseTo(evaluateCurve(source, time)!, 10);
    }
  });

  it("keeps SDK visibility continuous unless discrete evaluation is requested", () => {
    const source = frozen([key(0, 0, { interpolation: "linear" }), key(1, 1)]);
    const continuous = insertCurveKey(source, .4), discrete = insertCurveKey(source, .4, { discrete: true });
    expect(continuous.keys[1].value).toBe(.4); expect(discrete.keys[1].value).toBe(0);
    for (const time of [.1, .399, .4, .8, .999]) {
      expect(evaluateCurve(continuous.keys, time)).toBeCloseTo(time);
      expect(evaluateCurve(discrete.keys, time)).toBe(0);
    }
    expect(evaluateCurve(discrete.keys, 1)).toBe(1);
  });

  it("returns an exact existing key without changing any record and handles a singleton", () => {
    const source = weighted(), result = insertCurveKey(source, -1);
    expect(result.id).toBe(source[1].id); expect(result.keys).toEqual(source);
    result.keys.forEach((k, i) => expect(k).toBe(source[i]));
    const one = frozen([key(.25, 3)]);
    expect(evaluateCurve(insertCurveKey(one, -.25).keys, -.1)).toBe(3);
    expect(evaluateCurve(insertCurveKey(one, .75).keys, .5)).toBe(3);
  });

  it("rejects malformed, sparse, empty or unrepresentable curves without mutation", () => {
    const source = weighted(), before = structuredClone(source);
    for (const coordinate of [NaN, Infinity, -Infinity, 1000001, -1000001]) expect(() => insertCurveKey(source, coordinate)).toThrow(/coordinate/);
    expect(() => insertCurveKey([], 0)).toThrow(/first key/);
    expect(() => insertCurveKey([source[0], , source[1]] as CurveKey[], source[0].time)).toThrow(/key/);
    expect(() => insertCurveKey([source[1], source[0]], 0)).toThrow(/key/);
    const vertical = frozen([key(0, 0, { tangentMode: "flat", outWeight: 1 }), key(10, 10, { tangentMode: "flat", inWeight: 1 })]);
    expect(() => insertCurveKey(vertical, 5)).toThrow(/Adjust tangent weights/);
    expect(source).toEqual(before);
  });
});

describe("pure curve coordinate scaling", () => {
  it("preserves weighted shape and handle heights without quantizing fractional driver values", () => {
    const source = weighted(), selected = new Set(source.map(k => k.id)), before = structuredClone(source), factor = .325, pivot = .125;
    const result = scaleCurveKeys(source, selected, factor, pivot, false);
    expect(result[1].time).toBe(pivot + (source[1].time - pivot) * factor);
    expect(result[1].outSlope).toBeCloseTo(source[1].outSlope! / factor, 12);
    expect(result[2].inSlope).toBeCloseTo(source[2].inSlope! / factor, 12);
    expect(result[1].outWeight).toBe(source[1].outWeight);
    for (let i = 0; i <= 1000; i++) {
      const time = -4 + i * .009;
      expect(evaluateCurve(result, pivot + (time - pivot) * factor)).toBeCloseTo(evaluateCurve(source, time)!, 9);
    }
    expect(source).toEqual(before);
  });

  it("adjusts only sides whose adjoining endpoint is also selected", () => {
    const source = weighted(), result = scaleCurveKeys(source, new Set([source[1].id, source[2].id]), .5, 0, false);
    expect(result[0]).toBe(source[0]); expect(result[3]).toBe(source[3]);
    expect(result[1].inSlope).toBe(source[1].inSlope); expect(result[2].outSlope).toBe(source[2].outSlope);
    expect(result[1].outSlope).toBeCloseTo(source[1].outSlope! * 2, 12); expect(result[2].inSlope).toBeCloseTo(source[2].inSlope! * 2, 12);
  });

  it("uses actual snapped duration for time curves", () => {
    const source = frozen([key(.2, 0, { tangentMode: "fixed", outSlope: 2, outWeight: .2 }), key(2.7, 3, { tangentMode: "fixed", inSlope: .5, inWeight: .4 })]);
    const result = scaleCurveKeys(source, new Set(source.map(k => k.id)), 1.5, .2, true);
    expect(result.map(k => k.time)).toEqual([0, 4]);
    expect(result[0].outSlope).toBe(2 * 2.5 / 4); expect(result[1].inSlope).toBe(.5 * 2.5 / 4);
    for (let i = 0; i <= 100; i++) expect(evaluateCurve(result, i * .04)).toBeCloseTo(evaluateCurve(source, .2 + i * .025)!, 10);
  });

  it("preserves record references for no-ops and ignores IDs belonging to other curves", () => {
    const source = weighted();
    for (const result of [scaleCurveKeys(source, new Set(source.map(k => k.id)), 1, 0, false), scaleCurveKeys(source, new Set(["other"]), 2, 0, false)]) {
      result.forEach((k, i) => expect(k).toBe(source[i]));
    }
  });

  it("rejects collisions, invalid scales, coordinates and sparse inputs atomically", () => {
    const source = frozen([key(0, 0), key(1, 1), key(2, 2)]), before = structuredClone(source);
    expect(() => scaleCurveKeys(source, new Set([source[1].id]), 2, 0, false)).toThrow(/duplicate key time/);
    expect(() => scaleCurveKeys(source, new Set(source.map(k => k.id)), .1, 0, true)).toThrow(/duplicate key time/);
    expect(scaleCurveKeys(source, new Set(source.map(k => k.id)), .1, 0, false).map(k => k.time)).toEqual([0, .1, .2]);
    for (const factor of [0, -1, NaN, Infinity]) expect(() => scaleCurveKeys(source, new Set(), factor, 0, false)).toThrow(/positive and finite/);
    expect(() => scaleCurveKeys(source, new Set([source[2].id]), 1e6, 0, false)).toThrow(/key/);
    expect(() => scaleCurveKeys(source, new Set(), 1, 1000001, false)).toThrow();
    expect(() => scaleCurveKeys([source[0], , source[1]] as CurveKey[], new Set(), 1, 0, false)).toThrow(/key/);
    expect(source).toEqual(before);
  });
});
