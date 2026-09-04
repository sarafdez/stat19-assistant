export type Status = {
  wiki: {
    present: boolean;
    pages: number;
    lastEdited: string | null;
    lastPulled: string | null;
    headSubject: string | null;
    stale: boolean;
    error: string | null;
  };
  dbt: {
    present: boolean;
    sources: number;
    columns: number;
    builtAt: string | null;
    fileTime: string | null;
    stale: boolean;
    error: string | null;
  };
};

export type ModelChoice = {
  id: string;
  label: string;
  hint: string;
  inputPrice: number;
  outputPrice: number;
  supportsEffort: boolean;
};
export type EffortChoice = { id: string; label: string; hint: string };
export type ModelsResponse = { models: ModelChoice[]; efforts: EffortChoice[] };
export type WikiHit = { id: string; title: string; breadcrumb: string[]; score: number; snippet: string };
export type WikiEntry = { id: string; title: string; breadcrumb: string[]; section: string };
export type WikiPage = { id: string; title: string; breadcrumb: string[]; markdown: string };
export type DbtColumn = { name: string; codeName: string | null; type: string | null; description: string };
export type DbtHit = {
  id: string;
  label: string;
  register: string;
  description: string;
  matchedColumns: DbtColumn[];
  score: number;
};
export type DbtSource = {
  id: string;
  register: string;
  name: string;
  label: string;
  schema: string;
  identifier: string;
  description: string;
  registerDescription: string;
  columns: DbtColumn[];
};
export type DbtSummary = Omit<DbtSource, "columns"> & { columnCount: number };
export type Attachment =
  | { kind: "pdf"; name: string; base64: string }
  | { kind: "text"; name: string; text: string };

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json() as Promise<T>;
}

export const api = {
  status: () => json<Status>("/api/status"),
  models: () => json<ModelsResponse>("/api/models"),
  pullWiki: () => json<{ ok: boolean; output: string; status: Status }>("/api/refresh/wiki", { method: "POST" }),
  reloadDbt: () => json<{ ok: boolean; status: Status }>("/api/refresh/dbt", { method: "POST" }),
  wikiPages: () => json<WikiEntry[]>("/api/wiki/pages"),
  wikiSearch: (q: string) => json<WikiHit[]>(`/api/wiki/search?q=${encodeURIComponent(q)}`),
  wikiPage: (id: string) => json<WikiPage>(`/api/wiki/page?id=${encodeURIComponent(id)}`),
  dbtSearch: (q: string) => json<DbtHit[]>(`/api/dbt/search?q=${encodeURIComponent(q)}`),
  dbtSource: (id: string) => json<DbtSource>(`/api/dbt/source?id=${encodeURIComponent(id)}`),
  dbtSources: () => json<DbtSummary[]>("/api/dbt/sources"),
  saveDraft: (name: string, content: string) =>
    json<{ path: string; absolute: string }>("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content }),
    }),
  upload: async (files: File[]): Promise<Attachment[]> => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Opplasting feilet");
    return (await res.json()).attachments as Attachment[];
  },
};

export function formatDate(iso: string | null): string {
  if (!iso) return "ukjent";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "ukjent" : d.toLocaleDateString("nb-NO", { day: "2-digit", month: "2-digit", year: "numeric" });
}
