import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, paginateQuery } from '@aws-sdk/lib-dynamodb';

const env = process.env;
const required = ['API_BASE_URL', 'API_KEY', 'API_KEY_ID', 'TENANT_ID', 'TABLE_NAME'];
for (const name of required) {
  if (!env[name]?.trim()) throw new Error(`Missing required environment variable: ${name}`);
}

const mapConcurrency = positiveInt(env.MAP_MAX_CONCURRENCY, 4, 1, 10);
const translateConcurrency = positiveInt(env.TRANSLATE_CONCURRENCY, 4, 1, 10);
const baseUrl = env.API_BASE_URL.replace(/\/+$/u, '');
const endpoint = `${baseUrl}/translate/realtime`;
const tenantId = env.TENANT_ID.trim();
const tableName = env.TABLE_NAME.trim();
const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(region ? { region } : {}));
const throttle = { gateway429: 0, translate503: 0 };

function positiveInt(raw, fallback, min, max) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${raw} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function charCount(text) {
  return Array.from(text.normalize('NFC')).length;
}

function makeUniqueSentences(count) {
  return Array.from({ length: count }, (_, i) =>
    `Xin chào, đây là câu kiểm thử duy nhất số ${String(i).padStart(4, '0')}.`,
  );
}

function makeRequestBatches(sentences, maxChars = 4800) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const sentence of sentences) {
    const nextSize = charCount(sentence) + (current.length ? 1 : 0);
    if (current.length && currentChars + nextSize > maxChars) {
      batches.push(current.join('\n'));
      current = [];
      currentChars = 0;
    }
    if (charCount(sentence) > 5000) throw new Error('A generated sentence exceeds the realtime API limit.');
    current.push(sentence);
    currentChars += charCount(sentence) + (current.length > 1 ? 1 : 0);
  }
  if (current.length) batches.push(current.join('\n'));
  for (const text of batches) {
    if (charCount(text) > 5000) throw new Error('A generated request exceeds the realtime API limit.');
  }
  return batches;
}

async function assertEmptyTm() {
  let count = 0;
  for await (const page of paginateQuery({ client: ddb }, {
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :hashPrefix)',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}#TM#vi#en`,
        ':hashPrefix': 'HASH#',
      },
      Select: 'COUNT',
      ConsistentRead: true,
    })) {
    count += page.Count ?? 0;
  }
  if (count !== 0) throw new Error(`Tenant TM is not empty for vi→en (${count} entries); choose a clean tenant.`);
}

async function assertApiKeyTenant() {
  const result = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `TENANT#PLATFORM#KEY#${env.API_KEY_ID.trim()}`, SK: 'META' },
    ConsistentRead: true,
  }));
  if (result.Item?.tenantId !== tenantId) throw new Error('The configured API key does not map to TENANT_ID.');
}

async function readUsage() {
  const month = new Date().toISOString().slice(0, 7);
  const result = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `TENANT#${tenantId}#USAGE`, SK: `MONTH#${month}` },
    ConsistentRead: true,
  }));
  return {
    month,
    machineChars: Number(result.Item?.machineChars ?? 0),
    memoryChars: Number(result.Item?.memoryChars ?? 0),
  };
}

async function postText(text) {
  for (let attempt = 0; attempt <= 5; attempt++) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.API_KEY },
      body: JSON.stringify({ text, source_lang: 'vi', target_lang: 'en', use_terminology: true }),
    });
    let body;
    try { body = await response.json(); } catch { body = {}; }
    const code = body?.error?.code;
    if (response.status === 429) {
      if (code === 'CHAR_QUOTA_EXCEEDED') throw new Error(`Tenant quota was exceeded: ${JSON.stringify(body)}`);
      throttle.gateway429++;
      if (attempt === 5) throw new Error(`API Gateway returned 429 after retries: ${JSON.stringify(body)}`);
      await delay(250 * (2 ** attempt));
      continue;
    }
    if (response.status === 503 && code === 'TRANSLATE_THROTTLED') {
      throttle.translate503++;
      if (attempt === 5) throw new Error(`Translate throttled after retries: ${JSON.stringify(body)}`);
      await delay(500 * (2 ** attempt));
      continue;
    }
    if (!response.ok) throw new Error(`Realtime API ${response.status}: ${JSON.stringify(body)}`);
    return body;
  }
  throw new Error('Request retry limit reached.');
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function mapLimit(items, limit, fn) {
  let next = 0;
  let firstError;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!firstError) {
      const index = next++;
      if (index >= items.length) return;
      try { await fn(items[index], index); } catch (error) { firstError ??= error; }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
}

async function runPass(label, uniqueBatches, repeatedSentence, includeUnique, includeRepeats) {
  let machineChars = 0;
  let memoryChars = 0;
  let requests = 0;
  const calls = [];
  if (includeUnique) calls.push(...uniqueBatches);
  if (includeRepeats) calls.push(...Array.from({ length: 400 }, () => repeatedSentence));
  await mapLimit(calls, mapConcurrency, async (text) => {
    const result = await postText(text);
    machineChars += Number(result.characters_machine_translated ?? NaN);
    memoryChars += Number(result.characters_from_memory ?? NaN);
    requests++;
  });
  console.log(JSON.stringify({ phase: label, requests, machineChars, memoryChars, throttles: { ...throttle } }));
  return { requests, machineChars, memoryChars };
}

function assertCounter(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual} (delta ${actual - expected}).`);
}

async function main() {
  const unique = makeUniqueSentences(600);
  const repeated = unique[0];
  const k1 = unique.reduce((total, sentence) => total + charCount(sentence), 0);
  const k2 = 400 * charCount(repeated);
  const expectedHitRate = k2 / (k1 + k2);
  if (Math.abs(expectedHitRate - 0.4) > Number.EPSILON) throw new Error(`Expected a 40.0% character hit rate, got ${expectedHitRate}.`);
  const uniqueBatches = makeRequestBatches(unique);
  if (uniqueBatches.some((text) => charCount(text) > 5000)) throw new Error('Generated input is too long.');

  await assertApiKeyTenant();
  await assertEmptyTm();
  const before = await readUsage();
  console.log(JSON.stringify({ tenantId, month: before.month, mapConcurrency, translateConcurrency, uniqueSentences: 600, repeatedSentences: 400, uniqueRequests: uniqueBatches.length, K1: k1, K2: k2, tmHitByCharacters: expectedHitRate, throttles: { ...throttle } }));

  const first = await runPass('first', uniqueBatches, repeated, true, true);
  assertCounter('pass 1 machine characters', first.machineChars, k1);
  assertCounter('pass 1 TM characters', first.memoryChars, k2);
  const afterFirst = await readUsage();
  assertCounter('USAGE pass 1 machine delta', afterFirst.machineChars - before.machineChars, k1);
  assertCounter('USAGE pass 1 TM delta', afterFirst.memoryChars - before.memoryChars, k2);
  console.log(JSON.stringify({ phase: 'first-verified', expectedHitRate, machineDelta: afterFirst.machineChars - before.machineChars, memoryDelta: afterFirst.memoryChars - before.memoryChars }));

  const second = await runPass('second', uniqueBatches, repeated, true, true);
  assertCounter('pass 2 machine characters', second.machineChars, 0);
  assertCounter('pass 2 TM characters', second.memoryChars, k1 + k2);
  const afterSecond = await readUsage();
  assertCounter('USAGE cumulative machine delta', afterSecond.machineChars - before.machineChars, k1);
  assertCounter('USAGE cumulative TM delta', afterSecond.memoryChars - before.memoryChars, k1 + 2 * k2);
  console.log(JSON.stringify({ phase: 'second-verified', machineDelta: afterSecond.machineChars - before.machineChars, memoryDelta: afterSecond.memoryChars - before.memoryChars, throttles: throttle }));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), throttles: throttle }));
  process.exitCode = 1;
});
