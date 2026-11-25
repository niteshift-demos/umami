import clickhouse from '@/lib/clickhouse';
import { DATA_TYPE, FIELD_LENGTH } from '@/lib/constants';
import { uuid } from '@/lib/crypto';
import { flattenJSON, getStoredStringValue } from '@/lib/data';
import { CLICKHOUSE, KAFKA, PRISMA, type QueryWriter, runQuery } from '@/lib/db';
import { truncateString } from '@/lib/format';
import kafka from '@/lib/kafka';
import prisma from '@/lib/prisma';
import type { DynamicData } from '@/lib/types';

export interface SaveEventDataArgs {
  websiteId: string;
  eventId: string;
  sessionId?: string;
  urlPath?: string;
  eventName?: string;
  eventData: DynamicData;
  createdAt?: Date;
}

export async function saveEventData(data: SaveEventDataArgs) {
  return runQuery({
    [PRISMA]: () => relationalQuery(data),
    [KAFKA]: () => clickhouseQuery(data, messages => kafka.sendMessage('event_data', messages)),
    [CLICKHOUSE]: () =>
      clickhouseQuery(data, messages => clickhouse.insert('event_data', messages)),
  });
}

async function relationalQuery(data: SaveEventDataArgs) {
  const { websiteId, eventId, eventData, createdAt } = data;

  const jsonKeys = flattenJSON(eventData);

  // id, websiteEventId, eventStringValue
  const flattenedData = jsonKeys.map(a => ({
    id: uuid(),
    websiteEventId: eventId,
    websiteId,
    dataKey: truncateString(a.key, FIELD_LENGTH.dataKey),
    stringValue: getStoredStringValue(a.value, a.dataType),
    numberValue: a.dataType === DATA_TYPE.number ? a.value : null,
    dateValue: a.dataType === DATA_TYPE.date ? new Date(a.value) : null,
    dataType: a.dataType,
    createdAt,
  }));

  await prisma.client.eventData.createMany({
    data: flattenedData,
  });
}

async function clickhouseQuery(data: SaveEventDataArgs, write: QueryWriter) {
  const { websiteId, sessionId, eventId, urlPath, eventName, eventData, createdAt } = data;

  const { getUTCString } = clickhouse;

  const jsonKeys = flattenJSON(eventData);

  const messages = jsonKeys.map(({ key, value, dataType }) => {
    return {
      website_id: websiteId,
      session_id: sessionId,
      event_id: eventId,
      url_path: truncateString(urlPath, FIELD_LENGTH.url),
      event_name: truncateString(eventName, FIELD_LENGTH.eventName),
      data_key: truncateString(key, FIELD_LENGTH.dataKey),
      data_type: dataType,
      string_value: getStoredStringValue(value, dataType),
      number_value: dataType === DATA_TYPE.number ? value : null,
      date_value: dataType === DATA_TYPE.date ? getUTCString(value) : null,
      created_at: getUTCString(createdAt),
    };
  });

  await write(messages);
}
