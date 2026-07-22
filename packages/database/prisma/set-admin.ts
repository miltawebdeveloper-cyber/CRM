// Create (or update) an admin user on whatever database DATABASE_URL points at —
// use it to set up the live admin login without the seed's fixed credentials.
//
// Usage (from repo root):
//   DATABASE_URL="<db-url>" EMAIL="you@company.com" PASSWORD="YourStrongPass1!" \
//     npm run -w @crm/database set-admin
//
// Optional: NAME="Your Name" (defaults to "Admin"). Re-running with the same email
// updates that user's password and promotes them to admin — safe to run repeatedly.
import { PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';

async function main() {
  const email = process.env.EMAIL?.trim().toLowerCase();
  const password = process.env.PASSWORD;
  const name = process.env.NAME?.trim() || 'Admin';

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  if (!email || !password) {
    throw new Error('Set EMAIL and PASSWORD, e.g. EMAIL=you@company.com PASSWORD=Secret123!');
  }
  if (password.length < 8) throw new Error('PASSWORD must be at least 8 characters.');

  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL) });
  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, role: Role.admin, name, isActive: true },
    create: { email, passwordHash, role: Role.admin, name },
    select: { email: true, role: true, name: true },
  });

  console.log(`✔ Admin ready — log in with:\n   email:    ${user.email}\n   password: (the one you just set)`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(`✖ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
