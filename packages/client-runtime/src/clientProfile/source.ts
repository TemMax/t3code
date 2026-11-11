import type { ClientProfileLocalRead, ClientProfileSidecar } from "./merge.ts";

export interface ClientProfileValueSource {
  readonly owns: (base: string) => boolean;
  readonly ready: () => Promise<void>;
  readonly read: () => ClientProfileLocalRead;
  readonly defaults: () => Readonly<Record<string, unknown>>;
  /**
   * Resolves to what the store now holds for those bases; a removed key is absent.
   * A value it cannot store is offered again on every pass, so storing nothing must not notify.
   */
  readonly apply: (
    values: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly subscribe: (onChange: () => void) => () => void;
}

export interface ClientProfileSidecarStore {
  readonly load: () => Promise<ClientProfileSidecar>;
  readonly save: (sidecar: ClientProfileSidecar) => Promise<void>;
}

export function combineClientProfileSources(
  sources: ReadonlyArray<ClientProfileValueSource>,
): ClientProfileValueSource {
  return {
    owns: (base) => sources.some((source) => source.owns(base)),
    ready: async () => {
      await Promise.all(sources.map((source) => source.ready()));
    },
    read: () => {
      const reads = sources.map((source) => source.read());
      return {
        values: Object.assign({}, ...reads.map((read) => read.values)),
        completePrefixes: reads.flatMap((read) => read.completePrefixes),
      };
    },
    defaults: () => Object.assign({}, ...sources.map((source) => source.defaults())),
    apply: async (values) => {
      const routed = new Map<ClientProfileValueSource, Record<string, unknown>>();
      for (const [base, value] of Object.entries(values)) {
        const owner = sources.find((source) => source.owns(base));
        if (owner === undefined) continue;
        routed.set(owner, { ...routed.get(owner), [base]: value });
      }
      const stored: Record<string, unknown> = {};
      for (const source of sources) {
        const owned = routed.get(source);
        if (owned !== undefined) Object.assign(stored, await source.apply(owned));
      }
      return stored;
    },
    subscribe: (onChange) => {
      const unsubscribes = sources.map((source) => source.subscribe(onChange));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
  };
}
