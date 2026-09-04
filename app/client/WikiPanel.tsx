import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PanelTarget } from "./App.tsx";
import { api, type WikiEntry, type WikiHit, type WikiPage } from "./lib/api.ts";
import { hueFor } from "./lib/hue.ts";

/** Wiki pages reference images as /.attachments/... — serve them from the clone. */
function rewriteAssets(markdown: string): string {
  return markdown.replace(/\((\/?\.attachments\/)/g, "(/wiki-assets/.attachments/");
}

export default function WikiPanel({ fromChat }: { fromChat: PanelTarget | null }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<WikiHit[]>([]);
  const [pages, setPages] = useState<WikiEntry[]>([]);
  const [page, setPage] = useState<WikiPage | null>(null);
  const [openedByChat, setOpenedByChat] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.wikiPages().then(setPages).catch((e) => setError(e.message));
  }, []);

  const open = (id: string, byChat = false) => {
    setOpenedByChat(byChat);
    api.wikiPage(id).then(setPage).catch((e) => setError(e.message));
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
      api.wikiSearch(query).then(setHits).catch((e) => setError(e.message));
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  const sections = useMemo(() => {
    const grouped = new Map<string, WikiEntry[]>();
    for (const entry of pages) grouped.set(entry.section, [...(grouped.get(entry.section) ?? []), entry]);
    return [...grouped.entries()];
  }, [pages]);

  const body = useMemo(() => (page ? rewriteAssets(page.markdown) : ""), [page]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ background: "var(--surface-panel)" }}>
      <div
        className="flex items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border-soft)", background: "var(--wiki-soft)" }}
      >
        <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--wiki)" }}>
          Wiki
        </span>
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          {pages.length} sider
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Søk i wikien…"
          className="ml-auto min-w-0 flex-1 rounded-md border px-2 py-1 text-xs outline-none focus:border-current"
          style={{ borderColor: "var(--border-strong)", background: "var(--surface-panel)", color: "var(--text-strong)" }}
        />
        {page && (
          <button
            onClick={() => {
              setPage(null);
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

        {page ? (
          <article>
            <header className="mb-2 border-b pt-3 pb-2" style={{ borderColor: "var(--border-soft)" }}>
              <div className="flex items-start gap-2">
                <h3 className="text-sm font-semibold">{page.title}</h3>
                {openedByChat && (
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium whitespace-nowrap"
                    style={{ background: "var(--accent-soft)", color: "var(--accent-strong)" }}
                  >
                    fra samtalen
                  </span>
                )}
              </div>
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                {page.breadcrumb.join(" / ") || "rot"}
              </p>
            </header>
            <div className="prose-wiki">
              <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
            </div>
          </article>
        ) : query.trim() ? (
          <ul className="flex flex-col gap-1 pt-2">
            {hits.map((hit) => {
              const hue = hueFor(hit.breadcrumb[0] ?? hit.title);
              return (
                <li key={hit.id}>
                  <button
                    onClick={() => open(hit.id)}
                    className="w-full rounded-lg border px-2.5 py-2 text-left transition-colors hover:brightness-[0.98]"
                    style={{ borderColor: "var(--border-soft)", background: "var(--surface-sunken)" }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">{hit.title}</span>
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[10px]"
                        style={{ background: hue.bg, color: hue.fg }}
                      >
                        {hit.breadcrumb[0] ?? "rot"}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                      {hit.snippet}
                    </p>
                  </button>
                </li>
              );
            })}
            {!hits.length && (
              <li className="pt-3 text-xs" style={{ color: "var(--text-muted)" }}>
                Ingen treff.
              </li>
            )}
          </ul>
        ) : (
          <div className="flex flex-col gap-1 pt-2">
            {sections.map(([section, entries]) => {
              const hue = hueFor(section);
              const isOpen = openSections[section] ?? false;
              return (
                <div key={section}>
                  <button
                    onClick={() => setOpenSections((prev) => ({ ...prev, [section]: !isOpen }))}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
                    style={{ background: hue.bg }}
                  >
                    <span className="text-[11px]" style={{ color: hue.fg }}>
                      {isOpen ? "▾" : "▸"}
                    </span>
                    <span className="text-xs font-medium" style={{ color: hue.fg }}>
                      {section}
                    </span>
                    <span className="ml-auto text-[10px]" style={{ color: hue.fg }}>
                      {entries.length}
                    </span>
                  </button>
                  {isOpen && (
                    <ul className="mt-0.5 mb-1 ml-4 flex flex-col border-l pl-2" style={{ borderColor: "var(--border-soft)" }}>
                      {entries.map((entry) => (
                        <li key={entry.id}>
                          <button
                            onClick={() => open(entry.id)}
                            className="w-full rounded px-1.5 py-1 text-left text-[11px] hover:bg-[var(--surface-hover)]"
                          >
                            {entry.breadcrumb.length > 1 && (
                              <span style={{ color: "var(--text-muted)" }}>
                                {entry.breadcrumb.slice(1).join(" / ")} /{" "}
                              </span>
                            )}
                            {entry.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
