import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Prisma, Role } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { TrustedDeviceService } from '../auth/trusted-device.service';
import { CreateUserDto, UpdateUserDto, ListUsersQueryDto } from './dto/user.dto';

// Never leak secrets — select excludes passwordHash / mfaSecret.
const SAFE_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  mfaEnabled: true,
  availability: true,
  shiftStart: true,
  openphoneNumber: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: TrustedDeviceService,
  ) {}

  /**
   * A caller ID (OpenPhone number) identifies exactly one employee to the customer,
   * so it must be unique. Rejects a number already assigned to another user with a
   * clear message, before the DB's unique constraint would raise a raw error.
   */
  private async assertNumberAvailable(openphoneNumber: string, exceptUserId?: string) {
    const clash = await this.prisma.user.findFirst({
      where: { openphoneNumber, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) },
      select: { name: true },
    });
    if (clash) {
      throw new ConflictException(`Caller ID ${openphoneNumber} is already assigned to ${clash.name}. Each user needs a unique number.`);
    }
  }

  // LGN-012 — admin user list, filterable by role/status
  async findAll(query: ListUsersQueryDto) {
    return this.prisma.user.findMany({
      where: { role: query.role, isActive: query.isActive },
      select: SAFE_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: SAFE_SELECT });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  // LGN-009 — create user
  async create(dto: CreateUserDto) {
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) throw new ConflictException('Email already in use');

    const number = dto.openphoneNumber?.trim();
    if (number) await this.assertNumberAvailable(number);

    const passwordHash = await bcrypt.hash(dto.password, 12); // SEC-005
    return this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        role: dto.role,
        passwordHash,
        ...(number ? { openphoneNumber: number } : {}),
        ...(dto.role === 'employee' ? { employee: { create: {} } } : {}),
      },
      select: SAFE_SELECT,
    });
  }

  // LGN-010 — edit user (name/email/role/password)
  async update(id: string, dto: UpdateUserDto) {
    await this.findOne(id);
    // A non-empty number must be free (not held by another user) before assigning.
    if (dto.openphoneNumber !== undefined && dto.openphoneNumber.trim()) {
      await this.assertNumberAvailable(dto.openphoneNumber.trim(), id);
    }
    const data: Prisma.UserUpdateInput = {
      name: dto.name,
      email: dto.email,
      role: dto.role,
      isActive: dto.isActive,
      ...(dto.shiftStart !== undefined ? { shiftStart: dto.shiftStart.trim() || null } : {}),
      ...(dto.openphoneNumber !== undefined ? { openphoneNumber: dto.openphoneNumber.trim() || null } : {}),
    };
    if (dto.password) data.passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.user.update({ where: { id }, data, select: SAFE_SELECT });
    // A new password must not leave devices behind that can still skip the OTP —
    // otherwise the reset doesn't actually lock out whoever had the old one.
    if (dto.password) await this.devices.revokeOnSecurityChange(id, 'password change');
    // Same for an account switched off from this form: see `deactivate`.
    if (dto.isActive === false) await this.devices.revokeOnSecurityChange(id, 'account deactivation');
    return user;
  }

  // LGN-011 — deactivate (soft); deactivated users cannot login
  async deactivate(id: string) {
    await this.findOne(id);
    const user = await this.prisma.user.update({
      where: { id },
      data: { isActive: false },
      select: SAFE_SELECT,
    });
    // Pulling access has to take device trust with it. `isActive` alone only
    // blocks the login while it is false — reactivating the account later would
    // otherwise hand every previously trusted browser a straight walk back in,
    // no code asked, which is precisely what deactivating was meant to stop.
    await this.devices.revokeOnSecurityChange(id, 'account deactivation');
    return user;
  }

  /**
   * Permanently delete a user (admin only) — for an account that was created in
   * error, never used, or duplicated.
   *
   * DELETING A USER IS NOT THE SAME AS RETIRING ONE, and this refuses to pretend
   * otherwise. A user who has called, written a note, been assigned a lead or
   * closed one is the ATTRIBUTION on that record: "who made this call" is part of
   * what the record means, and the reports, the activity log and the assignment
   * history are all built on it. Removing the person would either destroy that
   * history or leave it pointing at nobody, and neither is a thing an admin
   * should be able to do by clicking a bin icon.
   *
   * So the rule is simple and stated to the caller: a user with recorded work
   * cannot be deleted, only DEACTIVATED — which is the operation that already
   * exists and is the right one for somebody who has left. Delete is for the
   * account that has no history to protect.
   *
   * The database agrees, incidentally: `Call.caller`, `Note.createdBy`,
   * `Activity.user`, `Assignment.caller` and friends are required relations with
   * no cascade, so the delete would fail on a foreign key anyway. The check below
   * exists so the admin gets a sentence naming what is in the way, rather than a
   * constraint violation.
   */
  async remove(id: string, actor: { id: string }) {
    const user = await this.findOne(id);

    // Deleting the account you are signed in as would end your own session
    // mid-request and leave the deletion half-explained.
    if (id === actor.id) {
      throw new ConflictException('You cannot delete the account you are signed in as.');
    }

    // The last way into the system must stay open. Counted over ACTIVE admins:
    // a deactivated one cannot log in, so they are no safety net.
    if (user.role === Role.admin) {
      const otherAdmins = await this.prisma.user.count({
        where: { role: Role.admin, isActive: true, id: { not: id } },
      });
      if (otherAdmins === 0) {
        throw new ConflictException(
          'This is the only active admin. Promote another user to admin before deleting this one, or nobody can administer the system.',
        );
      }
    }

    const blockers = await this.workAttachedTo(id);
    if (blockers.length > 0) {
      throw new ConflictException(
        `${user.name} has recorded work and cannot be deleted: ${blockers.join(', ')}. ` +
          `Deactivate the account instead — it blocks sign-in and keeps their history attributed to them.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // The user's own inbox and coaching material — theirs alone, meaningful to
      // nobody once the account is gone, and both are required relations so they
      // have to go first. Login codes, trusted devices, saved preferences, the
      // employee row and personal tasks are all ON DELETE CASCADE and follow the
      // user row down without being named here.
      await tx.notification.deleteMany({ where: { userId: id } });
      await tx.aiTrainingSession.deleteMany({ where: { userId: id } });
      await tx.user.delete({ where: { id } });
      // Audit trail: written against the ADMIN who did it, with a null lead, so
      // it survives the account it describes. Attributing it to the deleted user
      // would have deleted the record along with them.
      await tx.activity.create({
        data: {
          leadId: null,
          userId: actor.id,
          action: 'user_deleted',
          oldValue: user.email,
          newValue: null,
          remarks: `Permanently deleted user ${user.name} (${user.email}, ${user.role}). The account had no recorded work.`,
        },
      });
    });

    // Nothing should be able to sign back in on a device trusted by an account
    // that no longer exists.
    await this.devices.revokeOnSecurityChange(id, 'account deletion');
    return { id, deleted: true };
  }

  /**
   * What this user has recorded, as phrases ready to drop into a refusal.
   *
   * Every relation here either attributes a business record to the user or
   * points a live record at them; each one is also a required or restricted
   * foreign key, so the list is both "why you shouldn't" and "why you can't".
   * Empty means the account never did anything and is safe to remove.
   */
  private async workAttachedTo(id: string): Promise<string[]> {
    const [calls, activities, notes, assignedLeads, closedLeads, assignments, handovers, productivity, coaching, meetings, targets, messages, followups] =
      await this.prisma.$transaction([
        this.prisma.call.count({ where: { callerId: id } }),
        // The user's own trail. `assignedToId` is the other way an activity
        // points at somebody, and it restricts the delete just as hard.
        this.prisma.activity.count({ where: { OR: [{ userId: id }, { assignedToId: id }] } }),
        this.prisma.note.count({ where: { createdById: id } }),
        this.prisma.lead.count({ where: { assignedToId: id } }),
        this.prisma.lead.count({ where: { closedById: id } }),
        this.prisma.assignment.count({ where: { callerId: id } }),
        this.prisma.assignment.count({ where: { OR: [{ assignedById: id }, { previousCallerId: id }] } }),
        this.prisma.productivityLog.count({ where: { callerId: id } }),
        this.prisma.voiceCoachingReport.count({ where: { callerId: id } }),
        this.prisma.zoomMeeting.count({ where: { organizerId: id } }),
        this.prisma.target.count({ where: { setById: id } }),
        this.prisma.message.count({ where: { senderId: id } }),
        this.prisma.leadFollowup.count({ where: { OR: [{ assignedToId: id }, { completedById: id }] } }),
      ]);

    const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
    const found: string[] = [];
    if (calls) found.push(plural(calls, 'call'));
    if (activities) found.push(plural(activities, 'activity', 'activities'));
    if (notes) found.push(plural(notes, 'note'));
    if (assignedLeads) found.push(`${plural(assignedLeads, 'lead')} assigned to them`);
    if (closedLeads) found.push(`${plural(closedLeads, 'lead')} they closed`);
    if (assignments) found.push(plural(assignments, 'lead assignment'));
    if (handovers) found.push(plural(handovers, 'handover they made'));
    if (productivity) found.push(plural(productivity, 'productivity record'));
    if (coaching) found.push(plural(coaching, 'coaching report'));
    if (meetings) found.push(plural(meetings, 'Zoom meeting'));
    if (targets) found.push(plural(targets, 'target they set'));
    if (messages) found.push(plural(messages, 'SMS'));
    if (followups) found.push(plural(followups, 'follow-up'));
    return found;
  }
}
