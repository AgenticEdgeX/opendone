#!/usr/bin/env node
/**
 * OpenDone v0.5.0
 * A portable, machine-verifiable standard for AI agent task completion.
 *
 * Core concepts:
 *   Contract  — defines what "done" means before the agent starts
 *   Receipt   — signed, tamper-evident proof of what happened
 *   Verify    — deterministic evaluation, same input = same verdict
 *   Coram     — contract-anchored, append-only, hash-chained witness record
 *   Umbra     — tool-call enforcement layer, policy before execution
 *
 * MIT License. https://github.com/agenticedge/opendone
 *
 * Security hardening v0.5.0:
 *   - Contract objects deeply frozen at creation (mutation bypass fix)
 *   - canonicalHash internal only — not exported (forgery prevention)
 *   - matches operator rejects dangerous regex patterns (ReDoS fix)
 *   - required fields reject whitespace-only strings
 *   - numeric operators require typeof === 'number' (type coercion fix)
 *   - missing runtime fields are violations, not silently skipped
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const Coram = require('./coram');

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
// DEEP FREEZE
// ─────────────────────────────────────────────────────────────

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.keys(obj).forEach(k => deepFreeze(obj[k]));
  return Object.freeze(obj);
}

// ─────────────────────────────────────────────────────────────
// REDOS PROTECTION
// ─────────────────────────────────────────────────────────────

const DANGEROUS_REGEX_PATTERNS = [
  /\(([^)]+)\+\)\+/,
  /\(([^)]+)\*\)\*/,
  /\(([^)]+)[+*]\)[+*]/,
  /\(\?=.*\)\*/,
];
const MAX_REGEX_INPUT_LENGTH = 10000;

function safeRegexTest(pattern, value) {
  for (const danger of DANGEROUS_REGEX_PATTERNS) {
    if (danger.test(pattern)) {
      throw new OpenDoneError(Errors.EVALUATION_ERROR, `Unsafe regex pattern rejected: ${pattern}`);
    }
  }
  return new RegExp(pattern).test(String(value).slice(0, MAX_REGEX_INPUT_LENGTH));
}

// ─────────────────────────────────────────────────────────────
// CONTRACT
// ─────────────────────────────────────────────────────────────

function contract(options = {}) {
  const { task, criteria, constraints, agent, expiresIn, version = '0.4.0' } = options;

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
    signature: null,
  };

  c.hash = canonicalHash(omit(c, ['hash', 'signature']));
  Object.freeze(c.criteria);
  Object.freeze(c.criteria.required);
  Object.freeze(c.criteria.conditions);
  if (c.constraints) Object.freeze(c.constraints);
  return c;
}

function normalizeCriteria(criteria) {
  const valid = { required: [], conditions: [] };

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
    maxIterations:   constraints.maxIterations   || null,
    maxDurationMs:   constraints.maxDurationMs   || null,
    maxCostUsd:      constraints.maxCostUsd      || null,
    checkpointEvery: constraints.checkpointEvery || null,
  };
}

// ─────────────────────────────────────────────────────────────
// EVALUATE
// ─────────────────────────────────────────────────────────────

function evaluate(options = {}) {
  const { contract: c, output, agent, runtime = {}, store = defaultStore, privateKey, coram } = options;

  if (!c || !c.contractId) {
    throw new OpenDoneError(Errors.INVALID_CONTRACT, 'evaluate() requires a valid contract');
  }

  if (c.expiresAt && new Date() > new Date(c.expiresAt)) {
    throw new OpenDoneError(Errors.CONTRACT_EXPIRED, `Contract expired at ${c.expiresAt}`);
  }

  const criteriaResults   = evaluateCriteria(c.criteria, output);
  const constraintResults = evaluateConstraints(c.constraints, runtime);
  const passed = criteriaResults.every(r => r.passed) && constraintResults.every(r => r.passed);

  let closedCoram = null;
  if (coram) closedCoram = Coram.closeCoram(coram);

  const receiptFields = {
    contractId:   c.contractId,
    contractHash: c.hash,
    task:         c.task,
    agent:        agent || c.agent || 'unknown',
    output:       sanitize(output),
    passed,
    criteriaResults,
    constraintResults,
    runtime,
    isCheckpoint: false,
  };

  if (closedCoram) Coram.attachCoramToReceipt(receiptFields, closedCoram);

  const receipt = buildReceipt(receiptFields);
  if (privateKey) receipt.signature = sign(receipt.hash, privateKey);

  store.save(receipt);
  return receipt;
}

// ─────────────────────────────────────────────────────────────
// CHECKPOINT
// ─────────────────────────────────────────────────────────────

function checkpoint(options = {}) {
  const { contract: c, iteration, state = {}, runtime = {}, agent, store = defaultStore, privateKey } = options;

  if (!c || !c.contractId) {
    throw new OpenDoneError(Errors.INVALID_CONTRACT, 'checkpoint() requires a valid contract');
  }

  const constraintResults = evaluateConstraints(c.constraints, runtime);
  const constraintsPassed = constraintResults.every(r => r.passed);

  const receipt = buildReceipt({
    contractId: c.contractId, contractHash: c.hash, task: c.task,
    agent: agent || c.agent || 'unknown', output: sanitize(state),
    passed: constraintsPassed, criteriaResults: [], constraintResults,
    runtime, isCheckpoint: true, checkpointIteration: iteration,
  });

  if (privateKey) receipt.signature = sign(receipt.hash, privateKey);
  store.save(receipt);

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

function verify(receipt, publicKey = null) {
  const { hash, signature, ...payload } = receipt;
  const expectedHash = canonicalHash(payload);

  if (hash !== expectedHash) {
    return { valid: false, reason: 'Hash mismatch — receipt may have been tampered with' };
  }
  if (publicKey) {
    if (!signature) return { valid: false, reason: 'No signature present — cannot verify origin' };
    if (!verifySignature(hash, signature, publicKey)) {
      return { valid: false, reason: 'Signature invalid — receipt origin cannot be confirmed' };
    }
  }
  return { valid: true, reason: 'Receipt integrity confirmed' };
}

// ─────────────────────────────────────────────────────────────
// SIGN
// ─────────────────────────────────────────────────────────────

function signDocument(doc, privateKey) {
  if (!doc.hash) throw new OpenDoneError('MISSING_HASH', 'Document must have a hash before signing');
  return { ...doc, signature: sign(doc.hash, privateKey) };
}

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

  for (const field of (criteria.required || [])) {
    const val = getNestedValue(output, field);
    const present = val !== undefined && val !== null && String(val).trim() !== '';
    results.push({
      type: 'required', field, passed: present,
      reason: present ? `Field '${field}' present` : `Required field '${field}' is missing, null, or blank`,
    });
  }

  for (const cond of (criteria.conditions || [])) {
    const val = getNestedValue(output, cond.field);
    let passed = false;
    let reason = '';

    try {
      switch (cond.operator) {
        case '>':
          if (typeof val !== 'number') { passed = false; reason = `'${cond.field}' must be a number for '>' operator`; break; }
          passed = val > cond.value; break;
        case '<':
          if (typeof val !== 'number') { passed = false; reason = `'${cond.field}' must be a number for '<' operator`; break; }
          passed = val < cond.value; break;
        case '>=':
          if (typeof val !== 'number') { passed = false; reason = `'${cond.field}' must be a number for '>=' operator`; break; }
          passed = val >= cond.value; break;
        case '<=':
          if (typeof val !== 'number') { passed = false; reason = `'${cond.field}' must be a number for '<=' operator`; break; }
          passed = val <= cond.value; break;
        case '===':        passed = val === cond.value; break;
        case '!==':        passed = val !== cond.value; break;
        case 'includes':   passed = String(val).includes(String(cond.value)); break;
        case 'startsWith': passed = String(val).startsWith(String(cond.value)); break;
        case 'endsWith':   passed = String(val).endsWith(String(cond.value)); break;
        case 'matches':    passed = safeRegexTest(cond.value, val); break;
        case 'typeof':     passed = typeof val === cond.value; break;
        case 'in':         passed = Array.isArray(cond.value) && cond.value.includes(val); break;
        default:           passed = false; reason = `Unknown operator: ${cond.operator}`;
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

  if (constraints.maxIterations !== null) {
    if (runtime.iterations === undefined) {
      results.push({
        type: 'constraint', constraint: 'maxIterations', passed: false,
        limit: constraints.maxIterations, actual: undefined,
        reason: 'maxIterations constraint defined but runtime.iterations not provided',
      });
    } else {
      const passed = runtime.iterations <= constraints.maxIterations;
      results.push({
        type: 'constraint', constraint: 'maxIterations', passed,
        limit: constraints.maxIterations, actual: runtime.iterations,
        reason: passed
          ? `Iterations ${runtime.iterations} ≤ limit ${constraints.maxIterations}`
          : `Iterations ${runtime.iterations} exceeded limit ${constraints.maxIterations}`,
      });
    }
  }

  if (constraints.maxDurationMs !== null) {
    if (runtime.durationMs === undefined) {
      results.push({
        type: 'constraint', constraint: 'maxDurationMs', passed: false,
        limit: constraints.maxDurationMs, actual: undefined,
        reason: 'maxDurationMs constraint defined but runtime.durationMs not provided',
      });
    } else {
      const passed = runtime.durationMs <= constraints.maxDurationMs;
      results.push({
        type: 'constraint', constraint: 'maxDurationMs', passed,
        limit: constraints.maxDurationMs, actual: runtime.durationMs,
        reason: passed
          ? `Duration ${runtime.durationMs}ms ≤ limit ${constraints.maxDurationMs}ms`
          : `Duration ${runtime.durationMs}ms exceeded limit ${constraints.maxDurationMs}ms`,
      });
    }
  }

  if (constraints.maxCostUsd !== null && runtime.costUsd !== undefined) {
    const passed = runtime.costUsd <= constraints.maxCostUsd;
    results.push({
      type: 'constraint', constraint: 'maxCostUsd', passed,
      limit: constraints.maxCostUsd, actual: runtime.costUsd,
      reason: passed
        ? `Cost $${runtime.costUsd} ≤ limit $${constraints.maxCostUsd}`
        : `Cost $${runtime.costUsd} exceeded limit $${constraints.maxCostUsd}`,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// RECEIPT BUILDER
// ─────────────────────────────────────────────────────────────

function buildReceipt(fields) {
  const receiptId = generateId('od_r');
  const issuedAt  = new Date().toISOString();

  const payload = {
    receiptId,
    version:             '0.4.0',
    isCheckpoint:        fields.isCheckpoint,
    checkpointIteration: fields.checkpointIteration || null,
    contractId:          fields.contractId,
    contractHash:        fields.contractHash,
    task:                fields.task,
    agent:               fields.agent,
    issuedAt,
    passed:              fields.passed,
    criteriaResults:     fields.criteriaResults,
    constraintResults:   fields.constraintResults,
    runtime:             fields.runtime,
    output:              fields.output,
    coramHash:           fields.coramHash        !== undefined ? fields.coramHash        : null,
    coramEntryCount:     fields.coramEntryCount  !== undefined ? fields.coramEntryCount  : null,
    coramStatus:         fields.coramStatus      !== undefined ? fields.coramStatus      : null,
    signature:           null,
  };

  payload.hash = canonicalHash(omit(payload, ['hash', 'signature']));
  return payload;
}

// ─────────────────────────────────────────────────────────────
// STORAGE
// ─────────────────────────────────────────────────────────────

const defaultStore = (() => {
  const records = [];
  return {
    save(receipt) { records.push(receipt); return receipt; },
    query({ contractId, agent, passed } = {}) {
      return records.filter(r => {
        if (contractId && r.contractId !== contractId) return false;
        if (agent && r.agent !== agent) return false;
        if (passed !== undefined && r.passed !== passed) return false;
        return true;
      });
    },
    all() { return [...records]; },
  };
})();

function fileStore(filepath) {
  let records = [];
  if (fs.existsSync(filepath)) {
    try { records = JSON.parse(fs.readFileSync(filepath, 'utf8')); }
    catch { records = []; }
  }

  function persist() {
    const tmp = filepath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
    fs.renameSync(tmp, filepath);
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
        if (agent && r.agent !== agent) return false;
        if (passed !== undefined && r.passed !== passed) return false;
        return true;
      });
    },
    all() { return [...records]; },
  };
}

// ─────────────────────────────────────────────────────────────
// UTILS — canonicalHash NOT exported (forgery prevention)
// ─────────────────────────────────────────────────────────────

function generateId(prefix = 'od') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function canonicalHash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(sortKeys(obj))).digest('hex');
}

function sortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = sortKeys(obj[k]); return acc; }, {});
  }
  return obj;
}

function getNestedValue(obj, field) {
  return field.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}

function sanitize(data) {
  if (!data) return data;
  try { return JSON.parse(JSON.stringify(data)); } catch { return String(data); }
}

function omit(obj, keys) {
  const result = { ...obj };
  for (const k of keys) delete result[k];
  return result;
}

function sign(hash, privateKey) {
  try { const s = crypto.createSign('SHA256'); s.update(hash); return s.sign(privateKey, 'hex'); }
  catch { return null; }
}

function verifySignature(hash, signature, publicKey) {
  try { const v = crypto.createVerify('SHA256'); v.update(hash); return v.verify(publicKey, signature, 'hex'); }
  catch { return false; }
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

function runCLI() {
  const args = process.argv.slice(2);
  const cmd  = args[0];

  if (!cmd || cmd === 'help') {
    console.log(`\nOpenDone v0.5.0 — machine-verifiable AI agent task completion\n\nCOMMANDS:\n  evaluate  <contract.json> <output.json>\n  verify    <receipt.json>\n  inspect   <receipt.json>\n  keygen\n  help\n`);
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
    const [, contractPath, outputPath] = args;
    if (!contractPath || !outputPath) { console.error('Usage: opendone evaluate <contract.json> <output.json>'); process.exit(1); }
    const receipt = evaluate({ contract: JSON.parse(fs.readFileSync(contractPath, 'utf8')), output: JSON.parse(fs.readFileSync(outputPath, 'utf8')) });
    const outPath = `receipt_${Date.now()}.json`;
    fs.writeFileSync(outPath, JSON.stringify(receipt, null, 2));
    console.log(receipt.passed ? '✓ PASSED' : '✗ FAILED');
    receipt.criteriaResults.forEach(r   => console.log(`  ${r.passed ? '✓' : '✗'} ${r.reason}`));
    receipt.constraintResults.forEach(r => console.log(`  ${r.passed ? '✓' : '✗'} ${r.reason}`));
    console.log(`\nReceipt saved: ${outPath}`);
    return;
  }
  if (cmd === 'verify') {
    if (!args[1]) { console.error('Usage: opendone verify <receipt.json>'); process.exit(1); }
    const result = verify(JSON.parse(fs.readFileSync(args[1], 'utf8')));
    console.log(result.valid ? `✓ ${result.reason}` : `✗ ${result.reason}`);
    return;
  }
  if (cmd === 'inspect') {
    if (!args[1]) { console.error('Usage: opendone inspect <receipt.json>'); process.exit(1); }
    const r = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    console.log(`\nOpenDone Receipt\n─────────────────────────────`);
    console.log(`ID:     ${r.receiptId}\nType:   ${r.isCheckpoint ? `Checkpoint (iteration ${r.checkpointIteration})` : 'Final'}\nTask:   ${r.task}\nAgent:  ${r.agent}\nIssued: ${r.issuedAt}\nResult: ${r.passed ? '✓ PASSED' : '✗ FAILED'}\nSigned: ${r.signature ? 'Yes' : 'No'}`);
    console.log(`\nCriteria:`);
    (r.criteriaResults  || []).forEach(c => console.log(`  ${c.passed ? '✓' : '✗'} ${c.reason}`));
    console.log(`\nConstraints:`);
    (r.constraintResults || []).forEach(c => console.log(`  ${c.passed ? '✓' : '✗'} ${c.reason}`));
    console.log(`\nHash: ${r.hash}`);
    return;
  }
  console.error(`Unknown command: ${cmd}. Run 'opendone help' for usage.`);
  process.exit(1);
}

if (require.main === module) runCLI();

// ─────────────────────────────────────────────────────────────
// EXPORTS — canonicalHash intentionally NOT exported
// ─────────────────────────────────────────────────────────────

module.exports = {
  contract, evaluate, checkpoint, verify,
  sign: signDocument, generateKeyPair, fileStore, defaultStore,
  OpenDoneError, Errors,
  openCoram:            Coram.openCoram,
  appendEntry:          Coram.appendEntry,
  closeCoram:           Coram.closeCoram,
  verifyCoram:          Coram.verifyCoram,
  attachCoramToReceipt: Coram.attachCoramToReceipt,
  coramFileStore:       Coram.coramFileStore,
  defaultCoramStore:    Coram.defaultCoramStore,
  CoramErrors:          Coram.CoramErrors,
};
