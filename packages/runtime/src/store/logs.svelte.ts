import { getLedgerClient, type LogLineageIndex, type LogListResponse, type LogSummary } from "../ledger/index.js";
import { get as getKv, set as setKv } from '../db/kv.js';
import { getLedgerCacheKey } from './local-context.js';

class LogsStore {
  #value = $state<LogSummary[]>([]);
  #lineage = $state<LogLineageIndex | null>(null);

  get value() {
    return this.#value;
  }

  get lineage() {
    return this.#lineage;
  }

  get names() {
    return this.#value.map((log) => log.name);
  }

  async loadCached() {
    try {
      const cached = await getKv<LogListResponse | LogSummary[]>(await getLedgerCacheKey('logs'));
      if (Array.isArray(cached)) {
        this.#value = cached;
        this.#lineage = null;
      } else if (cached) {
        this.#value = cached.logs;
        this.#lineage = cached.lineage ?? null;
      }
    } catch {
      // A missing credential has no safe cache namespace.
    }
  }

  /** Hides or shows a log in the tree. The list updates once Ledger confirms. */
  async setHidden(logId: string, hidden: boolean) {
    const updated = await getLedgerClient().setLogVisibility(logId, hidden);
    this.#value = this.#value.map((log) => (log.id === logId ? { ...log, hiddenAt: updated.hiddenAt ?? null } : log));
    try {
      await setKv(await getLedgerCacheKey('logs'), { logs: this.#value, lineage: this.#lineage ?? undefined });
    } catch {
      // The next refresh rewrites the cache.
    }
  }

  async refresh() {
    await this.loadCached();
    try {
      const response = await getLedgerClient().listLogsResponse();
      this.#value = response.logs;
      this.#lineage = response.lineage ?? null;
      await setKv(await getLedgerCacheKey('logs'), response);
    } catch (e) {
      // ignore refresh errors; UI will keep last known list
    }
  }
}

export const logs = new LogsStore();
