import { AiTopic } from '@crm/database';

export interface KbEntry {
  topic: AiTopic;
  keywords: string[];
  answer: string;
}

// AIT-002..005 — company knowledge base for the onboarding chatbot.
// Rule/keyword based so it works without an external LLM key; the same
// interface can later be backed by OpenAI (ARCH-018) without changing callers.
export const KNOWLEDGE_BASE: KbEntry[] = [
  {
    topic: AiTopic.tax,
    keywords: ['1099', 'form 1099'],
    answer:
      'Form 1099 is a series of IRS information returns used to report income other than wages. The most common, 1099-NEC, reports non-employee compensation of $600+ paid to contractors. The payer files with the IRS and sends a copy to the recipient by Jan 31. Clients use it to report income on their return.',
  },
  {
    topic: AiTopic.tax,
    keywords: ['w-2', 'w2'],
    answer:
      'A W-2 reports wages paid to an employee and taxes withheld. Employers must furnish W-2s to employees by Jan 31. It differs from a 1099, which is for contractors with no withholding.',
  },
  {
    topic: AiTopic.bookkeeping,
    keywords: ['quickbooks', 'xero', 'bookkeeping software'],
    answer:
      'QuickBooks and Xero are the two leading small-business accounting platforms. QuickBooks Online is dominant in the US; Xero is strong for multi-currency and unlimited users. Both handle invoicing, bank reconciliation, and financial reports — core to the bookkeeping services we offer.',
  },
  {
    topic: AiTopic.bookkeeping,
    keywords: ['payroll'],
    answer:
      'Payroll basics: calculate gross pay, withhold federal/state income tax, FICA (Social Security + Medicare), remit to agencies, and file quarterly (Form 941) and annual (W-2/W-3) returns. Most clients run payroll through QuickBooks Payroll or Gusto.',
  },
  {
    topic: AiTopic.sales_script,
    keywords: ['florida', 'florida client'],
    answer:
      'Florida client script — Opening: "Hi, this is [name] with our tax & bookkeeping team. Many Florida small businesses we work with are focused on staying ahead of quarterly estimates — is that on your radar?" Objection (too busy): acknowledge, offer a 15-min review. Close: "Can I set up a quick call this week to map out your filings?"',
  },
  {
    topic: AiTopic.sales_script,
    keywords: ['objection', 'too expensive', 'price'],
    answer:
      'Price objection handling: don\'t discount immediately. Reframe around value/time saved and penalty avoidance. "I understand — most clients find our fee is less than the late-filing penalties and the hours they get back. Could we look at the package that fits your size?"',
  },
  {
    topic: AiTopic.company_ops,
    keywords: ['services', 'what do we offer', 'timezone', 'markets'],
    answer:
      'We are a US tax & bookkeeping firm running outbound sales across every US timezone (EST, CST, MST, PST, AKST, HST) plus the UK and India, organized by Timezone → State → City. Services: tax prep & filing, monthly bookkeeping, payroll, and advisory for small businesses and CPAs.',
  },
];

export function answerFor(question: string): { answer: string; topic: AiTopic | null } {
  const q = question.toLowerCase();
  for (const entry of KNOWLEDGE_BASE) {
    if (entry.keywords.some((k) => q.includes(k))) {
      return { answer: entry.answer, topic: entry.topic };
    }
  }
  return {
    answer:
      "I don't have a specific answer for that yet. Try asking about Form 1099, W-2, QuickBooks, payroll, handling a price objection, or how to talk to a Florida client.",
    topic: null,
  };
}
