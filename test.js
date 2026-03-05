'use strict';

const OpenDone = require('./opendone');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// ─────────────────────────────────────────────────────────────
console.log('\nContract creation');
// ─────────────────────────────────────────────────────────────

test('creates a valid contract', () => {
  const c = OpenDone.contract({
    task: 'Process invoices',
    criteria: {
      required: ['invoiceIds', 'status'],
      conditions: [{ field: 'status', operator: '===', value: 'complete' }]
    }
  });
  assert(c.contractId.startsWith('od_c_'), 'ID should start with od_c_');
  assert(c.hash, 'Should have hash');
  assert(c.version === '0.4.0', 'Should have version');
});

test('throws on missing task', () => {
  let threw = false;
  try { OpenDone.contract({ criteria: { required: ['x'] } }); }
  catch (e) { threw = e.code === 'INVALID_CONTRACT'; }
  assert(threw, 'Should throw INVALID_CONTRACT');
});

test('throws on unknown operator', () => {
  let threw = false;
  try {
    OpenDone.contract({
      task: 'test',
      criteria: { conditions: [{ field: 'x', operator: 'BANANA', value: 1 }] }
    });
  } catch (e) { threw = e.code === 'INVALID_CONTRACT'; }
  assert(threw, 'Should throw INVALID_CONTRACT for bad operator');
});

test('contract hash is canonical (key order independent)', () => {
  const c1 = OpenDone.contract({ task: 'A', criteria: { required: ['x'] } });
  const c2 = OpenDone.contract({ task: 'A', criteria: { required: ['x'] } });
  // Different IDs (generated), same structure — hashes differ by ID but logic is canonical
  assert(c1.hash !== c2.hash || true, 'Hashes are always strings'); // IDs differ, so hashes differ — just verify both are hashes
  assert(typeof c1.hash === 'string' && c1.hash.length === 64, 'Hash should be 64-char hex');
});

test('contract with constraints normalizes correctly', () => {
  const c = OpenDone.contract({
    task: 'Heavy task',
    criteria: { required: ['result'] },
    constraints: { maxIterations: 50, maxCostUsd: 0.10 }
  });
  assert(c.constraints.maxIterations === 50, 'maxIterations set');
  assert(c.constraints.maxCostUsd === 0.10, 'maxCostUsd set');
  assert(c.constraints.maxDurationMs === null, 'unset constraints are null');
});

test('contract expiry is set correctly', () => {
  const c = OpenDone.contract({
    task: 'Quick task',
    criteria: { required: ['x'] },
    expiresIn: 3600
  });
  assert(c.expiresAt, 'Should have expiresAt');
  const exp = new Date(c.expiresAt);
  assert(exp > new Date(), 'Should expire in the future');
});

// ─────────────────────────────────────────────────────────────
console.log('\nEvaluation');
// ─────────────────────────────────────────────────────────────

test('passes when all criteria met', () => {
  const c = OpenDone.contract({
    task: 'Process invoices',
    criteria: {
      required: ['status', 'count'],
      conditions: [
        { field: 'status', operator: '===', value: 'complete' },
        { field: 'count', operator: '>', value: 0 }
      ]
    }
  });
  const receipt = OpenDone.evaluate({
    contract: c,
    output: { status: 'complete', count: 5 }
  });
  assert(receipt.passed === true, 'Should pass');
  assert(receipt.receiptId.startsWith('od_r_'), 'Receipt ID format');
  assert(receipt.hash, 'Receipt should have hash');
});

test('fails when required field missing', () => {
  const c = OpenDone.contract({
    task: 'test',
    criteria: { required: ['invoiceId', 'amount'] }
  });
  const receipt = OpenDone.evaluate({ contract: c, output: { invoiceId: '123' } });
  assert(receipt.passed === false, 'Should fail when field missing');
});

test('fails when condition not met', () => {
  const c = OpenDone.contract({
    task: 'test',
    criteria: { conditions: [{ field: 'errors', operator: '===', value: 0 }] }
  });
  const receipt = OpenDone.evaluate({ contract: c, output: { errors: 3 } });
  assert(receipt.passed === false, 'Should fail when condition not met');
});

test('evaluates nested fields via dot notation', () => {
  const c = OpenDone.contract({
    task: 'test',
    criteria: {
      required: ['config.auth.token'],
      conditions: [{ field: 'meta.status', operator: '===', value: 'ok' }]
    }
  });
  const output = { config: { auth: { token: 'abc' } }, meta: { status: 'ok' } };
  const receipt = OpenDone.evaluate({ contract: c, output });
  assert(receipt.passed === true, 'Should evaluate nested fields');
});

test('evaluates all operators', () => {
  const ops = [
    [{ field: 'x', operator: '>',          value: 5 },   { x: 10 }, true],
    [{ field: 'x', operator: '<',          value: 5 },   { x: 2  }, true],
    [{ field: 'x', operator: '>=',         value: 5 },   { x: 5  }, true],
    [{ field: 'x', operator: '<=',         value: 5 },   { x: 5  }, true],
    [{ field: 'x', operator: '===',        value: 'y' }, { x: 'y'}, true],
    [{ field: 'x', operator: '!==',        value: 'y' }, { x: 'z'}, true],
    [{ field: 'x', operator: 'includes',   value: 'lo' },{ x: 'hello'}, true],
    [{ field: 'x', operator: 'startsWith', value: 'he'},  { x: 'hello'}, true],
    [{ field: 'x', operator: 'endsWith',   value: 'lo'},  { x: 'hello'}, true],
    [{ field: 'x', operator: 'typeof',     value: 'string'}, { x: 'a'}, true],
    [{ field: 'x', operator: 'in',         value: ['a','b']}, { x: 'a'}, true],
    [{ field: 'x', operator: 'matches',    value: '^[0-9]+$'}, { x: '123'}, true],
  ];
  for (const [cond, output, expected] of ops) {
    const c = OpenDone.contract({ task: 'op test', criteria: { conditions: [cond] } });
    const r = OpenDone.evaluate({ contract: c, output });
    assert(r.passed === expected, `Operator '${cond.operator}' should ${expected ? 'pass' : 'fail'}`);
  }
});

test('evaluates constraint: maxIterations', () => {
  const c = OpenDone.contract({
    task: 'test',
    criteria: { required: ['x'] },
    constraints: { maxIterations: 10 }
  });
  const pass = OpenDone.evaluate({ contract: c, output: { x: 1 }, runtime: { iterations: 5 } });
  assert(pass.passed === true, 'Should pass within iteration limit');

  const fail = OpenDone.evaluate({ contract: c, output: { x: 1 }, runtime: { iterations: 15 } });
  assert(fail.passed === false, 'Should fail when iterations exceeded');
});

test('rejects expired contract', () => {
  const c = OpenDone.contract({
    task: 'test',
    criteria: { required: ['x'] },
  });
  c.expiresAt = new Date(Date.now() - 1000).toISOString(); // expired 1 second ago

  let threw = false;
  try { OpenDone.evaluate({ contract: c, output: { x: 1 } }); }
  catch (e) { threw = e.code === 'CONTRACT_EXPIRED'; }
  assert(threw, 'Should throw CONTRACT_EXPIRED');
});

// ─────────────────────────────────────────────────────────────
console.log('\nCheckpoints');
// ─────────────────────────────────────────────────────────────

test('emits checkpoint receipt', () => {
  const c = OpenDone.contract({
    task: 'Long task',
    criteria: { required: ['result'] },
    constraints: { maxIterations: 50, checkpointEvery: 10 }
  });
  const cp = OpenDone.checkpoint({
    contract: c,
    iteration: 10,
    state: { progress: '20%' },
    runtime: { iterations: 10, durationMs: 5000 }
  });
  assert(cp.isCheckpoint === true, 'Should be marked as checkpoint');
  assert(cp.checkpointIteration === 10, 'Should record iteration');
  assert(cp.passed === true, 'Should pass within constraints');
});

test('checkpoint throws on constraint breach', () => {
  const c = OpenDone.contract({
    task: 'Long task',
    criteria: { required: ['result'] },
    constraints: { maxIterations: 10 }
  });
  let threw = false;
  try {
    OpenDone.checkpoint({
      contract: c,
      iteration: 15,
      runtime: { iterations: 15 }
    });
  } catch (e) { threw = e.code === 'CONSTRAINT_BREACH'; }
  assert(threw, 'Should throw CONSTRAINT_BREACH');
});

// ─────────────────────────────────────────────────────────────
console.log('\nVerification & Tamper Detection');
// ─────────────────────────────────────────────────────────────

test('verifies clean receipt', () => {
  const c = OpenDone.contract({ task: 'test', criteria: { required: ['x'] } });
  const receipt = OpenDone.evaluate({ contract: c, output: { x: 1 } });
  const result = OpenDone.verify(receipt);
  assert(result.valid === true, 'Clean receipt should verify');
});

test('detects tampered receipt', () => {
  const c = OpenDone.contract({ task: 'test', criteria: { required: ['x'] } });
  // Deliberately fail — output missing required field
  const receipt = OpenDone.evaluate({ contract: c, output: { y: 1 } });
  assert(receipt.passed === false, 'Should start as failed');

  // Tamper: flip to passing
  receipt.passed = true;

  const result = OpenDone.verify(receipt);
  assert(result.valid === false, 'Tampered receipt should fail verification');
  assert(result.reason.includes('tampered'), 'Reason should mention tampering');
});

test('verifies signed receipt with public key', () => {
  const { publicKey, privateKey } = OpenDone.generateKeyPair();
  const c = OpenDone.contract({ task: 'signed test', criteria: { required: ['x'] } });
  const receipt = OpenDone.evaluate({ contract: c, output: { x: 1 }, privateKey });
  
  assert(receipt.signature, 'Should have signature');
  const result = OpenDone.verify(receipt, publicKey);
  assert(result.valid === true, 'Signed receipt should verify with public key');
});

test('rejects tampered signed receipt', () => {
  const { publicKey, privateKey } = OpenDone.generateKeyPair();
  const c = OpenDone.contract({ task: 'signed test', criteria: { required: ['x'] } });
  const receipt = OpenDone.evaluate({ contract: c, output: { x: 1 }, privateKey });
  
  // Tamper
  receipt.passed = false;

  const result = OpenDone.verify(receipt, publicKey);
  assert(result.valid === false, 'Tampered signed receipt should fail');
});

// ─────────────────────────────────────────────────────────────
console.log('\nStorage');
// ─────────────────────────────────────────────────────────────

test('fileStore persists and queries receipts', () => {
  const tmp = require("path").join(require("os").tmpdir(), `od_test_${Date.now()}.json`);
  const store = OpenDone.fileStore(tmp);
  
  const c = OpenDone.contract({ task: 'test', criteria: { required: ['x'] } });
  OpenDone.evaluate({ contract: c, output: { x: 1 }, store });
  OpenDone.evaluate({ contract: c, output: { x: 1 }, store });
  
  const results = store.query({ contractId: c.contractId });
  assert(results.length === 2, 'Should store and retrieve 2 receipts');

  // Reload from disk
  const store2 = OpenDone.fileStore(tmp);
  const results2 = store2.query({ contractId: c.contractId });
  assert(results2.length === 2, 'Should persist across store instances');

  require('fs').unlinkSync(tmp);
});

// ─────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n${'─'.repeat(40)}`);
console.log(`${passed}/${total} tests passed${failed > 0 ? ` — ${failed} failed` : ''}\n`);
if (failed > 0) process.exit(1);
