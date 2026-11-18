import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { operations, exampleFor, requestUrl, curlExample, openApiFor, completeDocument } from '../api-reference.js';

test('in-app definition matches the canonical server API without leaking account data', async () => {
  const canonical = JSON.parse(await readFile(new URL('../../../docs/api/openapi.json', import.meta.url), 'utf8'));
  const full = openApiFor('https://second.example.test:8443');
  assert.deepEqual(full.paths, canonical.paths);
  assert.deepEqual(full.components, canonical.components);
  assert.equal(operations.length, 31);
  assert.equal(full.servers[0].url, 'https://second.example.test:8443');
  assert.equal(Object.values(openApiFor(full.servers[0].url, true).paths).reduce((n, p) => n + Object.keys(p).length, 0), 8);
  assert.equal(openApiFor('https://other.example.test').servers[0].url, 'https://other.example.test');
});

test('copyable requests use actual routes, body examples and placeholder authentication', () => {
  const send = operations.find(o => o.operationId === 'sendMail');
  const detail = operations.find(o => o.operationId === 'getMail');
  assert.match(curlExample(send, 'https://mail.example.test:9443'), /https:\/\/mail.example.test:9443\/api\/v1\/send/);
  assert.match(curlExample(send, 'https://mail.example.test'), /Authorization: Bearer po_YOUR_API_KEY/);
  assert.match(curlExample(send, 'https://mail.example.test'), /--data-raw '[\s\S]*"to"/);
  assert.equal(requestUrl(detail, 'https://mail.example.test'), 'https://mail.example.test/api/v1/manage/messages/123');
  const text = completeDocument('https://mail.example.test:9443');
  for (const op of operations) assert(text.includes(`operationId: ${op.operationId}`));
  assert(text.includes('management 不自动包含其他 scope'));
  assert(!text.includes('210.16.166.94'));
  assert(text.length < 1000000);
  for (const op of operations.filter(o => o.requestBody)) {
    assert(exampleFor(op), `Missing working example: ${op.operationId}`);
  }
});
