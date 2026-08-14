import { Injectable } from '@nestjs/common';
import { Role } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ActivitiesService {
  constructor(private readonly prisma: PrismaService) {}

  // SEC-004 — audit/activity log, newest first.
  // RBAC: employees see only their own activity; team leaders + admins see the
  // whole team (no team model yet, so "team" = all callers).
  list(user: { id: string; role: Role }, limit = 100) {
    const where = user.role === Role.employee ? { userId: user.id } : {};
    return this.prisma.activity.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      include: {
        user: { select: { id: true, name: true, email: true } },
        lead: { select: { id: true, businessName: true } },
      },
    });
  }

  // Lead History — the controller restricts this to Admin + Team Leader, so
  // employees never reach here; managers see the full trail for any lead.
  listLead(leadId: string, _user: { id: string; role: Role }, limit = 100) {
    return this.prisma.activity.findMany({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      include: {
        user: { select: { id: true, name: true, email: true } },
        // `timezone` so the log can stamp each entry on the LEAD's clock rather
        // than the reader's. Without it a manager in India reads an American
        // lead's afternoon activity as having happened the following day.
        lead: { select: { id: true, leadId: true, businessName: true, timezone: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    });
  }
}
