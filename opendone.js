#!/usr/bin/env node

/**
 * OpenDone v0.3.0
 * A portable, machine-verifiable standard for AI agent task completion.
 * 
 * Core concepts:
 *   Contract  — defines what "done" means before the agent starts
 *   Receipt   — signed, tamper-evident proof of what happened
 *   Verify    — deterministic evaluation, same input = same verdict
 * 
 * MIT License. https://github.com/agenticedge/opendone
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');

// ─────────────────────────────────────────────────────────────
// ERRORS
// ─────────────────────────────────────────────────────────────

class OpenDoneError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'OpenDoneError';
    this.code = code;
    this.detail = detail;
  }
}

const Errors = {
  INVALID_CONTRACT:   'INVALID_CONTRACT',
  CONSTRAINT_BREACH:  'CONSTRAINT_BREACH',
  CONTRACT_EXPIRED:   'CONTRACT_EXPIRED',
  TAMPER_DETECTED:    'TAMPER_DETECTED',
  SIGNATURE_INVALID:  'SIGNATURE_INVALID',
  EVALUATION_ERROR:   'EVALUATION_ERROR',
  STORE_ERROR:        'STORE_ERROR',
};

// ─────────────────────────────────────────────────────────────
// CONTRACT
// ─────────────────────────────────────────────────────────────

/**
 * Create a machine-verifiable completion contract.
 * 
 * @param {object} options
 * @param {string} options.task          - Human-readable description of the task
 * @param {object} options.criteria      - Completion criteria (required fields + conditions)
 * @param {object} [options.constraints] - Runtime boundaries (iterations, cost, time, checkpoints)
 * @param {string} [options.agent]       - Expected agent identifier
 * @param {number} [options.expiresIn]   - Seconds until contract expires
 * @param {string} [options.version]     - Schema version (default: '0.3.0')
 * 
 * @returns {object} contract
 * 
 * @example
 * const contract = OpenDone.contract({
 *   task: 'Process invoice batch and return confirmation',
 *   criteria: {
 *     required: ['invoiceIds', 'totalProcessed', 'status'],
 *     conditions: [
 *       { field: 'status',          operator: '===', value: 'complete' },
 *       { field: 'totalProcessed',  operator: '>',   value: 0 },
 *       { field: 'errors',          operator: '===', value: 0 }
 *     ]
 *   },
 *   constraints: {
 *     maxIterations: 50,
 *     maxDurationMs: 30000,
 *     maxCostUsd: 0.10,
 *     checkpointEvery: 10
 *   }
 * });
 */
function contract(options = {}) {
  const { task, criteria, constraints, agent, expiresIn, version = '0.3.0' } = options;

  if (!task || typeof task !== 'string') {
    throw new OpenDoneError(Errors.INVALID_CONTRACT, 'Contract requires a task description string');
  }
  if (!criteria || typeof criteria !== 'object') {
    throw new OpenDoneError(Errors.INVALID_CONTRACT, 'Contract requires a criteria object');
  }
  if (!criteria.required && !criteria.conditions) {
    throw new OpenDoneError(Errors.INVALID_CONTRACT, 'Criteria must have at least one required field or condition');
  }

  const now = Date.now();
  const contractId = generateId('od_c');

  const c = {
    contractId,
    version,
    task,
    agent: agent || null,
    criteria: normalizeCriteria(criteria),
    constraints: normalizeConstraints(constraints),
    createdAt: new Date(now).toISOString(),
    expiresAt: expiresIn ? new Date(now + expiresIn * 1000).toISOString() : null,
    signature: null,  // populated by sign(contract, privateKey)
  };

  c.hash = canonicalHash(omit(c, ['hash', 'signature']));
  return c;
}

function normalizeCriteria(criteria) {
  const valid = {
    required: [],
    conditions: [],
  };

  if (Array.isArray(criteria.required)) {
    for (const field of criteria.required) {
      if (typeof field !== 'string') {
        throw new OpenDoneError(Errors.INVALID_CONTRACT, `Required field must be a string, got: ${typeof field}`);
      }
      valid.required.push(field);
    }
  }

  if (Array.isArray(criteria.conditions)) {
    const validOperators = ['>', '<', '>=', '<=', '===', '!==', 'includes', 'startsWith', 'endsWith', 'matches', 'typeof', 'in'];
    for (const cond of criteria.conditions) {
      if (!cond.field || !cond.operator) {
        throw new OpenDoneError(Errors.INVALID_CONTRACT, `Condition missing field or operator: ${JSON.stringify(cond)}`);
      }
      if (!validOperators.includes(cond.operator)) {
        throw new OpenDoneError(Errors.INVALID_CONTRACT, `Unknown operator: ${cond.operator}. Valid: ${validOperators.join(', ')}`);
      }
      valid.conditions.push({ field: cond.field, operator: cond.operator, value: cond.value });
    }
  }

  return valid;
}

function normalizeConstraints(constraints) {
  if (!constraints) return null;
  return {
    maxIterations:  constraints.maxIterations  || null,
    maxDurationMs:  constraints.maxDurationMs  || null,
    maxCostUsd:     constraints.maxCostUsd     || null,
    checkpointEvery: constraints.checkpointEvery || null,
  };
}

// ─────────────────────────────────────────────────────────────
// EVALUATE
// ─────────────────────────────────────────────────────────────

/**
 * Evaluate an agent's output against a contract.
 * Deterministic: same contract + same output = same verdict, every time.
 * 
 * @param {object} options
 * @param {object} options.contract      - Contract from OpenDone.contract()
 * @param {object} options.output        - Agent output to evaluate
 * @param {string} [options.agent]       - Agent identifier
 * @param {object} [options.runtime]     - Actual runtime stats { iterations, durationMs, costUsd }
 * @param {object} [options.store]       - Storage adapter (default: in-memory)
 * @param {string} [options.privateKey]  - PEM private key for signing the receipt
 * 
 * @returns {object} receipt
 */
function evaluate(options = {}) {
  const { contract: c, output, agent, runtime = {}, store = defaultStore, privateKey } = options;

  if (!c || !c.contractId) {
    throw new OpenDoneError(Errors.INVALID_CONTRACT, 'evaluate() requires a valid contract');
  }

  // Check expiry
  if (c.expiresAt && new Date() > new Date(c.expiresAt)) {
    throw new OpenDoneError(Errors.CONTRACT_EXPIRED, `Contract expired at ${c.expiresAt}`);
  }

  // Evaluate criteria
  const criteriaResults = evaluateCriteria(c.criteria, output);

  // Evaluate constraints
  const constraintResults = evaluateConstraints(c.constraints, runtime);

  const passed = criteriaResults.every(r => r.passed) && constraintResults.every(r => r.passed);

  const receipt = buildReceipt({
    contractId: c.contractId,
    contractHash: c.hash,
    task: c.task,
    agent: agent || c.agent || 'unknown',
    output: sanitize(output),
    passed,
    criteriaResults,
    constraintResults,
    runtime,
    isCheckpoint: false,
  });

  if (privateKey) {
    receipt.signature = sign(receipt.hash, privateKey);
  }

  store.save(receipt);
  return receipt;
}

// ─────────────────────────────────────────────────────────────
// CHECKPOINT
// ─────────────────────────────────────────────────────────────

/**
 * Emit a checkpoint receipt mid-execution.
 * Records current state + runtime stats against contract constraints.
 * Does NOT evaluate completion criteria (task isn't done yet).
 * 
 * @param {object} options
 * @param {object} options.contract      - Contract from OpenDone.contract()
 * @param {number} options.iteration     - Current iteration number
 * @param {object} [options.state]       - Current agent state snapshot
 * @param {object} [options.runtime]     - Current runtime stats { iterations, durationMs, costUsd }
 * @param {string} [options.agent]       - Agent identifier
 * @param {object} [options.store]       - Storage adapter
 * @param {string} [options.privateKey]  - PEM private key for signing
 * 
 * @returns {object} checkpoint receipt
 */
function checkpoint(options = {}) {
  const { contract: c, iteration, state = {}, runtime = {}, agent, store = defaultStore, privateKey } = options;

  if (!c || !c.contractId) {
    throw new OpenDoneError(Errors.INVALID_CONTRACT, 'checkpoint() requires a valid contract');
  }

  const constraintResults = evaluateConstraints(c.constraints, runtime);
  const constraintsPassed = constraintResults.every(r => r.passed);

  const receipt = buildReceipt({
    contractId: c.contractId,
    contractHash: c.hash,
    task: c.task,
    agent: agent || c.agent || 'unknown',
    output: sanitize(state),
    passed: constraintsPassed,
    criteriaResults: [],  // not evaluated at checkpoint
    constraintResults,
    runtime,
    isCheckpoint: true,
    checkpointIteration: iteration,
  });

  if (privateKey) {
    receipt.signature = sign(receipt.hash, privateKey);
  }

  store.save(receipt);

  // Signal if constraints breached — caller can abort
  if (!constraintsPassed) {
    const breached = constraintResults.filter(r => !r.passed).map(r => r.constraint);
    throw new OpenDoneError(
      Errors.CONSTRAINT_BREACH,
      `Constraint breach at iteration ${iteration}: ${breached.join(', ')}`,
      { constraintResults, iteration }
    );
  }

  return receipt;
}

// ─────────────────────────────────────────────────────────────
// VERIFY
// ─────────────────────────────────────────────────────────────

/**
 * Verify a receipt hasn't been tampered with.
 * Optionally verify the signature against a public key.
 * 
 * @param {object} receipt       - Receipt from evaluate() or checkpoint()
 * @param {string} [publicKey]   - PEM public key for signature verification
 * @returns {{ valid: boolean, reason: string }}
 */
function verify(receipt, publicKey = null) {
  const { hash, signature, ...payload } = receipt;

  const expectedHash = canonicalHash(payload);
  if (hash !== expectedHash) {
    return { valid: false, reason: 'Hash mismatch — receipt may have been tampered with' };
  }

  if (publicKey) {
    if (!signature) {
      return { valid: false, reason: 'No signature present — cannot verify origin' };
    }
    const sigValid = verifySignature(hash, signature, publicKey);
    if (!sigValid) {
      return { valid: false, reason: 'Signature invalid — receipt origin cannot be confirmed' };
    }
  }

  return { valid: true, reason: 'Receipt integrity confirmed' };
}

// ─────────────────────────────────────────────────────────────
// SIGN CONTRACT OR RECEIPT
// ─────────────────────────────────────────────────────────────

/**
 * Sign a contract or receipt with a private key.
 * Returns the same object with signature populated.
 */
function signDocument(doc, privateKey) {
  if (!doc.hash) {
    throw new OpenDoneError('MISSING_HASH', 'Document must have a hash before signing');
  }
  return { ...doc, signature: sign(doc.hash, privateKey) };
}

// ─────────────────────────────────────────────────────────────
// KEY GENERATION
// ─────────────────────────────────────────────────────────────

/**
 * Generate an RSA keypair for signing contracts and receipts.
 * @returns {{ publicKey: string, privateKey: string }}
 */
function generateKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

// ─────────────────────────────────────────────────────────────
// INTERNAL: CRITERIA EVALUATION
// ─────────────────────────────────────────────────────────────

function evaluateCriteria(criteria, output) {
  const results = [];

  if (!output || typeof output !== 'object') {
    return [{ constraint: 'output_type', passed: false, reason: 'Output must be an object' }];
  }

  // Required fields
  for (const field of (criteria.required || [])) {
    const val = getNestedValue(output, field);
    const passed = val !== undefined && val !== null;
    results.push({
      type: 'required',
      field,
      passed,
      reason: passed ? `Field '${field}' present` : `Required field '${field}' is missing or null`,
    });
  }

  // Conditions
  for (const cond of (criteria.conditions || [])) {
    const val = getNestedValue(output, cond.field);
    let passed = false;
    let reason = '';

    try {
      switch (cond.operator) {
        case '>':          passed = val > cond.value;                          break;
        case '<':          passed = val < cond.value;                          break;
        case '>=':         passed = val >= cond.value;                         break;
        case '<=':         passed = val <= cond.value;                         break;
        case '===':        passed = val === cond.value;                        break;
        case '!==':        passed = val !== cond.value;                        break;
        case 'includes':   passed = String(val).includes(String(cond.value));  break;
        case 'startsWith': passed = String(val).startsWith(String(cond.value));break;
        case 'endsWith':   passed = String(val).endsWith(String(cond.value));  break;
        case 'matches':    passed = new RegExp(cond.value).test(String(val));  break;
        case 'typeof':     passed = typeof val === cond.value;                 break;
        case 'in':         passed = Array.isArray(cond.value) && cond.value.includes(val); break;
        default:
          passed = false;
          reason = `Unknown operator: ${cond.operator}`;
      }
      if (!reason) {
        reason = passed
          ? `${cond.field} ${cond.operator} ${JSON.stringify(cond.value)} ✓ (got ${JSON.stringify(val)})`
          : `${cond.field} ${cond.operator} ${JSON.stringify(cond.value)} ✗ (got ${JSON.stringify(val)})`;
      }
    } catch (e) {
      passed = false;
      reason = `Evaluation error: ${e.message}`;
    }

    results.push({ type: 'condition', field: cond.field, operator: cond.operator, passed, reason });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// INTERNAL: CONSTRAINT EVALUATION
// ─────────────────────────────────────────────────────────────

function evaluateConstraints(constraints, runtime) {
  if (!constraints) return [];

  const results = [];

  if (constraints.maxIterations !== null && runtime.iterations !== undefined) {
    const passed = runtime.iterations <= constraints.maxIterations;
    results.push({
      type: 'constraint',
      constraint: 'maxIterations',
      passed,
      limit: constraints.maxIterations,
      actual: runtime.iterations,
      reason: passed
        ? `Iterations ${runtime.iterations} ≤ limit ${constraints.maxIterations}`
        : `Iterations ${runtime.iterations} exceeded limit ${constraints.maxIterations}`,
    });
  }

  if (constraints.maxDurationMs !== null && runtime.durationMs !== undefined) {
    const passed = runtime.durationMs <= constraints.maxDurationMs;
    results.push({
      type: 'constraint',
      constraint: 'maxDurationMs',
      passed,
      limit: constraints.maxDurationMs,
      actual: runtime.durationMs,
      reason: passed
        ? `Duration ${runtime.durationMs}ms ≤ limit ${constraints.maxDurationMs}ms`
        : `Duration ${runtime.durationMs}ms exceeded limit ${constraints.maxDurationMs}ms`,
    });
  }

  if (constraints.maxCostUsd !== null && runtime.costUsd !== undefined) {
    const passed = runtime.costUsd <= constraints.maxCostUsd;
    results.push({
      type: 'constraint',
      constraint: 'maxCostUsd',
      passed,
      limit: constraints.maxCostUsd,
      actual: runtime.costUsd,
      reason: passed
        ? `Cost $${runtime.costUsd} ≤ limit $${constraints.maxCostUsd}`
        : `Cost $${runtime.costUsd} exceeded limit $${constraints.maxCostUsd}`,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// INTERNAL: RECEIPT BUILDER
// ─────────────────────────────────────────────────────────────

function buildReceipt(fields) {
  const receiptId = generateId('od_r');
  const issuedAt = new Date().toISOString();

  const payload = {
    receiptId,
    version: '0.3.0',
    isCheckpoint: fields.isCheckpoint,
    checkpointIteration: fields.checkpointIteration || null,
    contractId: fields.contractId,
    contractHash: fields.contractHash,
    task: fields.task,
    agent: fields.agent,
    issuedAt,
    passed: fields.passed,
    criteriaResults: fields.criteriaResults,
    constraintResults: fields.constraintResults,
    runtime: fields.runtime,
    output: fields.output,
    signature: null,  // field present but empty until signed
  };

  payload.hash = canonicalHash(omit(payload, ['hash', 'signature']));
  return payload;
}

// ─────────────────────────────────────────────────────────────
// STORAGE ADAPTERS
// ─────────────────────────────────────────────────────────────

const defaultStore = (() => {
  const records = [];
  return {
    save(receipt) { records.push(receipt); return receipt; },
    query({ contractId, agent, passed } = {}) {
      return records.filter(r => {
        if (contractId && r.contractId !== contractId) return false;
        if (agent     && r.agent     !== agent)      return false;
        if (passed    !== undefined && r.passed !== passed) return false;
        return true;
      });
    },
    all() { return [...records]; },
  };
})();

/**
 * File-based persistent store with atomic writes.
 * @param {string} filepath - Path to JSON file
 */
function fileStore(filepath) {
  let records = [];
  if (fs.existsSync(filepath)) {
    try {
      records = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } catch {
      records = [];
    }
  }

  function persist() {
    const tmp = filepath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
    fs.renameSync(tmp, filepath);  // atomic on POSIX
  }

  return {
    save(receipt) {
      records.push(receipt);
      try { persist(); } catch (e) {
        throw new OpenDoneError(Errors.STORE_ERROR, `Failed to write store: ${e.message}`);
      }
      return receipt;
    },
    query({ contractId, agent, passed } = {}) {
      return records.filter(r => {
        if (contractId && r.contractId !== contractId) return false;
        if (agent     && r.agent     !== agent)      return false;
        if (passed    !== undefined && r.passed !== passed) return false;
        return true;
      });
    },
    all() { return [...records]; },
  };
}

// ─────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────

function generateId(prefix = 'od') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

// Canonical hash: sorted keys, deterministic across runtimes
function canonicalHash(obj) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(sortKeys(obj)))
    .digest('hex');
}

function sortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => {
      acc[k] = sortKeys(obj[k]);
      return acc;
    }, {});
  }
  return obj;
}

// Get nested value by dot-notation: 'config.auth.token'
function getNestedValue(obj, field) {
  return field.split('.').reduce((acc, key) => {
    if (acc && typeof acc === 'object') return acc[key];
    return undefined;
  }, obj);
}

function sanitize(data) {
  if (!data) return data;
  try { return JSON.parse(JSON.stringify(data)); }
  catch { return String(data); }
}

function omit(obj, keys) {
  const result = { ...obj };
  for (const k of keys) delete result[k];
  return result;
}

function sign(hash, privateKey) {
  try {
    const s = crypto.createSign('SHA256');
    s.update(hash);
    return s.sign(privateKey, 'hex');
  } catch { return null; }
}

function verifySignature(hash, signature, publicKey) {
  try {
    const v = crypto.createVerify('SHA256');
    v.update(hash);
    return v.verify(publicKey, signature, 'hex');
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

function runCLI() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === 'help') {
    console.log(`
OpenDone v0.3.0 — machine-verifiable AI agent task completion

COMMANDS:
  evaluate  <contract.json> <output.json>   Evaluate output against contract
  verify    <receipt.json>                  Verify a receipt's integrity
  inspect   <receipt.json>                  Human-readable receipt summary
  keygen                                    Generate RSA keypair for signing
  help                                      Show this message

EXAMPLES:
  npx opendone evaluate contract.json output.json
  npx opendone verify receipt.json
  npx opendone inspect receipt.json
    `);
    return;
  }

  if (cmd === 'keygen') {
    const { publicKey, privateKey } = generateKeyPair();
    fs.writeFileSync('public.pem', publicKey);
    fs.writeFileSync('private.pem', privateKey);
    console.log('✓ Generated public.pem and private.pem');
    return;
  }

  if (cmd === 'evaluate') {
    const contractPath = args[1];
    const outputPath = args[2];
    if (!contractPath || !outputPath) {
      console.error('Usage: opendone evaluate <contract.json> <output.json>');
      process.exit(1);
    }
    const c = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const receipt = evaluate({ contract: c, output });
    const outPath = `receipt_${Date.now()}.json`;
    fs.writeFileSync(outPath, JSON.stringify(receipt, null, 2));
    console.log(receipt.passed ? '✓ PASSED' : '✗ FAILED');
    receipt.criteriaResults.forEach(r => console.log(`  ${r.passed ? '✓' : '✗'} ${r.reason}`));
    receipt.constraintResults.forEach(r => console.log(`  ${r.passed ? '✓' : '✗'} ${r.reason}`));
    console.log(`\nReceipt saved: ${outPath}`);
    return;
  }

  if (cmd === 'verify') {
    const receiptPath = args[1];
    if (!receiptPath) { console.error('Usage: opendone verify <receipt.json>'); process.exit(1); }
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const result = verify(receipt);
    console.log(result.valid ? `✓ ${result.reason}` : `✗ ${result.reason}`);
    return;
  }

  if (cmd === 'inspect') {
    const receiptPath = args[1];
    if (!receiptPath) { console.error('Usage: opendone inspect <receipt.json>'); process.exit(1); }
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    console.log(`\nOpenDone Receipt`);
    console.log(`─────────────────────────────`);
    console.log(`ID:         ${receipt.receiptId}`);
    console.log(`Type:       ${receipt.isCheckpoint ? `Checkpoint (iteration ${receipt.checkpointIteration})` : 'Final'}`);
    console.log(`Task:       ${receipt.task}`);
    console.log(`Agent:      ${receipt.agent}`);
    console.log(`Issued:     ${receipt.issuedAt}`);
    console.log(`Result:     ${receipt.passed ? '✓ PASSED' : '✗ FAILED'}`);
    console.log(`Signed:     ${receipt.signature ? 'Yes' : 'No'}`);
    console.log(`\nCriteria:`);
    (receipt.criteriaResults || []).forEach(r => console.log(`  ${r.passed ? '✓' : '✗'} ${r.reason}`));
    console.log(`\nConstraints:`);
    (receipt.constraintResults || []).forEach(r => console.log(`  ${r.passed ? '✓' : '✗'} ${r.reason}`));
    console.log(`\nHash: ${receipt.hash}`);
    return;
  }

  console.error(`Unknown command: ${cmd}. Run 'opendone help' for usage.`);
  process.exit(1);
}

if (require.main === module) runCLI();

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
  contract,
  evaluate,
  checkpoint,
  verify,
  sign: signDocument,
  generateKeyPair,
  fileStore,
  defaultStore,
  OpenDoneError,
  Errors,
};
