#!/usr/bin/env node

/**
 * Coram Test Suite
 * Tests for the fourth OpenDone primitive.
 * 
 * Runs standalone — does not modify opendone.js.
 * Also tests integration points with the existing primitives.
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');

const OpenDone = require('./opendone');
const Coram    = require('./coram');

const { openCoram, appendEntry, closeCoram, verifyCoram, attachCoramToReceipt } = Coram;

// ─────────────────────────────────────────────────────────────
// TEST HARNESS
// ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
    failed++;
    failures.push({ name, error: e.message });
  }
}

function throws(fn, code) {
  try { fn(); assert.fail('Expected error was not thrown'); }
  catch (e) {
    if (e.message === 'Expected error was not thrown') throw e;
    if (code) assert.strictEqual(e.code, code, `Expected error code ${code}, got ${e.code}`);
  }
}

// Helper: build a minimal valid contract
function makeContract(overrides = {}) {
  return OpenDone.contract({
    task: 'Test task',
    criteria: { required: ['result'] },
    constraints: { maxIterations: 10, maxLoopWarnings: 2 },
    ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────
// SECTION 1: openCoram()
// ─────────────────────────────────────────────────────────────

console.log('\n── openCoram() ──────────────────────────────');

test('creates a valid Coram record', () => {
  const c = makeContract();
  const coram = openCoram({ contract: c });
  assert.strictEqual(coram.contractId,   c.contractId);
  assert.strictEqual(coram.contractHash, c.hash);
  assert.strictEqual(coram.status,       'open');
  assert.strictEqual(coram.entryCount,   0);
  assert.deepStrictEqual(coram.entries,  []);
  assert.strictEqual(coram.finalHash,    null);
  assert.ok(coram.coramId.startsWith('od_coram_'));
});

test('defaults to hashed payload mode', () => {
  const coram = openCoram({ contract: makeContract() });
  assert.strictEqual(coram.mode, 'hashed');
});

test('accepts inline and redacted modes', () => {
  const c = makeContract();
  assert.strictEqual(openCoram({ contract: c, mode: 'inline'   }).mode, 'inline');
  assert.strictEqual(openCoram({ contract: c, mode: 'redacted' }).mode, 'redacted');
});

test('throws CORAM_INVALID for invalid payload mode', () => {
  throws(() => openCoram({ contract: makeContract(), mode: 'full' }), 'CORAM_INVALID');
});

test('throws CORAM_INVALID when contract is missing', () => {
  throws(() => openCoram({}), 'CORAM_INVALID');
});

test('throws CORAM_INVALID when contract has no hash', () => {
  throws(() => openCoram({ contract: { contractId: 'x' } }), 'CORAM_INVALID');
});

test('stores agentId', () => {
  const coram = openCoram({ contract: makeContract(), agentId: 'claude-sonnet-4' });
  assert.strictEqual(coram.agentId, 'claude-sonnet-4');
});

// ─────────────────────────────────────────────────────────────
// SECTION 2: appendEntry()
// ─────────────────────────────────────────────────────────────

console.log('\n── appendEntry() ────────────────────────────');

test('appends first entry anchored to contractHash', () => {
  const c = makeContract();
  const coram = openCoram({ contract: c });
  const entry = appendEntry(coram, { action: 'fs.readFile', input: '/tmp/x', result: 'hello' });
  assert.strictEqual(entry.entryId,      1);
  assert.strictEqual(entry.previousHash, c.hash);
  assert.strictEqual(coram.entryCount,   1);
  assert.ok(entry.entryHash.length === 64);  // sha256 hex
});

test('each entry chains to the previous entryHash', () => {
  const coram = openCoram({ contract: makeContract() });
  const e1 = appendEntry(coram, { action: 'tool.a', input: 'x', result: 'y' });
  const e2 = appendEntry(coram, { action: 'tool.b', input: 'a', result: 'b' });
  assert.strictEqual(e2.previousHash, e1.entryHash);
});

test('entry entryHash is deterministic', () => {
  const c = makeContract();
  // Build two identical entries independently
  const coram1 = openCoram({ contract: c });
  const coram2 = openCoram({ contract: c });
  // Force same coramId and timestamps for determinism test
  coram2.contractHash = coram1.contractHash;
  const e1 = appendEntry(coram1, { action: 'tool.x', input: 'same', result: 'same' });
  const e2 = appendEntry(coram2, { action: 'tool.x', input: 'same', result: 'same' });
  // Both should produce the same entryHash since inputs, action, and previousHash are identical
  assert.strictEqual(e1.entryHash, e2.entryHash);
});

test('hashed mode: inputInline and resultInline are null', () => {
  const coram = openCoram({ contract: makeContract(), mode: 'hashed' });
  const entry = appendEntry(coram, { action: 'tool', input: { data: 'secret' }, result: 'ok' });
  assert.strictEqual(entry.inputInline,  null);
  assert.strictEqual(entry.resultInline, null);
  assert.ok(entry.inputHash);
  assert.ok(entry.resultHash);
});

test('inline mode: payloads are stored', () => {
  const coram = openCoram({ contract: makeContract(), mode: 'inline' });
  const entry = appendEntry(coram, { action: 'tool', input: { q: 'query' }, result: { r: 'answer' } });
  assert.deepStrictEqual(entry.inputInline,  { q: 'query' });
  assert.deepStrictEqual(entry.resultInline, { r: 'answer' });
});

test('redacted mode: hashes are null', () => {
  const coram = openCoram({ contract: makeContract(), mode: 'redacted' });
  const entry = appendEntry(coram, { action: 'tool', input: 'x', result: 'y' });
  assert.strictEqual(entry.inputHash,  null);
  assert.strictEqual(entry.resultHash, null);
  assert.strictEqual(entry.inputInline, null);
});

test('throws CORAM_INVALID when appending to closed record', () => {
  const coram = openCoram({ contract: makeContract() });
  closeCoram(coram);
  throws(() => appendEntry(coram, { action: 'tool', input: 'x', result: 'y' }), 'CORAM_INVALID');
});

test('throws CORAM_INVALID when action is missing', () => {
  const coram = openCoram({ contract: makeContract() });
  throws(() => appendEntry(coram, { input: 'x', result: 'y' }), 'CORAM_INVALID');
});

// ─────────────────────────────────────────────────────────────
// SECTION 3: Loop Detection
// ─────────────────────────────────────────────────────────────

console.log('\n── Loop Detection ───────────────────────────');

test('first occurrence of action+input has no loop warning', () => {
  const coram = openCoram({ contract: makeContract() });
  const entry = appendEntry(coram, { action: 'web.search', input: 'cats', result: 'results' });
  assert.strictEqual(entry.loopWarning, false);
  assert.strictEqual(entry.loopCount,   1);
});

test('second identical action+input sets loopWarning true', () => {
  const coram = openCoram({ contract: makeContract() });
  appendEntry(coram, { action: 'web.search', input: 'cats', result: 'results' });
  const e2 = appendEntry(coram, { action: 'web.search', input: 'cats', result: 'results' });
  assert.strictEqual(e2.loopWarning, true);
  assert.strictEqual(e2.loopCount,   2);
});

test('same action with different input is NOT a loop', () => {
  const coram = openCoram({ contract: makeContract() });
  appendEntry(coram, { action: 'web.search', input: 'cats', result: 'r1' });
  const e2 = appendEntry(coram, { action: 'web.search', input: 'dogs', result: 'r2' });
  assert.strictEqual(e2.loopWarning, false);
});

test('loopCount increments with each repeated call', () => {
  const coram = openCoram({ contract: makeContract() });
  appendEntry(coram, { action: 'fs.write', input: 'x', result: 'ok' });
  appendEntry(coram, { action: 'fs.write', input: 'x', result: 'ok' });
  const e3 = appendEntry(coram, { action: 'fs.write', input: 'x', result: 'ok' });
  assert.strictEqual(e3.loopWarning, true);
  assert.strictEqual(e3.loopCount,   3);
});

test('loop warning does not throw — it is a signal, not an error', () => {
  const coram = openCoram({ contract: makeContract() });
  // Should not throw — loop detection is passive
  appendEntry(coram, { action: 'tool', input: 'x', result: 'y' });
  appendEntry(coram, { action: 'tool', input: 'x', result: 'y' });
  appendEntry(coram, { action: 'tool', input: 'x', result: 'y' });
  assert.strictEqual(coram.entryCount, 3);  // all entries recorded
});

test('loop warnings visible in verifyCoram result', () => {
  const coram = openCoram({ contract: makeContract() });
  appendEntry(coram, { action: 'tool', input: 'repeat', result: 'r' });
  appendEntry(coram, { action: 'tool', input: 'repeat', result: 'r' });
  closeCoram(coram);
  const result = verifyCoram(coram);
  assert.strictEqual(result.valid,                   true);
  assert.strictEqual(result.loopWarnings.length,     1);
  assert.strictEqual(result.loopWarnings[0].action,  'tool');
  assert.strictEqual(result.loopWarnings[0].loopCount, 2);
});

// ─────────────────────────────────────────────────────────────
// SECTION 4: closeCoram()
// ─────────────────────────────────────────────────────────────

console.log('\n── closeCoram() ─────────────────────────────');

test('sets status to closed and populates finalHash', () => {
  const coram = openCoram({ contract: makeContract() });
  appendEntry(coram, { action: 'tool', input: 'a', result: 'b' });
  closeCoram(coram);
  assert.strictEqual(coram.status,    'closed');
  assert.ok(coram.closedAt);
  assert.ok(coram.finalHash);
  assert.strictEqual(coram.finalHash, coram.entries[0].entryHash);
});

test('finalHash equals contractHash when no entries', () => {
  const c = makeContract();
  const coram = openCoram({ contract: c });
  closeCoram(coram);
  assert.strictEqual(coram.finalHash, c.hash);
});

test('removes internal _actionIndex after close', () => {
  const coram = openCoram({ contract: makeContract() });
  appendEntry(coram, { action: 'tool', input: 'x', result: 'y' });
  closeCoram(coram);
  assert.strictEqual(coram._actionIndex, undefined);
});

test('throws CORAM_INVALID when closing already-closed record', () => {
  const coram = openCoram({ contract: makeContract() });
  closeCoram(coram);
  throws(() => closeCoram(coram), 'CORAM_INVALID');
});

// ─────────────────────────────────────────────────────────────
// SECTION 5: verifyCoram() — integrity
// ─────────────────────────────────────────────────────────────

console.log('\n── verifyCoram() — integrity ─────────────────');

test('valid record passes verification', () => {
  const coram = openCoram({ contract: makeContract() });
  appendEntry(coram, { action: 'tool.a', input: '1', result: '2' });
  appendEntry(coram, { action: 'tool.b', input: '3', result: '4' });
  closeCoram(coram);
  const result = verifyCoram(coram);
  assert.strictEqual(result.valid, true);
});

test('detects tampered entryHash', () => {
  const coram = openCoram({ contract: makeContract() });
  appendEntry(coram, { action: 'tool', input: 'x', result: 'y' });
  closeCoram(coram);
  coram.entries[0].entryHash = 'deadbeef'.repeat(8);  // corrupt it
  const result = verifyCoram(coram);
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('hash mismatch'));
});

test('detects tampered previousHash (chain break)', () => {
  const coram = openCoram({ contract: makeContract() });
  appendEntry(coram, { action: 'a', input: '1', result: '2' });
  appendEntry(coram, { action: 'b', input: '3', result: '4' });
  closeCoram(coram);
  coram.entries[1].previousHash = 'aaaa'.repeat(16);  // break the chain
  const result = verifyCoram(coram);
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('Chain broken'));
});

test('detects tampered contractHash anchor', () => {
  const coram = openCoram({ contract: makeContract() });
  appendEntry(coram, { action: 'tool', input: 'x', result: 'y' });
  closeCoram(coram);
  coram.entries[0].previousHash = 'bbbb'.repeat(16);  // break the anchor
  const result = verifyCoram(coram);
  assert.strictEqual(result.valid, false);
});

test('detects entry count mismatch', () => {
  const coram = openCoram({ contract: makeContract() });
  appendEntry(coram, { action: 'tool', input: 'x', result: 'y' });
  closeCoram(coram);
  coram.entryCount = 99;  // lie about count
  const result = verifyCoram(coram);
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('count mismatch'));
});

test('detects finalHash mismatch (truncated record)', () => {
  const coram = openCoram({ contract: makeContract() });
  appendEntry(coram, { action: 'tool.a', input: 'x', result: 'y' });
  appendEntry(coram, { action: 'tool.b', input: 'a', result: 'b' });
  closeCoram(coram);
  coram.finalHash = 'cccc'.repeat(16);  // corrupt finalHash
  const result = verifyCoram(coram);
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('finalHash'));
});

test('empty record with no entries still passes', () => {
  const coram = openCoram({ contract: makeContract() });
  closeCoram(coram);
  const result = verifyCoram(coram);
  assert.strictEqual(result.valid, true);
});

// ─────────────────────────────────────────────────────────────
// SECTION 6: verifyCoram() — Receipt cross-check
// ─────────────────────────────────────────────────────────────

console.log('\n── verifyCoram() — Receipt cross-check ──────');

test('passes when Receipt fields match Coram record', () => {
  const coram = openCoram({ contract: makeContract() });
  appendEntry(coram, { action: 'tool', input: 'x', result: 'y' });
  closeCoram(coram);

  const fakeReceipt = {
    coramId:         coram.coramId,
    coramHash:       coram.finalHash,
    coramEntryCount: coram.entryCount,
  };
  const result = verifyCoram(coram, fakeReceipt);
  assert.strictEqual(result.valid, true);
  assert.ok(result.reason.includes('reconciled'));
});

test('fails when Receipt coramHash does not match', () => {
  const coram = openCoram({ contract: makeContract() });
  appendEntry(coram, { action: 'tool', input: 'x', result: 'y' });
  closeCoram(coram);
  const badReceipt = { coramId: coram.coramId, coramHash: 'wrong'.repeat(10), coramEntryCount: 1 };
  const result = verifyCoram(coram, badReceipt);
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('coramHash'));
});

test('fails when Receipt coramId does not match', () => {
  const coram = openCoram({ contract: makeContract() });
  closeCoram(coram);
  const badReceipt = { coramId: 'od_coram_wrong', coramHash: coram.finalHash, coramEntryCount: 0 };
  const result = verifyCoram(coram, badReceipt);
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('coramId'));
});

test('fails when Receipt coramEntryCount does not match (truncation)', () => {
  const coram = openCoram({ contract: makeContract() });
  appendEntry(coram, { action: 'tool', input: 'x', result: 'y' });
  closeCoram(coram);
  const badReceipt = { coramId: coram.coramId, coramHash: coram.finalHash, coramEntryCount: 99 };
  const result = verifyCoram(coram, badReceipt);
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('coramEntryCount'));
});

// ─────────────────────────────────────────────────────────────
// SECTION 7: attachCoramToReceipt()
// ─────────────────────────────────────────────────────────────

console.log('\n── attachCoramToReceipt() ───────────────────');

test('adds Coram fields to receipt payload', () => {
  const coram = openCoram({ contract: makeContract() });
  appendEntry(coram, { action: 'tool', input: 'x', result: 'y' });
  closeCoram(coram);

  const fields = { contractId: 'test', output: {} };
  attachCoramToReceipt(fields, coram);

  assert.strictEqual(fields.coramId,         coram.coramId);
  assert.strictEqual(fields.coramHash,       coram.finalHash);
  assert.strictEqual(fields.coramEntryCount, coram.entryCount);
  assert.strictEqual(fields.coramStatus,     'closed');
});

// ─────────────────────────────────────────────────────────────
// SECTION 8: Integration with OpenDone evaluate()
// ─────────────────────────────────────────────────────────────

console.log('\n── Integration: Coram + OpenDone evaluate() ─');

test('full run: Contract → Coram → evaluate → verifyCoram with Receipt', () => {
  const c = makeContract();
  const coram = openCoram({ contract: c, agentId: 'test-agent' });

  // Simulate agent doing work
  appendEntry(coram, { action: 'web.search', input: 'query', result: { hits: 3 } });
  appendEntry(coram, { action: 'fs.write',   input: 'output.txt', result: 'ok' });

  // Close Coram before evaluating
  closeCoram(coram);

  // Evaluate with OpenDone — receipt is hashed at this point
  const receipt = OpenDone.evaluate({
    contract: c,
    output:   { result: 'done' },
    agent:    'test-agent',
  });

  // OpenDone receipt verifies clean on its own
  const openDoneVerify = OpenDone.verify(receipt);
  assert.strictEqual(openDoneVerify.valid, true);

  // Coram verifies clean on its own
  const coramVerify = verifyCoram(coram);
  assert.strictEqual(coramVerify.valid, true);
  assert.strictEqual(coram.entryCount, 2);

  // Cross-check: build a synthetic receipt stub with Coram fields
  // (In production, attachCoramToReceipt is called before receipt.hash is computed)
  const receiptStub = {
    coramId:         coram.coramId,
    coramHash:       coram.finalHash,
    coramEntryCount: coram.entryCount,
  };
  const fullVerify = verifyCoram(coram, receiptStub);
  assert.strictEqual(fullVerify.valid, true);
  assert.ok(fullVerify.reason.includes('reconciled'));
});

test('Coram contract anchor matches the actual contract hash', () => {
  const c = makeContract();
  const coram = openCoram({ contract: c });
  appendEntry(coram, { action: 'tool', input: 'x', result: 'y' });
  // First entry's previousHash must equal the contract's hash
  assert.strictEqual(coram.entries[0].previousHash, c.hash);
});

test('a Coram record from a different contract fails anchor check', () => {
  const c1 = makeContract({ task: 'Task one' });
  const c2 = makeContract({ task: 'Task two' });

  const coram = openCoram({ contract: c1 });
  appendEntry(coram, { action: 'tool', input: 'x', result: 'y' });
  closeCoram(coram);

  // Swap the contractHash to simulate transplant attack
  coram.contractHash = c2.hash;

  const result = verifyCoram(coram);
  assert.strictEqual(result.valid, false);  // anchor no longer matches
});

test('loop warning survives across multi-step run and appears in verify', () => {
  const c = makeContract();
  const coram = openCoram({ contract: c });

  // Normal actions
  appendEntry(coram, { action: 'search', input: 'topic', result: 'data' });
  appendEntry(coram, { action: 'write',  input: 'file',  result: 'ok'   });
  // Loop: repeat the same search
  appendEntry(coram, { action: 'search', input: 'topic', result: 'data' });
  // Continue normally
  appendEntry(coram, { action: 'finish', input: 'done',  result: 'yes'  });

  closeCoram(coram);
  const verify = verifyCoram(coram);

  assert.strictEqual(verify.valid,                    true);
  assert.strictEqual(verify.loopWarnings.length,      1);
  assert.strictEqual(verify.loopWarnings[0].action,   'search');
  assert.strictEqual(verify.loopWarnings[0].loopCount, 2);
  assert.strictEqual(verify.detail.entryCount,        4);
});

// ─────────────────────────────────────────────────────────────
// RESULTS
// ─────────────────────────────────────────────────────────────

console.log(`\n─────────────────────────────────────────────`);
console.log(`Coram Test Suite: ${passed + failed} tests`);
console.log(`  ✓ Passed: ${passed}`);
if (failed > 0) {
  console.log(`  ✗ Failed: ${failed}`);
  failures.forEach(f => console.log(`    - ${f.name}: ${f.error}`));
  process.exit(1);
} else {
  console.log(`\nAll tests passed.`);
}
