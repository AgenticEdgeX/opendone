/**
 * OpenDone Example: Code Generation Task
 * 
 * Shows how to use OpenDone to verify an agent's code generation output
 * meets your defined criteria before accepting it.
 */

'use strict';

const OpenDone = require('../opendone');

// ─── 1. Define what "done" means ─────────────────────────────

const contract = OpenDone.contract({
  task: 'Generate a Node.js function that validates an email address',
  criteria: {
    required: ['code', 'language', 'functionName'],
    conditions: [
      { field: 'language',     operator: '===',      value: 'javascript' },
      { field: 'functionName', operator: 'startsWith', value: 'validate' },
      { field: 'code',         operator: 'includes',  value: 'function' },
      { field: 'code',         operator: 'includes',  value: 'return' },
      { field: 'hasTests',     operator: '===',       value: true },
      { field: 'lineCount',    operator: '<=',        value: 50 }
    ]
  },
  constraints: {
    maxIterations: 5,
    maxDurationMs: 15000,
    maxCostUsd: 0.05
  }
});

console.log('Contract created:', contract.contractId);
console.log('Task:', contract.task);

// ─── 2. Simulate agent output (replace with your real agent) ──

// This simulates what your agent returns
const agentOutput = {
  language: 'javascript',
  functionName: 'validateEmail',
  code: `function validateEmail(email) {
  const regex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  return regex.test(email);
}`,
  hasTests: true,
  lineCount: 4,
  testCoverage: 92
};

// ─── 3. Evaluate ──────────────────────────────────────────────

const receipt = OpenDone.evaluate({
  contract,
  output: agentOutput,
  agent: 'code-gen-agent-v1',
  runtime: {
    iterations: 2,
    durationMs: 3200,
    costUsd: 0.012
  }
});

// ─── 4. Results ───────────────────────────────────────────────

console.log('\n' + '─'.repeat(50));
console.log(`Result: ${receipt.passed ? '✓ PASSED' : '✗ FAILED'}`);
console.log('─'.repeat(50));

receipt.criteriaResults.forEach(r => {
  console.log(`  ${r.passed ? '✓' : '✗'} ${r.reason}`);
});

if (receipt.constraintResults.length > 0) {
  console.log('\nConstraints:');
  receipt.constraintResults.forEach(r => {
    console.log(`  ${r.passed ? '✓' : '✗'} ${r.reason}`);
  });
}

// ─── 5. Verify integrity ──────────────────────────────────────

const verification = OpenDone.verify(receipt);
console.log(`\nIntegrity: ${verification.valid ? '✓' : '✗'} ${verification.reason}`);

// ─── 6. What a failed case looks like ────────────────────────

console.log('\n' + '─'.repeat(50));
console.log('Failed case:');
console.log('─'.repeat(50));

const badOutput = {
  language: 'python',     // wrong language
  functionName: 'check',  // doesn't start with 'validate'
  code: 'pass',           // missing 'function' and 'return'
  hasTests: false,
  lineCount: 1
};

const failedReceipt = OpenDone.evaluate({
  contract,
  output: badOutput,
  agent: 'code-gen-agent-v1',
  runtime: { iterations: 1, durationMs: 800, costUsd: 0.003 }
});

console.log(`Result: ${failedReceipt.passed ? '✓ PASSED' : '✗ FAILED'}`);
failedReceipt.criteriaResults
  .filter(r => !r.passed)
  .forEach(r => console.log(`  ✗ ${r.reason}`));
