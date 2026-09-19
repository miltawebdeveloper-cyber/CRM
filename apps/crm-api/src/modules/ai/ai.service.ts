import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { tzLabel } from '../../common/timezone.js';
import { answerFor } from './knowledge-base.js';

@Injectable()
export class AiService {
  constructor(private readonly prisma: PrismaService) {}

  // AIT-006/007/008 — answer a question and log the session
  async chat(question: string, userId: string) {
    const { answer, topic } = answerFor(question);
    await this.prisma.aiTrainingSession.create({
      data: { userId, question, answer, topic: topic ?? undefined },
    });
    return { answer, topic };
  }

  sessions(userId: string) {
    return this.prisma.aiTrainingSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /** AI-001..003 — data-driven recommendations. */
  async insights() {
    const grouped = await this.prisma.lead.groupBy({
      by: ['state', 'timezone', 'status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });

    // Leads with no zone set are their own bucket rather than being folded into
    // Eastern — a conversion rate for "EST" that quietly includes every
    // unconfigured lead in the database is worse than no number at all.
    const stateAgg = new Map<string, { total: number; closed: number; tz: string }>();
    const tzAgg = new Map<string, { total: number; closed: number }>();
    for (const g of grouped) {
      const zone = tzLabel(g.timezone);
      const s = stateAgg.get(g.state) ?? { total: 0, closed: 0, tz: zone };
      s.total += g._count._all;
      if (g.status === 'closed') s.closed += g._count._all;
      stateAgg.set(g.state, s);

      const t = tzAgg.get(zone) ?? { total: 0, closed: 0 };
      t.total += g._count._all;
      if (g.status === 'closed') t.closed += g._count._all;
      tzAgg.set(zone, t);
    }

    const rate = (closed: number, total: number) => (total > 0 ? (closed / total) * 100 : 0);

    const bestState = [...stateAgg.entries()]
      .map(([state, v]) => ({ state, timezone: v.tz, total: v.total, conversionPct: Number(rate(v.closed, v.total).toFixed(1)) }))
      .filter((s) => s.total >= 3)
      .sort((a, b) => b.conversionPct - a.conversionPct)[0] ?? null;

    const bestTimezone = [...tzAgg.entries()]
      .map(([timezone, v]) => ({ timezone, total: v.total, conversionPct: Number(rate(v.closed, v.total).toFixed(1)) }))
      .sort((a, b) => b.conversionPct - a.conversionPct)[0] ?? null;

    // AI-003 — naive target prediction: progress per state vs target
    const [totalLeads, targetsAgg] = await Promise.all([
      this.prisma.lead.count({ where: { deletedAt: null } }),
      this.prisma.target.aggregate({ _sum: { monthlyTarget: true } }),
    ]);
    const planned = targetsAgg._sum.monthlyTarget ?? 0;
    const overallProgress = planned > 0 ? Number(((totalLeads / planned) * 100).toFixed(2)) : 0;

    return {
      bestStateToday: bestState,
      bestTimezone,
      targetPrediction: {
        totalLeads,
        plannedLeads: planned,
        overallProgressPct: overallProgress,
        note:
          overallProgress >= 100
            ? 'Overall target reached.'
            : `At the current pace, focus on ${bestState?.state ?? 'high-conversion states'} to close the ${Math.max(planned - totalLeads, 0)} remaining leads faster.`,
      },
    };
  }
}
