/** Independent demo finance domain; not a production persistence or authorization layer. */
export const demoAccounts = Object.freeze([
  { code: '1020101001', name: 'CASH IN HAND', type: 'asset' },
  { code: '1020402001', name: 'BANK - DEMO ACCOUNT', type: 'asset' },
  { code: '1020301001', name: 'ACCOUNTS RECEIVABLE', type: 'asset' },
  { code: '2010101001', name: 'ACCOUNTS PAYABLE', type: 'liability' },
  { code: '3010101001', name: 'OWNER CAPITAL', type: 'equity' },
  { code: '4010101001', name: 'SERVICE REVENUE', type: 'income' },
  { code: '5010101001', name: 'OFFICE EXPENSE', type: 'expense' },
]);
const codeSet = new Set(demoAccounts.map(account => account.code));
const validPaisa = value => Number.isSafeInteger(value) && value >= 0;

export function parsePaisa(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [units, cents = ''] = cleaned.split('.');
  const result = Number(units) * 100 + Number(cents.padEnd(2, '0'));
  return validPaisa(result) ? result : null;
}

export function validatePosting(input) {
  if (!input || typeof input !== 'object') throw Error('Posting is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(input.date))) throw Error('Valid date required');
  if (typeof input.narrative !== 'string' || !input.narrative.trim()) throw Error('Narration required');
  if (!Array.isArray(input.lines) || input.lines.length < 2) throw Error('At least two journal lines required');
  let debit = 0; let credit = 0;
  for (const line of input.lines) {
    if (!codeSet.has(line.accountCode)) throw Error('Unknown account');
    if (!validPaisa(line.debit) || !validPaisa(line.credit)) throw Error('Invalid money amount');
    if ((line.debit > 0) === (line.credit > 0)) throw Error('Each line requires exactly one nonzero side');
    debit += line.debit;
    credit += line.credit;
  }
  if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) throw Error('Amount exceeds safe range');
  if (debit === 0 || debit !== credit) throw Error('Debit and credit totals must balance');
  return { debit, credit };
}

export function postVoucher(existing, input) {
  if (!Array.isArray(existing)) throw Error('Voucher register required');
  if (typeof input.id !== 'string' || !input.id.trim() || typeof input.number !== 'string' || !input.number.trim()) throw Error('Voucher identity required');
  if (existing.some(v => v.id === input.id || v.number === input.number)) throw Error('Duplicate voucher identity');
  validatePosting(input);
  const voucher = {
    id: input.id, number: input.number, date: input.date, center: input.center,
    type: input.type ?? 'JV', narrative: input.narrative.trim(),
    reverses: input.reverses ?? null,
    lines: input.lines.map(line => ({ accountCode: line.accountCode, debit: line.debit, credit: line.credit })),
  };
  return [...existing, voucher];
}

export function reverseVoucher(existing, originalId, reversal) {
  const original = existing.find(v => v.id === originalId);
  if (!original) throw Error('Original voucher not found');
  if (original.type === 'REV') throw Error('Cannot reverse a reversal');
  if (existing.some(v => v.reverses === originalId)) throw Error('Already reversed');
  if (!reversal.reason?.trim()) throw Error('Reversal reason required');
  return postVoucher(existing, {
    id: reversal.id, number: reversal.number, date: reversal.date,
    center: original.center, type: 'REV', reverses: original.id,
    narrative: reversal.reason.trim(),
    lines: original.lines.map(l => ({ accountCode: l.accountCode, debit: l.credit, credit: l.debit })),
  });
}

export function trialBalance(vouchers) {
  const totals = new Map(demoAccounts.map(a => [a.code, 0]));
  for (const voucher of vouchers) {
    validatePosting(voucher);
    for (const line of voucher.lines) totals.set(line.accountCode, totals.get(line.accountCode) + line.debit - line.credit);
  }
  return demoAccounts.map(a => {
    const amount = totals.get(a.code);
    return { ...a, debit: Math.max(0, amount), credit: Math.max(0, -amount) };
  });
}

export function generalLedger(vouchers, accountCode) {
  if (!codeSet.has(accountCode)) throw Error('Unknown account');
  let balance = 0;
  return vouchers.flatMap(v => v.lines.filter(l => l.accountCode === accountCode).map(l => {
    balance += l.debit - l.credit;
    return { voucher: v.number, date: v.date, narrative: v.narrative, debit: l.debit, credit: l.credit, balance };
  }));
}
