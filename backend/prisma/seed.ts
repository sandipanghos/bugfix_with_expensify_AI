import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const config = await prisma.config.upsert({
    where: { id: 'singleton' },
    update: {},
    create: {
      notificationEmail: 'you@example.com',
      watchedRepo: 'sandipanghos/App',
      watchedLabel: 'Help Wanted',
      issueLimit: 4,
      isRunning: false,
    },
  });

  console.log('Seeded config:', {
    watchedRepo: config.watchedRepo,
    watchedLabel: config.watchedLabel,
    issueLimit: config.issueLimit,
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
