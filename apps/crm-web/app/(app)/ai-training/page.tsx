'use client';

import { useState, useRef, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Building2, FileText, BookOpen, MessageSquare, Bot, Send } from 'lucide-react';
import { aiApi } from '@/lib/crm';
import { Avatar } from '@/components/page-head';

/**
 * The topics the AI Assistant answers on (api: modules/ai/knowledge-base).
 *
 * This page used to show numbers nothing measured — "115 KB articles", "1,240
 * AI answers this week ▲18%", "86 calls coached", "7.8/10 confidence", an
 * article count on each topic (the knowledge base holds nine entries), and a
 * Voice Coaching panel of fixed scores with a canned "3 missed closing
 * opportunities detected in today's calls". Its Sync KB and Run Voice Analysis
 * buttons did nothing. All of that went; the assistant itself is real and stays.
 */
const KB = [
  { icon: Building2, t: 'Company Operations', d: 'Services, US markets covered, timezones handled, client industries served', bg: 'var(--brand-surface)', color: 'var(--brand-on-surface)' },
  { icon: FileText, t: 'Tax Knowledge', d: 'Tax forms, filing processes, common client questions (1099, W-2, deadlines)', bg: 'var(--tone-amber-bg-2)', color: 'var(--tone-amber-fg)' },
  { icon: BookOpen, t: 'Bookkeeping', d: 'QuickBooks, Xero, payroll basics, reconciliation workflows', bg: 'var(--tone-teal-bg-2)', color: 'var(--tone-teal-fg)' },
  { icon: MessageSquare, t: 'Sales Scripts', d: 'Opening conversations, objection handling, closing methods', bg: '#f7e3da', color: 'var(--tone-red-fg-2)' },
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
      <div className="grid gap-[18px] xl:grid-cols-[7fr_5fr]">
        {/* Knowledge base — the topics, not clickable: there is nothing behind a card to open. */}
        <div className="rounded-2xl border bg-card shadow-sm">
          <div className="border-b px-[18px] py-4"><h3 className="font-display text-[14px] font-semibold">Knowledge Base</h3><div className="text-xs text-muted-foreground">Topics the AI Assistant can answer questions on</div></div>
          <div className="grid gap-3.5 p-[18px] sm:grid-cols-2">
            {KB.map((k) => (
              <div key={k.t} className="rounded-2xl border bg-card p-[18px]">
                <div className="mb-3 grid h-[42px] w-[42px] place-items-center rounded-[11px]" style={{ background: k.bg, color: k.color }}><k.icon className="h-[21px] w-[21px]" /></div>
                <div className="font-display text-[13.5px] font-bold">{k.t}</div>
                <div className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{k.d}</div>
              </div>
            ))}
          </div>
        </div>

        {/* AI assistant */}
        <div className="flex flex-col rounded-2xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b px-[18px] py-4">
            <div><h3 className="font-display text-[14px] font-semibold">AI Assistant</h3><div className="text-xs text-muted-foreground">Instant answers for your team</div></div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--brand-surface)] px-2.5 py-[3px] text-[11px] font-semibold text-[var(--brand-on-surface)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--brand)]" /> Online</span>
          </div>
          <div className="flex max-h-[360px] flex-1 flex-col gap-3.5 overflow-y-auto p-[18px]">
            {messages.map((m, i) => (
              <div key={i}>
                <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                  {m.role === 'user' ? <Avatar name="You" /> : <span className="grid h-6 w-6 place-items-center rounded-full text-white" style={{ background: 'linear-gradient(135deg,var(--brand-mid),var(--brand-deep))' }}><Bot className="h-3.5 w-3.5" /></span>}
                  <b>{m.role === 'user' ? 'You asked' : 'Ranger AI'}</b>
                </div>
                <div className={`rounded-[13px] px-3.5 py-2.5 text-[13px] leading-relaxed ${m.role === 'user' ? 'border bg-muted/50' : 'bg-[var(--brand-deep)] text-[#f3f5ef]'}`}>{m.text}</div>
              </div>
            ))}
            {ask.isPending && <p className="text-sm text-muted-foreground">Thinking…</p>}
            <div ref={endRef} />
          </div>
          <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex gap-2.5 border-t p-[14px]">
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask anything — e.g. How do I handle a pricing objection?" className="flex-1 rounded-[11px] border bg-background px-3.5 py-2.5 text-[13px] outline-none focus:border-primary" />
            <button type="submit" disabled={ask.isPending} className="grid place-items-center rounded-[11px] bg-primary px-4 text-primary-foreground disabled:opacity-60"><Send className="h-4 w-4" /></button>
          </form>
        </div>
      </div>
    </div>
  );
}
