'use client';

import { useState, useRef, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Building2, FileText, BookOpen, MessageSquare, Bot, Send, Sparkles, RefreshCw, Mic, BookMarked, Target } from 'lucide-react';
import { aiApi } from '@/lib/crm';
import { PageHead, Avatar } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';

const KB = [
  { icon: Building2, t: 'Company Operations', d: 'Services, US markets covered, timezones handled, client industries served', n: 18, bg: '#d8eed9', color: '#266929' },
  { icon: FileText, t: 'Tax Knowledge', d: 'Tax forms, filing processes, common client questions (1099, W-2, deadlines)', n: 42, bg: '#fdecdc', color: '#c98a18' },
  { icon: BookOpen, t: 'Bookkeeping', d: 'QuickBooks, Xero, payroll basics, reconciliation workflows', n: 31, bg: '#dff0ec', color: '#2f6f63' },
  { icon: MessageSquare, t: 'Sales Scripts', d: 'Opening conversations, objection handling, closing methods', n: 24, bg: '#f7e3da', color: '#a8431f' },
];
const COACH: [string, number, string][] = [
  ['Confidence', 78, '#266929'], ['Speaking Pace', 64, '#c98a18'], ['Objection Handling', 82, '#2f6f63'], ['Closing Strength', 58, '#a8431f'],
];

interface Msg { role: 'user' | 'ai'; text: string }

export default function AiTrainingPage() {
  const [messages, setMessages] = useState<Msg[]>([
    { role: 'ai', text: 'Hi! Ask me about tax, bookkeeping, sales scripts, or company operations.' },
  ]);
  const [input, setInput] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const ask = useMutation({ mutationFn: (q: string) => aiApi.chat(q), onSuccess: (r) => setMessages((m) => [...m, { role: 'ai', text: r.answer }]) });

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  function send(q: string) {
    const question = q.trim();
    if (!question || ask.isPending) return;
    setMessages((m) => [...m, { role: 'user', text: question }]);
    setInput('');
    ask.mutate(question);
  }

  return (
    <div>
      <PageHead>
        <button className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[13px] font-semibold hover:bg-muted"><RefreshCw className="h-4 w-4" /> Sync KB</button>
        <button className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[13px] font-semibold text-primary-foreground hover:opacity-90"><Sparkles className="h-4 w-4" /> Run Voice Analysis</button>
      </PageHead>

      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <KpiCard icon={BookMarked} iconBg="#d8eed9" iconColor="#266929" value="115" label="KB Articles" />
        <KpiCard icon={Sparkles} iconBg="#fdecdc" iconColor="#c98a18" value="1,240" label="AI Answers This Week" trend="18%" trendDir="up" />
        <KpiCard icon={Mic} iconBg="#dff0ec" iconColor="#2f6f63" value="86" label="Calls Coached" />
        <KpiCard icon={Target} iconBg="#d8eed9" iconColor="#266929" value="7.8/10" label="Avg Confidence" />
      </div>

      <div className="grid gap-[18px] xl:grid-cols-[7fr_5fr]">
        {/* Knowledge base */}
        <div className="rounded-2xl border bg-card shadow-sm">
          <div className="border-b px-[18px] py-4"><h3 className="font-display text-[15px] font-semibold">Knowledge Base</h3><div className="text-xs text-muted-foreground">Training categories for new employees</div></div>
          <div className="grid gap-3.5 p-[18px] sm:grid-cols-2">
            {KB.map((k) => (
              <div key={k.t} className="cursor-pointer rounded-2xl border bg-card p-[18px] transition-all hover:-translate-y-0.5 hover:shadow-md">
                <div className="mb-3 grid h-[42px] w-[42px] place-items-center rounded-[11px]" style={{ background: k.bg, color: k.color }}><k.icon className="h-[21px] w-[21px]" /></div>
                <div className="font-display text-[14.5px] font-bold">{k.t}</div>
                <div className="my-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{k.d}</div>
                <div className="text-[11.5px] font-semibold text-primary">{k.n} articles</div>
              </div>
            ))}
          </div>
        </div>

        {/* AI assistant */}
        <div className="flex flex-col rounded-2xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b px-[18px] py-4">
            <div><h3 className="font-display text-[15px] font-semibold">AI Assistant</h3><div className="text-xs text-muted-foreground">Instant answers for your team</div></div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#d8eed9] px-2.5 py-[3px] text-[11.5px] font-semibold text-[#266929]"><span className="h-1.5 w-1.5 rounded-full bg-[#266929]" /> Online</span>
          </div>
          <div className="flex max-h-[360px] flex-1 flex-col gap-3.5 overflow-y-auto p-[18px]">
            {messages.map((m, i) => (
              <div key={i}>
                <div className="mb-1.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
                  {m.role === 'user' ? <Avatar name="You" /> : <span className="grid h-6 w-6 place-items-center rounded-full text-white" style={{ background: 'linear-gradient(135deg,#2b732f,#1d491f)' }}><Bot className="h-3.5 w-3.5" /></span>}
                  <b>{m.role === 'user' ? 'You asked' : 'Ranger AI'}</b>
                </div>
                <div className={`rounded-[13px] px-3.5 py-2.5 text-[13.5px] leading-relaxed ${m.role === 'user' ? 'border bg-muted/50' : 'bg-[#1d491f] text-[#eef6ef]'}`}>{m.text}</div>
              </div>
            ))}
            {ask.isPending && <p className="text-sm text-muted-foreground">Thinking…</p>}
            <div ref={endRef} />
          </div>
          <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex gap-2.5 border-t p-[14px]">
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask anything — e.g. How do I handle a pricing objection?" className="flex-1 rounded-[11px] border bg-background px-3.5 py-2.5 text-[13.5px] outline-none focus:border-primary" />
            <button type="submit" disabled={ask.isPending} className="grid place-items-center rounded-[11px] bg-primary px-4 text-primary-foreground disabled:opacity-60"><Send className="h-4 w-4" /></button>
          </form>
        </div>
      </div>

      {/* Voice coaching */}
      <div className="mt-[18px] rounded-2xl border bg-card shadow-sm">
        <div className="border-b px-[18px] py-4"><h3 className="font-display text-[15px] font-semibold">Voice Coaching</h3><div className="text-xs text-muted-foreground">AI analysis of recent call recordings</div></div>
        <div className="p-[18px]">
          <div className="mb-[18px] grid gap-[18px_28px] sm:grid-cols-2">
            {COACH.map(([lab, v, c]) => (
              <div key={lab}>
                <div className="mb-[7px] flex justify-between text-[13px] font-semibold"><span>{lab}</span><b>{v}%</b></div>
                <div className="h-2 overflow-hidden rounded-full bg-[#d8eed9]"><i className="block h-full rounded-full" style={{ width: `${v}%`, background: c }} /></div>
              </div>
            ))}
          </div>
          <div className="flex gap-3 rounded-md border border-[#c7d69f] bg-[#eef6ef] p-[15px] text-[13px] leading-relaxed text-[#163618]">
            <Sparkles className="h-5 w-5 shrink-0 text-[#266929]" />
            <div><b>AI Suggestion:</b> Strong rapport on opening, but 3 missed closing opportunities detected in today&apos;s calls. Try asking for the next step earlier — right after confirming interest.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
