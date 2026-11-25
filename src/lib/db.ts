export const PRISMA = 'prisma';
export const POSTGRESQL = 'postgresql';
export const CLICKHOUSE = 'clickhouse';
export const KAFKA = 'kafka';
export const KAFKA_PRODUCER = 'kafka-producer';

export type QueryWriter = (data: any) => Promise<unknown>;

// Fixes issue with converting bigint values
(BigInt.prototype as unknown as { toJSON(): number }).toJSON = function () {
  return Number(this);
};

export function getDatabaseType(url = process.env.DATABASE_URL) {
  const type = url?.split(':')[0];

  if (type === 'postgres') {
    return POSTGRESQL;
  }

  return type;
}

export function isKafkaEnabled() {
  return Boolean(process.env.KAFKA_URL && process.env.KAFKA_BROKER);
}

export function isRelationalOnly() {
  return !process.env.CLICKHOUSE_URL && getDatabaseType() === POSTGRESQL;
}

export async function runQuery(queries: any) {
  if (process.env.CLICKHOUSE_URL) {
    if (queries[KAFKA] && isKafkaEnabled()) {
      return queries[KAFKA]();
    }

    return queries[CLICKHOUSE]();
  }

  const db = getDatabaseType();

  if (db === POSTGRESQL) {
    return queries[PRISMA]();
  }
}

export function notImplemented() {
  throw new Error('Not implemented.');
}
