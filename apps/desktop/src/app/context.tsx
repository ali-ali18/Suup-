import type { SuupClient } from "@suup/api";
import { createContext, type ReactNode, useContext } from "react";
import { useStore } from "zustand";
import type { DataState } from "../data/state.js";
import type { DataStore } from "../data/store.js";
import type { Sync } from "../data/sync.js";
import type { Connection, Platform, ServerMode } from "../lib/platform.js";

export interface Services {
  api: SuupClient;
  sync: Sync;
  data: DataStore;
  platform: Platform;
  connection: Connection;
  /** Which server this device uses: the one the app carries, or the owner's own. */
  mode: ServerMode;
  /** Forgets the saved connection and goes back to the connect screen (local: the first-run choice). */
  disconnect(): Promise<void>;
  /** Stops using this server and goes back to the first-run choice (the data stays where it is). */
  switchServer(): Promise<void>;
}

const Ctx = createContext<Services | null>(null);

export function ServicesProvider({
  services,
  children,
}: {
  services: Services;
  children: ReactNode;
}) {
  return <Ctx.Provider value={services}>{children}</Ctx.Provider>;
}

export function useServices(): Services {
  const services = useContext(Ctx);
  if (services === null) throw new Error("ServicesProvider ausente");
  return services;
}

/** Reads a part of the data store. Select stable references (a record, a slice), not new arrays. */
export function useData<T>(selector: (state: DataState) => T): T {
  return useStore(useServices().data, selector);
}
