'use strict';

/**
 * Coram v0.1.0
 * The fourth OpenDone primitive.
 * 
 * A contract-anchored, append-only, hash-chained record of everything
 * an agent did during a task — written by infrastructure outside the
 * executing agent, readable by anyone with the Receipt.
 * 
 * "Coram" (Latin: in the presence of) — the agent ran in the presence
 * of the contract. Witnessed. On record. Verifiable.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

const CoramErrors = {
  CORAM_TAMPER_DETECTED: 'CORAM_TAMPER_DETECTED',
  CORAM_TRACE_MISMATCH:  'CORAM_TRACE_MISMATCH',
  CORAM_INVALID:         'CORAM_INVALID',
  CORAM_STORE_ERROR:     'CORAM_STORE_ERROR',
};

// ─────────────────────────────────────────────────────────────
// CORAM RECORD — create
// ─────────────────────────────────────────────────────────────

/**
 * Open a new Coram record for a task run.
 * Must be called before the agent starts executing.
 * 
 * @param {object} options
 * @param {object} options.contract   - The governing OpenDone contract
 * @param {string} [options.agentId]  - Identifier for the executing agent
 * @param {string} [options.mode]     - Payload mode: 'hashed' | 'inline' | 'redacted' (default: 'hashed')
 * @returns {object} coramRecord
 */
function openCoram({ contract, agentId = 'unknown', mode = 'hashed' } = {}) {
  if (!contract || !contract.contractId || !contract.hash) {
    throw new OpenDoneError(CoramErrors.CORAM_INVALID, 'openCoram() requires a valid OpenDone contract with a hash');
  }

  const validModes = ['hashed', 'inline', 'redacted'];
  if (!validModes.includes(mode)) {
    throw new OpenDoneError(CoramErrors.CORAM_INVALID, `Invalid payload mode: ${mode}. Must be one of: ${validModes.join(', ')}`);
  }

  return {
    coramId:       generateId('od_coram'),
    coramVersion:  '0.1.0',
    contractId:    contract.contractId,
    contractHash:  contract.hash,
    agentId,
    mode,
    startedAt:     new Date().toISOString(),
    closedAt:      null,
    status:        'open',
    entryCount:    0,
    entries:       [],
    finalHash:     null,
    // Internal: action+input fingerprints for loop detection
    _actionIndex:  {},
  };
}

// ─────────────────────────────────────────────────────────────
// APPEND ENTRY
// ─────────────────────────────────────────────────────────────

/**
 * Append an action entry to a Coram record.
 * Called by infrastructure after every agent tool call completes.
 * The agent never calls this directly.
 * 
 * @param {object} coramRecord   - Open Coram record from openCoram()
 * @param {object} options
 * @param {string} options.action       - Tool name or operation (e.g., 'fs.readFile', 'web.search')
 * @param {*}      options.input        - The actual input passed to the action
 * @param {*}      options.result       - The actual result returned
 * @param {string} [options.status]     - 'success' | 'failure' | 'breach' (default: 'success')
 * @returns {object} the entry that was appended
 */
function appendEntry(coramRecord, { action, input, result, status = 'success' } = {}) {
  if (!coramRecord || coramRecord.status !== 'open') {
    throw new OpenDoneError(CoramErrors.CORAM_INVALID, 'Cannot append to a closed or invalid Coram record');
  }
  if (!action || typeof action !== 'string') {
    throw new OpenDoneError(CoramErrors.CORAM_INVALID, 'appendEntry() requires an action string');
  }

  const entryId    = coramRecord.entryCount + 1;
  const inputHash  = canonicalHash(input  !== undefined ? input  : null);
  const resultHash = canonicalHash(result !== undefined ? result : null);

  // Loop detection: fingerprint = action + ":" + inputHash
  const fingerprint = `${action}:${inputHash}`;
  if (!coramRecord._actionIndex[fingerprint]) {
    coramRecord._actionIndex[fingerprint] = 0;
  }
  coramRecord._actionIndex[fingerprint]++;
  const loopCount   = coramRecord._actionIndex[fingerprint];
  const loopWarning = loopCount > 1;

  // Chain: first entry anchors to contractHash, all others to previous entryHash
  const previousHash = entryId === 1
    ? coramRecord.contractHash
    : coramRecord.entries[entryId - 2].entryHash;

  // Payload based on mode
  const inputInline  = coramRecord.mode === 'inline' ? sanitize(input)  : null;
  const resultInline = coramRecord.mode === 'inline' ? sanitize(result) : null;
  const safeInputHash  = coramRecord.mode === 'redacted' ? null : inputHash;
  const safeResultHash = coramRecord.mode === 'redacted' ? null : resultHash;

  const entry = {
    entryId,
    timestamp:    new Date().toISOString(),
    action,
    inputHash:    safeInputHash,
    resultHash:   safeResultHash,
    inputInline,
    resultInline,
    status,
    loopWarning,
    loopCount,
    previousHash,
    entryHash:    '',  // computed below
  };

  // Compute entryHash over the entry with entryHash = ''
  entry.entryHash = canonicalHash(entry);

  coramRecord.entries.push(entry);
  coramRecord.entryCount = entryId;

  return entry;
}

// ─────────────────────────────────────────────────────────────
// CLOSE CORAM RECORD
// ─────────────────────────────────────────────────────────────

/**
 * Close the Coram record and produce the finalHash.
 * Called when evaluate() generates the Receipt.
 * 
 * @param {object} coramRecord
 * @returns {object} closed coramRecord with finalHash populated
 */
function closeCoram(coramRecord) {
  if (!coramRecord || coramRecord.status !== 'open') {
    throw new OpenDoneError(CoramErrors.CORAM_INVALID, 'closeCoram() requires an open Coram record');
  }

  coramRecord.closedAt  = new Date().toISOString();
  coramRecord.status    = 'closed';
  coramRecord.finalHash = coramRecord.entryCount > 0
    ? coramRecord.entries[coramRecord.entryCount - 1].entryHash
    : coramRecord.contractHash;  // no entries: anchor is the contract hash itself

  // Remove internal index before persisting
  delete coramRecord._actionIndex;

  return coramRecord;
}

// ─────────────────────────────────────────────────────────────
// VERIFY CORAM
// ─────────────────────────────────────────────────────────────

/**
 * Verify a Coram record's integrity.
 * Optionally cross-check against a Receipt for full verification.
 * 
 * @param {object} coramRecord
 * @param {object} [receipt]   - OpenDone receipt for cross-check
 * @returns {{ valid: boolean, reason: string, loopWarnings: array, detail: object }}
 */
function verifyCoram(coramRecord, receipt = null) {
  if (!coramRecord || !coramRecord.contractHash) {
    return { valid: false, reason: 'Invalid Coram record — missing contractHash', loopWarnings: [], detail: {} };
  }

  // 1. Verify chain integrity
  for (let i = 0; i < coramRecord.entries.length; i++) {
    const entry = coramRecord.entries[i];
    const expectedPrevious = i === 0
      ? coramRecord.contractHash
      : coramRecord.entries[i - 1].entryHash;

    if (entry.previousHash !== expectedPrevious) {
      return {
        valid: false,
        reason: `Chain broken at entry ${entry.entryId} — previousHash mismatch`,
        loopWarnings: [],
        detail: { entryId: entry.entryId, code: CoramErrors.CORAM_TAMPER_DETECTED },
      };
    }

    // Recompute entryHash
    const stored = entry.entryHash;
    const recomputed = canonicalHash({ ...entry, entryHash: '' });
    if (stored !== recomputed) {
      return {
        valid: false,
        reason: `Entry ${entry.entryId} hash mismatch — entry may have been tampered with`,
        loopWarnings: [],
        detail: { entryId: entry.entryId, code: CoramErrors.CORAM_TAMPER_DETECTED },
      };
    }
  }

  // 2. Verify entryCount matches actual entries
  if (coramRecord.entryCount !== coramRecord.entries.length) {
    return {
      valid: false,
      reason: `Entry count mismatch — record claims ${coramRecord.entryCount} entries but contains ${coramRecord.entries.length}`,
      loopWarnings: [],
      detail: { code: CoramErrors.CORAM_TAMPER_DETECTED },
    };
  }

  // 3. Verify finalHash matches last entry
  if (coramRecord.status === 'closed' && coramRecord.entryCount > 0) {
    const lastEntry = coramRecord.entries[coramRecord.entryCount - 1];
    if (coramRecord.finalHash !== lastEntry.entryHash) {
      return {
        valid: false,
        reason: 'finalHash does not match last entry — record may have been truncated',
        loopWarnings: [],
        detail: { code: CoramErrors.CORAM_TAMPER_DETECTED },
      };
    }
  }

  // 4. Cross-check with Receipt if provided
  if (receipt) {
    if (receipt.coramId && receipt.coramId !== coramRecord.coramId) {
      return {
        valid: false,
        reason: 'Receipt coramId does not match this Coram record',
        loopWarnings: [],
        detail: { code: CoramErrors.CORAM_TRACE_MISMATCH },
      };
    }
    if (receipt.coramHash && receipt.coramHash !== coramRecord.finalHash) {
      return {
        valid: false,
        reason: 'Receipt coramHash does not match Coram finalHash — record may have been swapped',
        loopWarnings: [],
        detail: { code: CoramErrors.CORAM_TRACE_MISMATCH },
      };
    }
    if (receipt.coramEntryCount !== undefined && receipt.coramEntryCount !== coramRecord.entryCount) {
      return {
        valid: false,
        reason: `Receipt coramEntryCount (${receipt.coramEntryCount}) does not match record (${coramRecord.entryCount}) — possible truncation`,
        loopWarnings: [],
        detail: { code: CoramErrors.CORAM_TAMPER_DETECTED },
      };
    }
  }

  // 5. Collect loop warnings (informational, does not fail verification)
  const loopWarnings = coramRecord.entries
    .filter(e => e.loopWarning)
    .map(e => ({ entryId: e.entryId, action: e.action, loopCount: e.loopCount }));

  return {
    valid: true,
    reason: receipt
      ? 'Coram integrity confirmed and reconciled with Receipt'
      : 'Coram integrity confirmed',
    loopWarnings,
    detail: {
      entryCount:   coramRecord.entryCount,
      loopWarningCount: loopWarnings.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// CORAM STORE
// ─────────────────────────────────────────────────────────────

/**
 * File-based Coram store with atomic writes.
 * Mirrors the fileStore interface from opendone.js.
 */
function coramFileStore(filepath) {
  let records = {};
  if (fs.existsSync(filepath)) {
    try { records = JSON.parse(fs.readFileSync(filepath, 'utf8')); }
    catch { records = {}; }
  }

  function persist() {
    const tmp = filepath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
    fs.renameSync(tmp, filepath);
  }

  return {
    save(coramRecord) {
      records[coramRecord.coramId] = coramRecord;
      try { persist(); }
      catch (e) {
        throw new OpenDoneError(CoramErrors.CORAM_STORE_ERROR, `Failed to write Coram store: ${e.message}`);
      }
      return coramRecord;
    },
    get(coramId) {
      return records[coramId] || null;
    },
    all() { return Object.values(records); },
  };
}

/**
 * In-memory Coram store (default, for testing).
 */
const defaultCoramStore = (() => {
  const records = {};
  return {
    save(coramRecord) { records[coramRecord.coramId] = coramRecord; return coramRecord; },
    get(coramId) { return records[coramId] || null; },
    all() { return Object.values(records); },
  };
})();

// ─────────────────────────────────────────────────────────────
// RECEIPT INTEGRATION HELPER
// ─────────────────────────────────────────────────────────────

/**
 * Attach Coram fields to a Receipt before it is finalized.
 * Call this inside evaluate() after closeCoram().
 * 
 * @param {object} receiptFields  - The receipt fields object before hashing
 * @param {object} coramRecord    - Closed Coram record
 * @returns {object} receiptFields with Coram fields added
 */
function attachCoramToReceipt(receiptFields, coramRecord) {
  receiptFields.coramId         = coramRecord.coramId;
  receiptFields.coramHash       = coramRecord.finalHash;
  receiptFields.coramEntryCount = coramRecord.entryCount;
  receiptFields.coramStatus     = coramRecord.status;
  return receiptFields;
}

// ─────────────────────────────────────────────────────────────
// UTILS (self-contained, no dependency on opendone.js internals)
// ─────────────────────────────────────────────────────────────

function generateId(prefix = 'od') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

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

function sanitize(data) {
  if (!data) return data;
  try { return JSON.parse(JSON.stringify(data)); }
  catch { return String(data); }
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
  openCoram,
  appendEntry,
  closeCoram,
  verifyCoram,
  attachCoramToReceipt,
  coramFileStore,
  defaultCoramStore,
  CoramErrors,
};
