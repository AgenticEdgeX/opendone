'use strict';

/**
 * test-integration.js
 * Full stack integration tests — all five primitives working together.
 * Written against the REAL API as it exists in the repo.
 *
 * API notes:
 *   - Conditions use "operator" not "op"
 *   - criteria object is REQUIRED in contract()
 *   - receipt.passed is boolean (not status string)
 *   - receipt.version (not specVersion)
 *   - Coram is used via od.appendEntry(coram, data), od.closeCoram(coram), od.verifyCoram(record, receipt)
 *   - coram IS the record (no getRecord() method)
 *   - od.checkpoint() not od.openCheckpoint()
 */

const od       = require('./opendone');
const { openUmbra, UmbraViolationError, UmbraLoopError } = require('./umbra');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  ✓ ${name}\n`);
    passed++;
  } catch (e) {
    process.stdout.write(`  ✗ ${name}\n    → ${e.message}\n`);
    failed++;
    failures.push({ name, error: e.message });
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ✓ ${name}\n`);
    passed++;
  } catch (e) {
    process.stdout.write(`  ✗ ${name}\n    → ${e.message}\n`);
    failed++;
    failures.push({ name, error: e.message });
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function section(title) {
  process.stdout.write(`\n${title}\n${'─'.repeat(title.length)}\n`);
}

// ─────────────────────────────────────────────────────────────
// 1. CONTRACT
// ─────────────────────────────────────────────────────────────

section('1. Contract');

test('creates with required fields', () => {
  const c = od.contract({ task: 'Test task', criteria: { required: ['result'] } });
  assert(c.contractId.startsWith('od_c'), 'contractId prefix');
  assert(c.hash, 'has hash');
  assert(c.version === '0.4.0', 'version');
  assert(c.task === 'Test task', 'task preserved');
});

test('hash changes when task changes', () => {
  const c1 = od.contract({ task: 'Task A', criteria: { required: ['x'] } });
  const c2 = od.contract({ task: 'Task B', criteria: { required: ['x'] } });
  assert(c1.hash !== c2.hash, 'different tasks = different hashes');
});

test('expiresAt offset from expiresIn', () => {
  const before = Date.now();
  const c = od.contract({ task: 't', criteria: { required: ['x'] }, expiresIn: 3600 });
  const after = Date.now();
  const exp = new Date(c.expiresAt).getTime();
  assert(exp >= before + 3599000 && exp <= after + 3601000, 'expiresAt within range');
});

test('constraints preserved', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] }, constraints: { maxIterations: 10, maxDurationMs: 5000 } });
  assert(c.constraints.maxIterations === 10, 'maxIterations');
  assert(c.constraints.maxDurationMs === 5000, 'maxDurationMs');
});

test('throws without task', () => {
  let threw = false;
  try { od.contract({ criteria: { required: ['x'] } }); }
  catch (e) { threw = e.code === 'INVALID_CONTRACT'; }
  assert(threw, 'throws INVALID_CONTRACT');
});

test('throws without criteria', () => {
  let threw = false;
  try { od.contract({ task: 't' }); }
  catch (e) { threw = e.code === 'INVALID_CONTRACT'; }
  assert(threw, 'throws INVALID_CONTRACT without criteria');
});

test('contractId unique per call', () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) {
    ids.add(od.contract({ task: 't', criteria: { required: ['x'] } }).contractId);
  }
  assert(ids.size === 100, 'all unique');
});

test('criteria frozen after creation', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'], conditions: [{ field: 'score', operator: '>', value: 0.5 }] } });
  let threw = false;
  try { c.criteria.required.push('injected'); } catch { threw = true; }
  assert(threw || c.criteria.required.length === 1, 'criteria array frozen');
});

test('constraints frozen after creation', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] }, constraints: { maxIterations: 5 } });
  let threw = false;
  try { c.constraints.maxIterations = 9999; } catch { threw = true; }
  assert(threw || c.constraints.maxIterations === 5, 'constraints frozen');
});

// ─────────────────────────────────────────────────────────────
// 2. EVALUATE
// ─────────────────────────────────────────────────────────────

section('2. Evaluate');

test('passes all required fields present', () => {
  const c = od.contract({ task: 't', criteria: { required: ['summary', 'score'] } });
  const r = od.evaluate({ contract: c, output: { summary: 'done', score: 0.9 }, agent: 'test' });
  assert(r.passed === true, `Expected true, got ${r.passed}`);
});

test('fails when required field missing', () => {
  const c = od.contract({ task: 't', criteria: { required: ['summary'] } });
  const r = od.evaluate({ contract: c, output: {}, agent: 'test' });
  assert(r.passed === false, `Expected false, got ${r.passed}`);
});

test('partial: some criteria pass, some fail', () => {
  const c = od.contract({ task: 't', criteria: { required: ['a', 'b'] } });
  const r = od.evaluate({ contract: c, output: { a: 'present' }, agent: 'test' });
  assert(r.passed === false, 'not fully passed');
  assert(r.criteriaResults.some(cr => cr.passed), 'some passed');
  assert(r.criteriaResults.some(cr => !cr.passed), 'some failed');
});

test('condition: operator ===', () => {
  const c = od.contract({ task: 't', criteria: { conditions: [{ field: 'status', operator: '===', value: 'complete' }] } });
  const r = od.evaluate({ contract: c, output: { status: 'complete' }, agent: 'test' });
  assert(r.passed === true, 'passed');
});

test('condition: operator >', () => {
  const c = od.contract({ task: 't', criteria: { conditions: [{ field: 'score', operator: '>', value: 0.8 }] } });
  const r = od.evaluate({ contract: c, output: { score: 0.9 }, agent: 'test' });
  assert(r.passed === true, 'passed');
});

test('condition: operator >=', () => {
  const c = od.contract({ task: 't', criteria: { conditions: [{ field: 'score', operator: '>=', value: 0.9 }] } });
  const r = od.evaluate({ contract: c, output: { score: 0.9 }, agent: 'test' });
  assert(r.passed === true, 'passed');
});

test('condition: operator includes', () => {
  const c = od.contract({ task: 't', criteria: { conditions: [{ field: 'summary', operator: 'includes', value: 'revenue' }] } });
  const r = od.evaluate({ contract: c, output: { summary: 'Q1 revenue up 12%' }, agent: 'test' });
  assert(r.passed === true, 'passed');
});

test('condition: operator matches (regex)', () => {
  const c = od.contract({ task: 't', criteria: { conditions: [{ field: 'email', operator: 'matches', value: '^[\\w.+]+@[\\w.]+$' }] } });
  const r = od.evaluate({ contract: c, output: { email: 'user@example.com' }, agent: 'test' });
  assert(r.passed === true, 'passed');
});

test('condition: operator typeof', () => {
  const c = od.contract({ task: 't', criteria: { conditions: [{ field: 'count', operator: 'typeof', value: 'number' }] } });
  const r = od.evaluate({ contract: c, output: { count: 42 }, agent: 'test' });
  assert(r.passed === true, 'passed');
});

test('condition: operator !== fails correctly', () => {
  const c = od.contract({ task: 't', criteria: { conditions: [{ field: 'status', operator: '!==', value: 'error' }] } });
  const r = od.evaluate({ contract: c, output: { status: 'error' }, agent: 'test' });
  assert(r.passed === false, 'failed correctly');
});

test('numeric operator rejects string value', () => {
  const c = od.contract({ task: 't', criteria: { conditions: [{ field: 'score', operator: '>', value: 0.8 }] } });
  const r = od.evaluate({ contract: c, output: { score: '0.9' }, agent: 'test' });
  assert(r.passed === false, 'string does not pass numeric operator');
});

test('constraint: maxDurationMs violation', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] }, constraints: { maxDurationMs: 100 } });
  const r = od.evaluate({ contract: c, output: { x: 'y' }, agent: 'test', runtime: { durationMs: 5000 } });
  assert(r.passed === false, 'constraint violated');
  assert(r.constraintResults.some(cr => cr.constraint === 'maxDurationMs' && !cr.passed), 'maxDurationMs in results');
});

test('constraint: maxIterations violation', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] }, constraints: { maxIterations: 3 } });
  const r = od.evaluate({ contract: c, output: { x: 'y' }, agent: 'test', runtime: { iterations: 10 } });
  assert(r.passed === false, 'constraint violated');
  assert(r.constraintResults.some(cr => cr.constraint === 'maxIterations' && !cr.passed), 'maxIterations in results');
});

test('expired contract throws CONTRACT_EXPIRED', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  c.expiresAt = new Date(Date.now() - 1000).toISOString();
  let threw = false;
  try { od.evaluate({ contract: c, output: { x: 1 } }); }
  catch (e) { threw = e.code === 'CONTRACT_EXPIRED'; }
  assert(threw, 'throws CONTRACT_EXPIRED');
});

test('receipt has required fields', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const r = od.evaluate({ contract: c, output: { x: 'y' }, agent: 'test-agent' });
  assert(r.receiptId, 'has receiptId');
  assert(r.receiptId.startsWith('od_r'), 'receiptId prefix');
  assert(r.hash, 'has hash');
  assert(r.contractHash === c.hash, 'contractHash matches contract');
  assert(r.contractId === c.contractId, 'contractId matches');
  assert(r.version === '0.4.0', 'has version');
  assert(r.agent === 'test-agent', 'agent preserved');
});

test('evaluate without agent defaults to unknown', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const r = od.evaluate({ contract: c, output: { x: 'y' } });
  assert(r.agent === 'unknown', 'defaults to unknown');
});

test('score deterministic for same input', () => {
  const c = od.contract({ task: 't', criteria: { required: ['a', 'b'], conditions: [{ field: 'score', operator: '>', value: 0.5 }] } });
  const output = { a: 'x', score: 0.9 }; // b missing
  const r1 = od.evaluate({ contract: c, output, agent: 'a' });
  const r2 = od.evaluate({ contract: c, output, agent: 'a' });
  assert(r1.passed === r2.passed, 'passed is deterministic');
  assert(r1.criteriaResults.length === r2.criteriaResults.length, 'same result count');
});

test('whitespace-only string fails required field', () => {
  const c = od.contract({ task: 't', criteria: { required: ['summary'] } });
  const r = od.evaluate({ contract: c, output: { summary: '   ' }, agent: 'test' });
  assert(r.passed === false, 'whitespace-only should fail');
});

test('multiple receipts from same contract are independent', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const r1 = od.evaluate({ contract: c, output: { x: 'a' }, agent: 'a1' });
  const r2 = od.evaluate({ contract: c, output: { x: 'b' }, agent: 'a2' });
  assert(r1.receiptId !== r2.receiptId, 'different receiptIds');
  assert(r1.hash !== r2.hash, 'different hashes');
  assert(r1.contractId === r2.contractId, 'same contractId');
});

// ─────────────────────────────────────────────────────────────
// 3. VERIFY
// ─────────────────────────────────────────────────────────────

section('3. Verify');

test('valid receipt passes verify', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const r = od.evaluate({ contract: c, output: { x: 'y' }, agent: 'test' });
  const v = od.verify(r);
  assert(v.valid === true, 'valid');
});

test('tampered passed field detected', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const failing = od.evaluate({ contract: c, output: {}, agent: 'test' });
  assert(failing.passed === false, 'starts as failed');
  const tampered = { ...failing, passed: true };
  const v = od.verify(tampered);
  assert(v.valid === false, 'tamper detected');
});

test('tampered criteriaResults detected', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const r = od.evaluate({ contract: c, output: { x: 'y' }, agent: 'test' });
  const tampered = { ...r, criteriaResults: [] };
  const v = od.verify(tampered);
  assert(v.valid === false, 'tamper detected');
});

test('signed receipt verifies with correct public key', () => {
  const { publicKey, privateKey } = od.generateKeyPair();
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const r = od.evaluate({ contract: c, output: { x: 'y' }, agent: 'test', privateKey });
  const v = od.verify(r, publicKey);
  assert(v.valid === true, 'valid with correct key');
});

test('wrong public key fails signature check', () => {
  const { privateKey } = od.generateKeyPair();
  const { publicKey: wrongKey } = od.generateKeyPair();
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const r = od.evaluate({ contract: c, output: { x: 'y' }, agent: 'test', privateKey });
  const v = od.verify(r, wrongKey);
  assert(v.valid === false, 'invalid with wrong key');
});

test('verify without public key skips signature check', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const r = od.evaluate({ contract: c, output: { x: 'y' }, agent: 'test' });
  const v = od.verify(r);
  assert(v.valid === true, 'passes without key');
});

// ─────────────────────────────────────────────────────────────
// 4. CHECKPOINT
// ─────────────────────────────────────────────────────────────

section('4. Checkpoint');

test('emits checkpoint receipt', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] }, constraints: { maxIterations: 10 } });
  const r = od.checkpoint({ contract: c, iteration: 3, state: { progress: 0.3 }, runtime: { iterations: 3 } });
  assert(r.isCheckpoint === true, 'isCheckpoint');
  assert(r.checkpointIteration === 3, 'iteration recorded');
  assert(r.hash, 'has hash');
});

test('checkpoint passes within limits', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] }, constraints: { maxIterations: 10 } });
  const r = od.checkpoint({ contract: c, iteration: 3, runtime: { iterations: 3 } });
  assert(r.passed === true, 'within limits');
});

test('checkpoint throws CONSTRAINT_BREACH when limit exceeded', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] }, constraints: { maxIterations: 5 } });
  let threw = false;
  try { od.checkpoint({ contract: c, iteration: 10, runtime: { iterations: 10 } }); }
  catch (e) { threw = e.code === 'CONSTRAINT_BREACH'; }
  assert(threw, 'throws CONSTRAINT_BREACH');
});

test('checkpoint receipt is verifiable', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] }, constraints: { maxIterations: 10 } });
  const r = od.checkpoint({ contract: c, iteration: 2, runtime: { iterations: 2 } });
  const v = od.verify(r);
  assert(v.valid === true, 'verifiable');
});

// ─────────────────────────────────────────────────────────────
// 5. CORAM
// ─────────────────────────────────────────────────────────────

section('5. Coram');

test('openCoram creates valid record', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const coram = od.openCoram({ contract: c, agentId: 'test-agent' });
  assert(coram.coramId, 'has coramId');
  assert(coram.contractId === c.contractId, 'contractId matches');
  assert(coram.agentId === 'test-agent', 'agentId preserved');
  assert(coram.status === 'open', 'status open');
  assert(coram.entries.length === 0, 'empty entries');
});

test('appendEntry records action with hash chain', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const coram = od.openCoram({ contract: c });
  const e = od.appendEntry(coram, { action: 'tool.call', input: { q: 'test' }, result: { data: 'result' } });
  assert(e.entryId === 1, 'entryId is 1');
  assert(e.entryHash, 'has entryHash');
  assert(e.previousHash === c.hash, 'anchors to contractHash');
  assert(coram.entryCount === 1, 'entryCount updated');
});

test('hash chain links entries', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const coram = od.openCoram({ contract: c });
  const e1 = od.appendEntry(coram, { action: 'tool.call', input: { q: 'first' } });
  const e2 = od.appendEntry(coram, { action: 'tool.call', input: { q: 'second' } });
  assert(e2.previousHash === e1.entryHash, 'e2 links to e1');
  assert(coram.entryCount === 2, 'entryCount is 2');
});

test('verifyCoram passes clean chain', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const coram = od.openCoram({ contract: c });
  od.appendEntry(coram, { action: 'tool.call', input: { q: 'a' } });
  od.appendEntry(coram, { action: 'tool.call', input: { q: 'b' } });
  od.closeCoram(coram);
  const v = od.verifyCoram(coram);
  assert(v.valid === true, 'chain valid');
});

test('verifyCoram detects tampered entry', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const coram = od.openCoram({ contract: c });
  od.appendEntry(coram, { action: 'tool.call', input: { q: 'original' } });
  od.closeCoram(coram);
  coram.entries[0].action = 'TAMPERED';
  const v = od.verifyCoram(coram);
  assert(v.valid === false, 'tamper detected');
});

test('closeCoram seals record', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const coram = od.openCoram({ contract: c });
  od.appendEntry(coram, { action: 'tool.call', input: {} });
  od.closeCoram(coram);
  assert(coram.status === 'closed', 'status closed');
  assert(coram.finalHash, 'finalHash set');
  let threw = false;
  try { od.appendEntry(coram, { action: 'x', input: {} }); } catch { threw = true; }
  assert(threw, 'cannot append after close');
});

test('loop detection via loopWarning on entries', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const coram = od.openCoram({ contract: c });
  od.appendEntry(coram, { action: 'web.search', input: { q: 'same query' } });
  od.appendEntry(coram, { action: 'web.search', input: { q: 'same query' } });
  const e3 = od.appendEntry(coram, { action: 'web.search', input: { q: 'same query' } });
  assert(e3.loopWarning === true, 'loop detected');
  assert(e3.loopCount >= 2, 'loopCount incremented');
});

test('different inputs do not trigger loop warning', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const coram = od.openCoram({ contract: c });
  const e1 = od.appendEntry(coram, { action: 'web.search', input: { q: 'query A' } });
  const e2 = od.appendEntry(coram, { action: 'web.search', input: { q: 'query B' } });
  assert(e1.loopWarning === false, 'no loop on first');
  assert(e2.loopWarning === false, 'no loop on different input');
});

test('verifyCoram with receipt cross-check', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const coram = od.openCoram({ contract: c });
  od.appendEntry(coram, { action: 'tool.call', input: {} });
  const r = od.evaluate({ contract: c, output: { x: 'y' }, agent: 'test', coram });
  const v = od.verifyCoram(coram, r.coramHash ? r : null);
  assert(v.valid === true, 'chain valid after evaluate');
});

test('empty coram verifies clean', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const coram = od.openCoram({ contract: c });
  od.closeCoram(coram);
  const v = od.verifyCoram(coram);
  assert(v.valid === true, 'empty chain valid');
});

// ─────────────────────────────────────────────────────────────
// 6. UMBRA (standalone)
// ─────────────────────────────────────────────────────────────

section('6. Umbra (standalone)');

testAsync('enforce mode blocks blocklisted tool', async () => {
  const umbra = openUmbra({ preset: 'operate', overrides: { blocklist: ['exec_shell'] } });
  let threw = false;
  try { await umbra.check({ tool: 'exec_shell', input: {} }); } catch (e) { threw = e instanceof UmbraViolationError; }
  assert(threw, 'throws UmbraViolationError');
});

testAsync('enforce mode passes allowed tool', async () => {
  const umbra = openUmbra({ preset: 'operate', overrides: { blocklist: ['exec_shell'] } });
  const result = await umbra.check({ tool: 'web_search', input: { q: 'test' } });
  assert(result.passed === true, 'allowed tool passes');
});

testAsync('warn mode returns warning without throwing', async () => {
  const umbra = openUmbra({ preset: 'explore', overrides: { blocklist: ['exec_shell'] } });
  const result = await umbra.check({ tool: 'exec_shell', input: {} });
  assert(result.passed === false, 'not passed');
  assert(result.warning === true, 'warning flag set');
});

testAsync('audit mode logs everything, blocks nothing', async () => {
  const umbra = openUmbra({ preset: 'custom', overrides: { mode: 'audit', blocklist: ['exec_shell'] } });
  const result = await umbra.check({ tool: 'exec_shell', input: {} });
  assert(result.passed === true, 'audit passes everything');
  assert(result.mode === 'audit', 'mode is audit');
});

testAsync('closed instance rejects checks', async () => {
  const umbra = openUmbra({ preset: 'operate' });
  umbra.close();
  let threw = false;
  try { await umbra.check({ tool: 'web_search', input: {} }); } catch { threw = true; }
  assert(threw, 'closed instance throws');
});

testAsync('close summary has correct counts', async () => {
  const umbra = openUmbra({ preset: 'operate', overrides: { blocklist: ['bad_tool'] } });
  await umbra.check({ tool: 'web_search', input: {} });
  await umbra.check({ tool: 'read_file',  input: {} });
  const summary = umbra.close();
  assert(summary.totalChecks === 2, 'totalChecks is 2');
  assert(summary.violations === 0, 'no violations');
});

// ─────────────────────────────────────────────────────────────
// 7. FULL INTEGRATION — happy path
// ─────────────────────────────────────────────────────────────

section('7. Full integration \u2014 happy path');

testAsync('contract \u2192 coram \u2192 umbra \u2192 evaluate \u2192 verify', async () => {
  const c = od.contract({
    task: 'Research competitors and write summary',
    criteria: {
      required: ['summary'],
      conditions: [
        { field: 'confidence', operator: '>=', value: 0.8 },
        { field: 'summary',    operator: 'includes', value: 'competitor' },
      ],
    },
    constraints: { maxIterations: 10 },
  });

  const coram = od.openCoram({ contract: c, agentId: 'research-agent-v1' });

  const umbra = openUmbra({
    contract: c, coram,
    preset: 'operate',
    overrides: { blocklist: ['exec_shell', 'send_email_external'] }
  });

  await umbra.check({ tool: 'web_search', input: { query: 'competitor analysis' } });
  od.appendEntry(coram, { action: 'tool.call', tool: 'web_search', input: { query: 'competitor analysis' }, result: { results: [] } });

  await umbra.check({ tool: 'web_search', input: { query: 'market share data' } });
  od.appendEntry(coram, { action: 'tool.call', tool: 'web_search', input: { query: 'market share data' }, result: { results: [] } });

  const receipt = od.evaluate({
    contract: c,
    output: { summary: 'Analysis of competitor landscape shows 3 main competitors.', confidence: 0.92 },
    agent: 'research-agent-v1',
    runtime: { iterations: 3 },
    coram,
  });

  const verification = od.verify(receipt);
  const chainResult = od.verifyCoram(coram);

  assert(receipt.passed === true, `receipt.passed should be true, got ${receipt.passed}`);
  assert(verification.valid === true, 'receipt verifies');
  assert(chainResult.valid === true, 'coram chain valid');

  const umbraSummary = umbra.close();
  assert(umbraSummary.violations === 0, 'no umbra violations');
});

// ─────────────────────────────────────────────────────────────
// 8. FULL INTEGRATION — blocked agent
// ─────────────────────────────────────────────────────────────

section('8. Full integration \u2014 blocked agent');

testAsync('blocked tool: agent stops, receipt reflects failure', async () => {
  const c = od.contract({
    task: 'Safe research task',
    criteria: { required: ['result'] },
  });

  const coram = od.openCoram({ contract: c });
  const umbra = openUmbra({
    contract: c, coram,
    preset: 'operate',
    overrides: { blocklist: ['exec_shell'] }
  });

  await umbra.check({ tool: 'web_search', input: { q: 'safe' } });
  od.appendEntry(coram, { action: 'tool.call', tool: 'web_search', input: { q: 'safe' } });

  await umbra.check({ tool: 'read_file', input: { path: 'report.pdf' } });
  od.appendEntry(coram, { action: 'tool.call', tool: 'read_file', input: { path: 'report.pdf' } });

  const entriesBefore = coram.entryCount;

  let blocked = false;
  try { await umbra.check({ tool: 'exec_shell', input: { cmd: 'rm -rf /' } }); }
  catch (e) { blocked = e instanceof UmbraViolationError; }

  assert(blocked, 'blocked tool throws UmbraViolationError');
  assert(coram.entryCount === entriesBefore, 'blocked call not logged in coram');

  const receipt = od.evaluate({ contract: c, output: {}, agent: 'test', coram });
  assert(receipt.passed === false, 'receipt failed');
  const v = od.verify(receipt);
  assert(v.valid === true, 'receipt still verifiable');
});

// ─────────────────────────────────────────────────────────────
// 9. FULL INTEGRATION — loop detection
// ─────────────────────────────────────────────────────────────

section('9. Full integration \u2014 loop detection');

testAsync('loopWarning appears in coram entries after repeated calls', async () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const coram = od.openCoram({ contract: c });
  const umbra = openUmbra({ contract: c, coram, preset: 'operate' });

  for (let i = 0; i < 3; i++) {
    await umbra.check({ tool: 'web_search', input: { q: 'stuck query' } });
    od.appendEntry(coram, { action: 'tool.call', tool: 'web_search', input: { q: 'stuck query' } });
  }

  const loopWarnings = coram.entries.filter(e => e.loopWarning);
  assert(loopWarnings.length > 0, 'loop warnings recorded in coram');
});

testAsync('onLoop:throw halts the agent', async () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const coram = od.openCoram({ contract: c });
  const umbra = openUmbra({
    contract: c, coram,
    preset: 'operate',
    overrides: { loopThreshold: 2, onLoop: 'throw' }
  });

  let threw = false;
  try {
    await umbra.check({ tool: 'web_search', input: { q: 'stuck' } });
    await umbra.check({ tool: 'web_search', input: { q: 'stuck' } });
    await umbra.check({ tool: 'web_search', input: { q: 'stuck' } });
  } catch (e) {
    threw = e instanceof UmbraLoopError;
  }
  assert(threw, 'UmbraLoopError thrown on loop');
});

testAsync('onLoop:realign returns directive', async () => {
  const c = od.contract({ task: 'Research task', criteria: { required: ['x'] } });
  const coram = od.openCoram({ contract: c });
  const umbra = openUmbra({
    contract: c, coram,
    preset: 'operate',
    overrides: { loopThreshold: 2, onLoop: 'realign' }
  });

  let result;
  for (let i = 0; i < 3; i++) {
    result = await umbra.check({ tool: 'web_search', input: { q: 'stuck' } });
  }
  assert(result && (result.passed === false || result.loopAction), 'loop action triggered');
});

// ─────────────────────────────────────────────────────────────
// 10. FULL INTEGRATION — cryptographic signing
// ─────────────────────────────────────────────────────────────

section('10. Full integration \u2014 cryptographic signing');

testAsync('signed contract + signed receipt + coram \u2014 all verify', async () => {
  const { publicKey, privateKey } = od.generateKeyPair();

  const c = od.sign(od.contract({ task: 'Signed task', criteria: { required: ['result'] } }), privateKey);
  assert(c.signature, 'contract is signed');

  const coram = od.openCoram({ contract: c });
  od.appendEntry(coram, { action: 'tool.call', tool: 'web_search', input: { q: 'test' } });

  const receipt = od.evaluate({
    contract: c,
    output: { result: 'done' },
    agent: 'signed-agent',
    runtime: { iterations: 1 },
    coram,
    privateKey,
  });

  assert(receipt.signature, 'receipt is signed');
  assert(receipt.passed === true, 'receipt passed');

  const contractVerify = od.verify(c, publicKey);
  const receiptVerify  = od.verify(receipt, publicKey);
  const chainVerify    = od.verifyCoram(coram);

  assert(contractVerify.valid === true, 'contract verifies');
  assert(receiptVerify.valid === true,  'receipt verifies');
  assert(chainVerify.valid === true,    'coram chain verifies');
});

// ─────────────────────────────────────────────────────────────
// 11. CROSS-PRIMITIVE CONTRACT BINDING
// ─────────────────────────────────────────────────────────────

section('11. Cross-primitive contract binding');

test('contractId flows consistently through all primitives', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const coram  = od.openCoram({ contract: c });
  od.appendEntry(coram, { action: 'tool.call', input: {} });
  const receipt = od.evaluate({ contract: c, output: { x: 'y' }, agent: 'test', coram });

  assert(coram.contractId   === c.contractId, 'coram.contractId matches');
  assert(receipt.contractId === c.contractId, 'receipt.contractId matches');
  assert(receipt.contractHash === c.hash,     'receipt.contractHash matches');
});

test('coram from different contract fails receipt cross-check', () => {
  const c1 = od.contract({ task: 'Task 1', criteria: { required: ['x'] } });
  const c2 = od.contract({ task: 'Task 2', criteria: { required: ['x'] } });

  const coram = od.openCoram({ contract: c1 });
  od.appendEntry(coram, { action: 'tool.call', input: {} });
  od.closeCoram(coram);

  const receipt = od.evaluate({ contract: c2, output: { x: 'y' }, agent: 'test' });

  const v = od.verifyCoram(coram, receipt);
  assert(v.valid === false, 'cross-contract mismatch detected');
});

test('tampered contractHash detected by verify', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const r = od.evaluate({ contract: c, output: { x: 'y' }, agent: 'test' });
  const tampered = { ...r, contractHash: 'FAKE_HASH_AAAA' };
  const v = od.verify(tampered);
  assert(v.valid === false, 'tampered contractHash detected');
});

// ─────────────────────────────────────────────────────────────
// 12. EDGE CASES
// ─────────────────────────────────────────────────────────────

section('12. Edge cases');

test('unknown operator throws INVALID_CONTRACT', () => {
  let threw = false;
  try {
    od.contract({ task: 't', criteria: { conditions: [{ field: 'x', operator: 'BANANA', value: 1 }] } });
  } catch (e) { threw = e.code === 'INVALID_CONTRACT'; }
  assert(threw, 'unknown operator throws');
});

testAsync('umbra without contract still enforces blocklist', async () => {
  const umbra = openUmbra({ preset: 'operate', overrides: { blocklist: ['exec_shell'] } });
  let threw = false;
  try { await umbra.check({ tool: 'exec_shell', input: {} }); } catch (e) { threw = e instanceof UmbraViolationError; }
  assert(threw, 'blocklist enforced without contract');
});

test('nested field evaluation via dot notation', () => {
  const c = od.contract({ task: 't', criteria: { conditions: [{ field: 'meta.confidence', operator: '>', value: 0.7 }] } });
  const r = od.evaluate({ contract: c, output: { meta: { confidence: 0.9 } }, agent: 'test' });
  assert(r.passed === true, 'nested field evaluated correctly');
});

test('ReDoS: dangerous regex fails safely', () => {
  const c = od.contract({ task: 't', criteria: { conditions: [{ field: 'x', operator: 'matches', value: '(a+)+' }] } });
  const r = od.evaluate({ contract: c, output: { x: 'aaaaaaaaaaaaaaaa!' }, agent: 'test' });
  assert(r.passed === false, 'dangerous regex fails the condition');
});

test('constraint bypass: missing runtime with constraint defined is a violation', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] }, constraints: { maxDurationMs: 100 } });
  const r = od.evaluate({ contract: c, output: { x: 'y' }, agent: 'test' }); // no runtime
  assert(r.passed === false, 'missing runtime = constraint violation');
  assert(r.constraintResults.some(cr => cr.constraint === 'maxDurationMs' && !cr.passed), 'violation recorded');
});

test('coram + evaluate integration: coram attached to receipt', () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const coram = od.openCoram({ contract: c });
  od.appendEntry(coram, { action: 'tool.call', input: {} });
  const r = od.evaluate({ contract: c, output: { x: 'y' }, agent: 'test', coram });
  assert(r.coramHash, 'coramHash attached to receipt');
  assert(r.coramEntryCount === 1, 'coramEntryCount attached');
  assert(r.coramStatus === 'closed', 'coramStatus attached');
});

testAsync('umbra passing call tracked correctly', async () => {
  const c = od.contract({ task: 't', criteria: { required: ['x'] } });
  const coram  = od.openCoram({ contract: c });
  const umbra  = openUmbra({ contract: c, coram, preset: 'operate' });

  await umbra.check({ tool: 'web_search', input: { q: 'test' } });
  od.appendEntry(coram, { action: 'tool.call', tool: 'web_search', input: { q: 'test' } });

  const summary = umbra.close();
  assert(summary.totalChecks === 1, 'one check recorded');
  assert(summary.violations === 0, 'no violations');
  assert(coram.entryCount === 1, 'coram has one entry');
});

test('file store persists receipt', () => {
  const os   = require('os');
  const path = require('path');
  const fs   = require('fs');
  const storePath = path.join(os.tmpdir(), `od_test_${Date.now()}.json`);
  try {
    const store = od.fileStore(storePath);
    const c = od.contract({ task: 't', criteria: { required: ['x'] } });
    const r = od.evaluate({ contract: c, output: { x: 'y' }, agent: 'test', store });
    assert(fs.existsSync(storePath), 'file created');
    const loaded = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert(loaded.length === 1, 'one receipt saved');
    assert(loaded[0].receiptId === r.receiptId, 'receipt ID matches');
  } finally {
    try { fs.unlinkSync(storePath); } catch {}
  }
});

// ─────────────────────────────────────────────────────────────
// RESULTS
// ─────────────────────────────────────────────────────────────

setTimeout(async () => {
  const total = passed + failed;
  process.stdout.write(`\n${'═'.repeat(50)}\n`);
  process.stdout.write(`  Results: ${passed}/${total} passing\n`);
  if (failures.length > 0) {
    process.stdout.write(`\n  Failures:\n`);
    failures.forEach(f => process.stdout.write(`  ✗ ${f.name}\n    → ${f.error}\n`));
  } else {
    process.stdout.write(`  All tests passed.\n`);
  }
  if (failed > 0) process.exit(1);
}, 500);
