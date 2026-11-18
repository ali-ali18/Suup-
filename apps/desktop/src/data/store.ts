import { createStore, type StoreApi } from "zustand/vanilla";
import { type DataState, emptyData } from "./state.js";

export type DataStore = StoreApi<DataState>;

export function createDataStore(): DataStore {
  return createStore<DataState>(() => emptyData());
}

/** Applies a pure reducer to the store. */
export function update(store: DataStore, reducer: (state: DataState) => DataState): void {
  const current = store.getState();
  const next = reducer(current);
  if (next !== current) store.setState(next, true);
}
