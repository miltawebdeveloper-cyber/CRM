import { Construction } from 'lucide-react';

export interface Req {
  id: string;
  name: string;
  desc: string;
  priority?: 'Critical' | 'High' | 'Medium' | 'Low';
}

export interface ReqGroup {
  category: string;
  items: Req[];
}

const PRIORITY_BADGE: Record<string, string> = {
  Critical: 'bg-red-100 text-red-700',
  High: 'bg-orange-100 text-orange-700',
  Medium: 'bg-amber-100 text-amber-700',
  Low: 'bg-muted text-muted-foreground',
};

export function ModulePage({
  code,
  summary,
  groups,
  status = 'Scaffolded from requirements — backend wiring in progress.',
}: {
  code?: string;
  summary: string;
  groups: ReqGroup[];
  status?: string;
}) {
  return (
    <div className="space-y-6">
      {/* Summary + status banner */}
      <div className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <p className="max-w-3xl text-[12.5px] leading-relaxed text-muted-foreground">{summary}</p>
          {code && (
            <span className="shrink-0 rounded-md bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
              {code}
            </span>
          )}
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-[11.5px] text-amber-700">
          <Construction className="h-4 w-4 shrink-0" />
          <span>{status}</span>
        </div>
      </div>

      {/* Requirement groups */}
      {groups.map((group) => (
        <section key={group.category}>
          <h3 className="mb-3 text-[12.5px] font-semibold text-foreground">{group.category}</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {group.items.map((req) => (
              <div
                key={req.id}
                className="flex flex-col rounded-lg border bg-card p-4 shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="font-mono text-[10.5px] text-muted-foreground">{req.id}</span>
                  {req.priority && (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${
                        PRIORITY_BADGE[req.priority] ?? PRIORITY_BADGE.Low
                      }`}
                    >
                      {req.priority}
                    </span>
                  )}
                </div>
                <p className="text-[12.5px] font-medium">{req.name}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{req.desc}</p>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
