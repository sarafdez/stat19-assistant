import { useEffect, useMemo, useState } from "react";
import type { PanelTarget } from "./App.tsx";
import { api, type DbtHit, type DbtSource, type DbtSummary } from "./lib/api.ts";
import { hueFor } from "./lib/hue.ts";

export default function DbtPanel({ fromChat }: { fromChat: PanelTarget | null }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DbtHit[]>([]);
  const [all, setAll] = useState<DbtSummary[]>([]);
  const [source, setSource] = useState<DbtSource | null>(null);
  const [openedByChat, setOpenedByChat] = useState(false);
  const [columnFilter, setColumnFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.dbtSources().then(setAll).catch((e) => setError(e.message));
  }, []);

  const open = (id: string, byChat = false) => {
    setOpenedByChat(byChat);
    setColumnFilter("");
    api.dbtSource(id).then(setSource).catch((e) => setError(e.message));
  };

  // Open what the user clicked on in the chat — nothing opens on its own.
  useEffect(() => {
    if (fromChat) open(fromChat.id, true);
  }, [fromChat]);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      api.dbtSearch(query).then(setHits).catch((e) => setError(e.message));
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  const registers = useMemo(() => {
    const grouped = new Map<string, DbtSummary[]>();
    for (const s of all) grouped.set(s.register, [...(grouped.get(s.register) ?? []), s]);
    return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0], "nb"));
  }, [all]);

  const columns = source?.columns.filter((c) =>
    columnFilter.trim() ? (c.name + " " + c.description).toLowerCase().includes(columnFilter.toLowerCase()) : true,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ background: "var(--surface-panel)" }}>
      <div
        className="flex items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border-soft)", background: "var(--dbt-soft)" }}
      >
        <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--dbt)" }}>
          Dataprodukter
        </span>
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          {all.length}
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Søk dataprodukt eller variabel…"
          className="ml-auto min-w-0 flex-1 rounded-md border px-2 py-1 text-xs outline-none"
          style={{ borderColor: "var(--border-strong)", background: "var(--surface-panel)", color: "var(--text-strong)" }}
        />
        {source && (
          <button
            onClick={() => {
              setSource(null);
              setOpenedByChat(false);
            }}
            className="rounded-md border px-2 py-1 text-[11px] whitespace-nowrap"
            style={{ borderColor: "var(--border-strong)", color: "var(--text-muted)" }}
          >
            ← Oversikt
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {error && <p className="pt-2 text-xs" style={{ color: "var(--warn)" }}>{error}</p>}

        {source ? (
          <div>
            <header className="mb-2 border-b pt-3 pb-2" style={{ borderColor: "var(--border-soft)" }}>
              <div className="flex items-center gap-2">
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                  style={{ background: hueFor(source.register).bg, color: hueFor(source.register).fg }}
                >
                  {source.register}
                </span>
                <h3 className="text-sm font-semibold">{source.name}</h3>
                {openedByChat && (
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium whitespace-nowrap"
                    style={{ background: "var(--accent-soft)", color: "var(--accent-strong)" }}
                  >
                    fra samtalen
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                {source.schema}.{source.identifier} · {source.columns.length} kolonner
              </p>
              {source.description && (
                <p className="mt-1.5 text-xs" style={{ color: "var(--text-strong)" }}>
                  {source.description}
                </p>
              )}
            </header>
            <input
              value={columnFilter}
              onChange={(e) => setColumnFilter(e.target.value)}
              placeholder="Filtrer kolonner…"
              className="mb-2 w-full rounded-md border px-2 py-1 text-xs outline-none"
              style={{ borderColor: "var(--border-soft)", background: "var(--surface-sunken)", color: "var(--text-strong)" }}
            />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead>
                  <tr style={{ background: "var(--dbt-soft)", color: "var(--dbt)" }}>
                    <th className="rounded-l px-2 py-1 font-medium">Kolonne</th>
                    <th className="px-2 py-1 font-medium">Type</th>
                    <th className="rounded-r px-2 py-1 font-medium">Beskrivelse</th>
                  </tr>
                </thead>
                <tbody>
                  {columns?.map((col, i) => (
                    <tr
                      key={col.name}
                      className="align-top"
                      style={{ background: i % 2 ? "var(--surface-sunken)" : "transparent" }}
                    >
                      <td className="px-2 py-1 font-mono" style={{ color: "var(--accent-strong)" }}>
                        {col.name}
                        {col.codeName && (
                          <span className="ml-1 font-sans text-[10px]" style={{ color: "var(--text-muted)" }}>
                            (dbt: {col.codeName})
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1" style={{ color: "var(--dbt)" }}>
                        {col.type ?? "—"}
                      </td>
                      <td className="px-2 py-1">{col.description || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : query.trim() ? (
          <ul className="flex flex-col gap-1 pt-2">
            {hits.map((hit) => (
              <li key={hit.id}>
                <button
                  onClick={() => open(hit.id)}
                  className="w-full rounded-lg border px-2.5 py-2 text-left transition-colors hover:brightness-[0.98]"
                  style={{ borderColor: "var(--border-soft)", background: "var(--surface-sunken)" }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[10px]"
                      style={{ background: hueFor(hit.register).bg, color: hueFor(hit.register).fg }}
                    >
                      {hit.register}
                    </span>
                    <span className="text-xs font-medium">{hit.label.split(".")[1]}</span>
                  </div>
                  {!!hit.matchedColumns.length && (
                    <p className="mt-0.5 font-mono text-[10px]" style={{ color: "var(--dbt)" }}>
                      {hit.matchedColumns.map((c) => c.name).slice(0, 8).join(", ")}
                    </p>
                  )}
                </button>
              </li>
            ))}
            {!hits.length && (
              <li className="pt-3 text-xs" style={{ color: "var(--text-muted)" }}>
                Ingen treff i dbt-metadata.
              </li>
            )}
          </ul>
        ) : (
          <div className="flex flex-col gap-2 pt-2">
            {registers.map(([register, items]) => {
              const hue = hueFor(register);
              return (
                <div key={register}>
                  <div className="mb-1 flex items-center gap-2">
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                      style={{ background: hue.bg, color: hue.fg }}
                    >
                      {register}
                    </span>
                    <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                      {items.length} dataprodukt{items.length === 1 ? "" : "er"}
                    </span>
                  </div>
                  <ul className="ml-1 flex flex-wrap gap-1">
                    {items.map((item) => (
                      <li key={item.id}>
                        <button
                          onClick={() => open(item.id)}
                          className="rounded-md border px-2 py-1 text-[11px] transition-colors hover:bg-[var(--surface-hover)]"
                          style={{ borderColor: "var(--border-soft)" }}
                          title={item.description || undefined}
                        >
                          {item.name}
                          <span className="ml-1" style={{ color: "var(--text-muted)" }}>
                            {item.columnCount}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
