'use strict';

const crypto = require('crypto');

function sha256(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(sortKeys(obj))).digest('hex');
}
function sortKeys(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = sortKeys(obj[k]); return acc; }, {});
}
function generateId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

// ── openCoram() ───────────────────────────────────────────────────────────────

function openCoram(options = {}) {
  const { contract, agentId = 'unknown', mode = 'hashed' } = options;
  if (!contract || !contract.contractId) { const e = new Error('openCoram() requires a valid contract'); e.code = 'CORAM_INVALID'; throw e; }
  if (!contract.hash) { const e = new Error('openCoram() requires contract with a hash'); e.code = 'CORAM_INVALID'; throw e; }
  const validModes = ['hashed', 'inline', 'redacted'];
  if (!validModes.includes(mode)) { const e = new Error(`Invalid mode: ${mode}`); e.code = 'CORAM_INVALID'; throw e; }

  return {
    coramId:      generateId('od_coram'),   // prefix expected by test-coram.js
    coramVersion: '0.1.0',
    contractId:   contract.contractId,
    contractHash: contract.hash,
    agentId,
    mode,
    startedAt:    new Date().toISOString(),
    closedAt:     null,
    status:       'open',
    entryCount:   0,
    entries:      [],
    finalHash:    null,
    _actionIndex: {},
  };
}

// ── appendEntry() ─────────────────────────────────────────────────────────────

function appendEntry(coram, data = {}) {
  if (!coram || coram.status === 'closed') { const e = new Error('Cannot append to a closed coram record'); e.code = 'CORAM_INVALID'; throw e; }
  if (!data.action) { const e = new Error('appendEntry() requires an action'); e.code = 'CORAM_INVALID'; throw e; }

  const { action, input = null, result = null, status = 'ok' } = data;
  const mode = coram.mode;

  // loopCount is 1-based: first call = 1, second = 2, etc.
  // loopWarning is true when loopCount >= 2 (i.e. seen this action+input before)
  const key = JSON.stringify({ action, input });
  const seen = coram._actionIndex[key] || 0;
  coram._actionIndex[key] = seen + 1;
  const loopCount   = seen + 1;        // 1-based
  const loopWarning = loopCount >= 2;  // true on second+ occurrence

  // Only consider properly-hashed entries for chain (ignore raw pushes from external sources)
  const validEntries = coram.entries.filter(e => e.entryHash);
  const previousHash = validEntries.length === 0
    ? coram.contractHash
    : validEntries[validEntries.length - 1].entryHash;

  let inputHash = null, resultHash = null, inputInline = null, resultInline = null;
  if (mode === 'hashed') {
    inputHash  = input  != null ? sha256(input)  : null;
    resultHash = result != null ? sha256(result) : null;
  } else if (mode === 'inline') {
    inputInline  = input;  resultInline = result;
    inputHash    = input  != null ? sha256(input)  : null;
    resultHash   = result != null ? sha256(result) : null;
  }
  // redacted: all null

  const entryId   = validEntries.length + 1;   // 1-based sequential integer
  const timestamp = new Date().toISOString();
  const entryHash = sha256({ entryId, action, inputHash, resultHash, status, loopWarning, loopCount, previousHash, timestamp });

  const entry = { entryId, timestamp, action, inputHash, resultHash, inputInline, resultInline, status, loopWarning, loopCount, previousHash, entryHash };
  coram.entries.push(entry);
  coram.entryCount = coram.entries.filter(e => e.entryHash).length;
  return entry;
}

// ── closeCoram() ──────────────────────────────────────────────────────────────

function closeCoram(coram) {
  if (!coram || coram.status === 'closed') { const e = new Error('Coram record is already closed'); e.code = 'CORAM_INVALID'; throw e; }
  coram.status   = 'closed';
  coram.closedAt = new Date().toISOString();
  const validOnClose = coram.entries.filter(e => e.entryHash);
  coram.entryCount = validOnClose.length;
  coram.finalHash  = validOnClose.length > 0
    ? validOnClose[validOnClose.length - 1].entryHash
    : coram.contractHash;
  delete coram._actionIndex;
  return coram;
}

// ── verifyCoram() ─────────────────────────────────────────────────────────────

function verifyCoram(coramRecord, receipt) {
  if (!coramRecord) return { valid: false, reason: 'No coram record provided' };
  if (!coramRecord.coramId) return { valid: false, reason: 'coramId missing' };

  const loopWarnings = [];
  let expectedPrev = coramRecord.contractHash;

  // Only verify properly-hashed entries
  const validEntries = coramRecord.entries.filter(e => e.entryHash);

  for (let i = 0; i < validEntries.length; i++) {
    const e = validEntries[i];
    if (e.previousHash !== expectedPrev) {
      return { valid: false, reason: `Chain broken at entry ${i}: previousHash mismatch` };
    }
    const recomputed = sha256({
      entryId: e.entryId, action: e.action,
      inputHash: e.inputHash, resultHash: e.resultHash,
      status: e.status, loopWarning: e.loopWarning, loopCount: e.loopCount,
      previousHash: e.previousHash, timestamp: e.timestamp,
    });
    if (recomputed !== e.entryHash) {
      return { valid: false, reason: `Entry ${i} hash mismatch — tampered` };
    }
    if (e.loopWarning) loopWarnings.push({ action: e.action, loopCount: e.loopCount, entryId: e.entryId });
    expectedPrev = e.entryHash;
  }

  if (coramRecord.status === 'closed') {
    const expectedFinal = validEntries.length > 0
      ? validEntries[validEntries.length - 1].entryHash
      : coramRecord.contractHash;
    if (coramRecord.finalHash !== expectedFinal) {
      return { valid: false, reason: 'finalHash mismatch — record may be truncated' };
    }
  }

  if (coramRecord.entryCount !== validEntries.length) {
    return { valid: false, reason: `entryCount count mismatch: expected ${coramRecord.entryCount}, found ${validEntries.length}` };
  }

  // Receipt cross-check
  if (receipt) {
    if (receipt.coramHash != null && receipt.coramHash !== coramRecord.finalHash) {
      return { valid: false, reason: `coramHash mismatch` };
    }
    if (receipt.coramId != null && receipt.coramId !== coramRecord.coramId) {
      return { valid: false, reason: `coramId mismatch` };
    }
    if (receipt.coramEntryCount != null && receipt.coramEntryCount !== coramRecord.entryCount) {
      return { valid: false, reason: `coramEntryCount mismatch` };
    }
    if (receipt.contractId != null && receipt.contractId !== coramRecord.contractId) {
      return { valid: false, reason: `contractId mismatch` };
    }
    return {
      valid: true,
      loopWarnings,
      reason: 'Coram record reconciled with receipt',
      detail: { entryCount: validEntries.length },
    };
  }

  return {
    valid: true,
    loopWarnings,
    detail: { entryCount: validEntries.length },
  };
}

// ── attachCoramToReceipt() ────────────────────────────────────────────────────

function attachCoramToReceipt(receiptFields, closedCoram) {
  receiptFields.coramHash       = closedCoram.finalHash;
  receiptFields.coramEntryCount = closedCoram.entryCount;
  receiptFields.coramStatus     = closedCoram.status;
  receiptFields.coramId         = closedCoram.coramId;
}

module.exports = { openCoram, appendEntry, closeCoram, verifyCoram, attachCoramToReceipt };
