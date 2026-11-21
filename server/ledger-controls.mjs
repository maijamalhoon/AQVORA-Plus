/**
 * AQVORA Plus: source-controlled GL accounts have their own audited subledgers.
 * Generic manual vouchers may not post to them because doing so breaks
 * receivable, payable, inventory and tax reconciliation.
 *
 * Keep aligned with the accounts seeded in scripts/bootstrap.mjs.
 * Source-linked automotive/finance APIs post through dedicated journal helpers.
 */
export const SYSTEM_POSTED_CONTROL_CODES=Object.freeze([
  '1020301001', // Trade receivables — source invoices, collections and credits
  '2010101001', // Trade payables — supplier bills, payments, returns and refunds
  '1020501001', // Vehicle inventory — acquisition and COGS
  '1020601001', // Parts inventory — accounted receipts, issues and returns
  '2010201001'  // Sales tax payable — invoices and credit-note adjustments
]);
const sourceControlled=new Set(SYSTEM_POSTED_CONTROL_CODES);
export function blockedControlCodes(codes){
  return [...new Set(codes)].filter(code=>sourceControlled.has(code)).sort();
}
