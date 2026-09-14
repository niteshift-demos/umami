/* eslint-disable no-console */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { getSessionCountForDay } from './distributions/temporal.js';
import {
  type EventData,
  type EventDataEntry,
  generateEventsForSession,
} from './generators/events.js';
import {
  generateRevenueForEvents,
  type RevenueConfig,
  type RevenueData,
} from './generators/revenue.js';
import { createSessions, type SessionData } from './generators/sessions.js';
import {
  BLOG_SESSIONS_PER_DAY,
  BLOG_WEBSITE_DOMAIN,
  BLOG_WEBSITE_NAME,
  getBlogJourney,
  getBlogSiteConfig,
} from './sites/blog.js';
import {
  getSaasJourney,
  getSaasSiteConfig,
  SAAS_SESSIONS_PER_DAY,
  SAAS_WEBSITE_DOMAIN,
  SAAS_WEBSITE_NAME,
  saasRevenueConfigs,
} from './sites/saas.js';
import { formatNumber, generateDatesBetween, progressBar, subDays, uuid } from './utils.js';

// Rows per INSERT statement. Each statement sends one array parameter per
// column (via unnest), so the batch size is not bound by the parameter limit.
const BATCH_SIZE = 5000;

export interface SeedConfig {
  days: number;
  clear: boolean;
  verbose: boolean;
}

export interface SeedResult {
  websites: number;
  sessions: number;
  events: number;
  eventData: number;
  revenue: number;
}

interface Column<T> {
  name: string;
  type: string;
  get: (row: T) => unknown;
}

function toDate(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Bulk insert using `INSERT ... SELECT * FROM unnest(...)`, which is several
 * times faster than Prisma's createMany for large seeds. Duplicate primary keys
 * are ignored, matching `skipDuplicates: true`.
 */
async function bulkInsert<T>(
  prisma: PrismaClient,
  table: string,
  columns: Column<T>[],
  rows: T[],
  label: string,
  verbose: boolean,
): Promise<void> {
  const names = columns.map(c => c.name).join(', ');
  const params = columns.map((c, i) => `$${i + 1}::${c.type}[]`).join(', ');
  const sql = `insert into ${table} (${names}) select * from unnest(${params}) on conflict do nothing`;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = columns.map(c => batch.map(c.get));

    await prisma.$executeRawUnsafe(sql, ...values);

    if (verbose) {
      console.log(`  Inserted ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length} ${label}`);
    }
  }
}

const sessionColumns: Column<SessionData>[] = [
  { name: 'session_id', type: 'uuid', get: r => r.id },
  { name: 'website_id', type: 'uuid', get: r => r.websiteId },
  { name: 'browser', type: 'text', get: r => r.browser },
  { name: 'os', type: 'text', get: r => r.os },
  { name: 'device', type: 'text', get: r => r.device },
  { name: 'screen', type: 'text', get: r => r.screen },
  { name: 'language', type: 'text', get: r => r.language },
  { name: 'country', type: 'text', get: r => r.country },
  { name: 'region', type: 'text', get: r => r.region },
  { name: 'city', type: 'text', get: r => r.city },
  { name: 'created_at', type: 'timestamptz', get: r => toDate(r.createdAt) },
];

const eventColumns: Column<EventData>[] = [
  { name: 'event_id', type: 'uuid', get: r => r.id },
  { name: 'website_id', type: 'uuid', get: r => r.websiteId },
  { name: 'session_id', type: 'uuid', get: r => r.sessionId },
  { name: 'visit_id', type: 'uuid', get: r => r.visitId },
  { name: 'created_at', type: 'timestamptz', get: r => toDate(r.createdAt) },
  { name: 'url_path', type: 'text', get: r => r.urlPath },
  { name: 'url_query', type: 'text', get: r => r.urlQuery },
  { name: 'utm_source', type: 'text', get: r => r.utmSource },
  { name: 'utm_medium', type: 'text', get: r => r.utmMedium },
  { name: 'utm_campaign', type: 'text', get: r => r.utmCampaign },
  { name: 'utm_content', type: 'text', get: r => r.utmContent },
  { name: 'utm_term', type: 'text', get: r => r.utmTerm },
  { name: 'referrer_path', type: 'text', get: r => r.referrerPath },
  { name: 'referrer_domain', type: 'text', get: r => r.referrerDomain },
  { name: 'page_title', type: 'text', get: r => r.pageTitle },
  { name: 'gclid', type: 'text', get: r => r.gclid },
  { name: 'fbclid', type: 'text', get: r => r.fbclid },
  { name: 'event_type', type: 'int', get: r => r.eventType },
  { name: 'event_name', type: 'text', get: r => r.eventName },
  { name: 'tag', type: 'text', get: r => r.tag },
  { name: 'hostname', type: 'text', get: r => r.hostname },
];

const eventDataColumns: Column<EventDataEntry>[] = [
  { name: 'event_data_id', type: 'uuid', get: r => r.id },
  { name: 'website_id', type: 'uuid', get: r => r.websiteId },
  { name: 'website_event_id', type: 'uuid', get: r => r.websiteEventId },
  { name: 'data_key', type: 'text', get: r => r.dataKey },
  { name: 'string_value', type: 'text', get: r => r.stringValue },
  { name: 'number_value', type: 'numeric', get: r => r.numberValue },
  { name: 'date_value', type: 'timestamptz', get: r => toDate(r.dateValue) },
  { name: 'data_type', type: 'int', get: r => r.dataType },
  { name: 'created_at', type: 'timestamptz', get: r => toDate(r.createdAt) },
];

const revenueColumns: Column<RevenueData>[] = [
  { name: 'revenue_id', type: 'uuid', get: r => r.id },
  { name: 'website_id', type: 'uuid', get: r => r.websiteId },
  { name: 'session_id', type: 'uuid', get: r => r.sessionId },
  { name: 'event_id', type: 'uuid', get: r => r.eventId },
  { name: 'event_name', type: 'text', get: r => r.eventName },
  { name: 'currency', type: 'text', get: r => r.currency },
  { name: 'revenue', type: 'numeric', get: r => r.revenue },
  { name: 'created_at', type: 'timestamptz', get: r => toDate(r.createdAt) },
];

async function findAdminUser(prisma: PrismaClient): Promise<string> {
  const adminUser = await prisma.user.findFirst({
    where: { role: 'admin' },
    select: { id: true },
  });

  if (!adminUser) {
    throw new Error(
      'No admin user found in the database.\n' +
        'Please ensure you have run the initial setup and created an admin user.\n' +
        'The default admin user is created during first build (username: admin, password: umami).',
    );
  }

  return adminUser.id;
}

async function createWebsite(
  prisma: PrismaClient,
  name: string,
  domain: string,
  adminUserId: string,
): Promise<string> {
  const websiteId = uuid();

  await prisma.website.create({
    data: {
      id: websiteId,
      name,
      domain,
      userId: adminUserId,
      createdBy: adminUserId,
    },
  });

  return websiteId;
}

async function clearDemoData(prisma: PrismaClient): Promise<void> {
  console.log('Clearing existing demo data...');

  const demoWebsites = await prisma.website.findMany({
    where: {
      OR: [{ name: BLOG_WEBSITE_NAME }, { name: SAAS_WEBSITE_NAME }],
    },
    select: { id: true },
  });

  const websiteIds = demoWebsites.map(w => w.id);

  if (websiteIds.length === 0) {
    console.log('  No existing demo websites found');
    return;
  }

  console.log(`  Found ${websiteIds.length} demo website(s)`);

  // Delete in correct order due to foreign key constraints
  await prisma.revenue.deleteMany({ where: { websiteId: { in: websiteIds } } });
  await prisma.eventData.deleteMany({ where: { websiteId: { in: websiteIds } } });
  await prisma.sessionData.deleteMany({ where: { websiteId: { in: websiteIds } } });
  await prisma.websiteEvent.deleteMany({ where: { websiteId: { in: websiteIds } } });
  await prisma.session.deleteMany({ where: { websiteId: { in: websiteIds } } });
  await prisma.segment.deleteMany({ where: { websiteId: { in: websiteIds } } });
  await prisma.report.deleteMany({ where: { websiteId: { in: websiteIds } } });
  await prisma.website.deleteMany({ where: { id: { in: websiteIds } } });

  console.log('  Cleared existing demo data');
}

interface SiteGeneratorConfig {
  name: string;
  domain: string;
  sessionsPerDay: number;
  getSiteConfig: () => ReturnType<typeof getBlogSiteConfig>;
  getJourney: () => string[];
  revenueConfigs?: RevenueConfig[];
}

async function generateSiteData(
  prisma: PrismaClient,
  config: SiteGeneratorConfig,
  days: Date[],
  adminUserId: string,
  verbose: boolean,
): Promise<{ sessions: number; events: number; eventData: number; revenue: number }> {
  console.log(`\nGenerating data for ${config.name}...`);

  const websiteId = await createWebsite(prisma, config.name, config.domain, adminUserId);
  console.log(`  Created website: ${config.name} (${websiteId})`);

  const siteConfig = config.getSiteConfig();

  const allSessions: SessionData[] = [];
  const allEvents: EventData[] = [];
  const allEventData: EventDataEntry[] = [];
  const allRevenue: RevenueData[] = [];

  for (let dayIndex = 0; dayIndex < days.length; dayIndex++) {
    const day = days[dayIndex];
    const sessionCount = getSessionCountForDay(config.sessionsPerDay, day);
    const sessions = createSessions(websiteId, day, sessionCount);

    for (const session of sessions) {
      const journey = config.getJourney();
      const { events, eventDataEntries } = generateEventsForSession(session, siteConfig, journey);

      allSessions.push(session);
      allEvents.push(...events);
      allEventData.push(...eventDataEntries);

      if (config.revenueConfigs) {
        const revenueEntries = generateRevenueForEvents(events, config.revenueConfigs);
        allRevenue.push(...revenueEntries);
      }
    }

    // Show progress (every day in verbose mode, otherwise every 2 days)
    const shouldShowProgress = verbose || dayIndex % 2 === 0 || dayIndex === days.length - 1;
    if (shouldShowProgress) {
      process.stdout.write(
        `\r  ${progressBar(dayIndex + 1, days.length)} Day ${dayIndex + 1}/${days.length}`,
      );
    }
  }

  console.log(''); // New line after progress bar

  // Batch insert all data
  console.log(`  Inserting ${formatNumber(allSessions.length)} sessions...`);
  await bulkInsert(prisma, 'session', sessionColumns, allSessions, 'sessions', verbose);

  console.log(`  Inserting ${formatNumber(allEvents.length)} events...`);
  await bulkInsert(prisma, 'website_event', eventColumns, allEvents, 'events', verbose);

  if (allEventData.length > 0) {
    console.log(`  Inserting ${formatNumber(allEventData.length)} event data entries...`);
    await bulkInsert(prisma, 'event_data', eventDataColumns, allEventData, 'event data', verbose);
  }

  if (allRevenue.length > 0) {
    console.log(`  Inserting ${formatNumber(allRevenue.length)} revenue entries...`);
    await bulkInsert(prisma, 'revenue', revenueColumns, allRevenue, 'revenue', verbose);
  }

  return {
    sessions: allSessions.length,
    events: allEvents.length,
    eventData: allEventData.length,
    revenue: allRevenue.length,
  };
}

function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL environment variable is not set.\n' +
        'Please set DATABASE_URL in your .env file or environment.\n' +
        'Example: DATABASE_URL=postgresql://user:password@localhost:5432/umami',
    );
  }

  let schema: string | undefined;
  try {
    const connectionUrl = new URL(url);
    schema = connectionUrl.searchParams.get('schema') ?? undefined;
  } catch {
    throw new Error(
      'DATABASE_URL is not a valid URL.\n' +
        'Expected format: postgresql://user:password@host:port/database\n' +
        `Received: ${url.substring(0, 30)}...`,
    );
  }

  const adapter = new PrismaPg({ connectionString: url }, { schema });

  return new PrismaClient({
    adapter,
    errorFormat: 'pretty',
  });
}

export async function seed(config: SeedConfig): Promise<SeedResult> {
  const prisma = createPrismaClient();

  try {
    const endDate = new Date();
    const startDate = subDays(endDate, config.days);
    const days = generateDatesBetween(startDate, endDate);

    console.log(`\nSeed Configuration:`);
    console.log(
      `  Date range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`,
    );
    console.log(`  Days: ${days.length}`);
    console.log(`  Clear existing: ${config.clear}`);

    if (config.clear) {
      await clearDemoData(prisma);
    }

    // Find admin user to own the demo websites
    const adminUserId = await findAdminUser(prisma);
    console.log(`  Using admin user: ${adminUserId}`);

    // Generate Blog site (low traffic)
    const blogResults = await generateSiteData(
      prisma,
      {
        name: BLOG_WEBSITE_NAME,
        domain: BLOG_WEBSITE_DOMAIN,
        sessionsPerDay: BLOG_SESSIONS_PER_DAY,
        getSiteConfig: getBlogSiteConfig,
        getJourney: getBlogJourney,
      },
      days,
      adminUserId,
      config.verbose,
    );

    // Generate SaaS site (high traffic)
    const saasResults = await generateSiteData(
      prisma,
      {
        name: SAAS_WEBSITE_NAME,
        domain: SAAS_WEBSITE_DOMAIN,
        sessionsPerDay: SAAS_SESSIONS_PER_DAY,
        getSiteConfig: getSaasSiteConfig,
        getJourney: getSaasJourney,
        revenueConfigs: saasRevenueConfigs,
      },
      days,
      adminUserId,
      config.verbose,
    );

    const result: SeedResult = {
      websites: 2,
      sessions: blogResults.sessions + saasResults.sessions,
      events: blogResults.events + saasResults.events,
      eventData: blogResults.eventData + saasResults.eventData,
      revenue: blogResults.revenue + saasResults.revenue,
    };

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Seed Complete!`);
    console.log(`${'─'.repeat(50)}`);
    console.log(`  Websites:   ${formatNumber(result.websites)}`);
    console.log(`  Sessions:   ${formatNumber(result.sessions)}`);
    console.log(`  Events:     ${formatNumber(result.events)}`);
    console.log(`  Event Data: ${formatNumber(result.eventData)}`);
    console.log(`  Revenue:    ${formatNumber(result.revenue)}`);
    console.log(`${'─'.repeat(50)}\n`);

    return result;
  } finally {
    await prisma.$disconnect();
  }
}
