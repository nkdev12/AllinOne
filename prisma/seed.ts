import { PrismaClient } from '@prisma/client';

/**
 * Database Seed Script
 * 
 * Creates sample data for development and testing.
 * Run with: npm run db:seed
 */

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // TODO: Implement sample data seeding
  // - Users
  // - Devices
  // - Notes
  // - Tasks
  // - Calendar events
  // - Relationships and links

  console.log('✓ Database seeded');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
