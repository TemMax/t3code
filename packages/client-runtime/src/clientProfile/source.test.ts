import { describe, expect, it, vi } from "vite-plus/test";

import { combineClientProfileSources, type ClientProfileValueSource } from "./source.ts";

function fakeSource(
  base: string,
  options: { completePrefixes?: string[]; ready?: Promise<void> } = {},
) {
  const apply = vi.fn(async (values: Readonly<Record<string, unknown>>) => ({ ...values }));
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((_onChange: () => void) => unsubscribe);
  const source: ClientProfileValueSource = {
    owns: (candidate) => candidate === base,
    ready: () => options.ready ?? Promise.resolve(),
    read: () => ({ values: { [base]: 1 }, completePrefixes: options.completePrefixes ?? [] }),
    defaults: () => ({ [base]: 0 }),
    apply,
    subscribe,
  };
  return { source, apply, subscribe, unsubscribe };
}

describe("combineClientProfileSources", () => {
  it("combines value sources and routes applied values to their owner", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = fakeSource("x");
    const second = fakeSource("y", { completePrefixes: ["customTheme."], ready: gate });
    const combined = combineClientProfileSources([first.source, second.source]);

    expect(combined.owns("x")).toBe(true);
    expect(combined.owns("z")).toBe(false);
    expect(combined.read()).toEqual({ values: { x: 1, y: 1 }, completePrefixes: ["customTheme."] });
    expect(combined.defaults()).toEqual({ x: 0, y: 0 });

    await expect(combined.apply({ x: 1, y: 2, z: 3 })).resolves.toEqual({ x: 1, y: 2 });
    expect(first.apply).toHaveBeenCalledWith({ x: 1 });
    expect(second.apply).toHaveBeenCalledWith({ y: 2 });

    let ready = false;
    const pending = combined.ready().then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    release();
    await pending;
    expect(ready).toBe(true);

    const onChange = vi.fn();
    const unsubscribe = combined.subscribe(onChange);
    expect(first.subscribe).toHaveBeenCalledWith(onChange);
    expect(second.subscribe).toHaveBeenCalledWith(onChange);
    unsubscribe();
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    expect(second.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
