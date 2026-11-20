import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePaisa, validatePosting, postVoucher, reverseVoucher, trialBalance, generalLedger } from '../src/domain/journal.mjs';
const a = '1020101001';
const b = '3010101001';
const input = { id: '1', number: 'JV/2611000001', date: '2026-11-20', center: 'SERVICE', narrative: 'Fictional opening balance', lines: [
  { accountCode: a, debit: 2500000, credit: 0 },
  { accountCode: b, debit: 0, credit: 2500000 },
] };
test('money uses integer paisa', () => {
  assert.equal(parsePaisa('1,000.05'), 100005);
  assert.equal(parsePaisa('1.001'), null);
  assert.equal(parsePaisa('-1'), null);
});
test('balanced postings pass', () => assert.equal(validatePosting(input).debit, 2500000));
test('unbalanced entries are rejected', () => assert.throws(() => validatePosting({ ...input, lines: [input.lines[0], { ...input.lines[1], credit: 2000000 }] }), /balance/));
test('double-sided lines are rejected', () => assert.throws(() => validatePosting({ ...input, lines: [{ ...input.lines[0], credit: 100 }, input.lines[1]] }), /exactly one/));
test('duplicate voucher numbers are rejected', () => assert.throws(() => postVoucher(postVoucher([], input), { ...input, id: '2' }), /Duplicate/));
test('trial balance and general ledger stay reconciled', () => {
  const register = postVoucher([], input);
  const tb = trialBalance(register);
  assert.equal(tb.reduce((n, row) => n + row.debit, 0), tb.reduce((n, row) => n + row.credit, 0));
  assert.equal(generalLedger(register, a)[0].balance, 2500000);
});
test('reversal is an append-only offsetting entry', () => {
  const initial = postVoucher([], input);
  const register = reverseVoucher(initial, '1', { id: '2', number: 'REV/2611000001', date: '2026-11-20', reason: 'Correction' });
  assert.equal(initial.length, 1);
  assert.equal(register.length, 2);
  assert.equal(register[1].reverses, '1');
  assert.ok(trialBalance(register).every(row => row.debit === 0 && row.credit === 0));
  assert.throws(() => reverseVoucher(register, '1', { id: '3', number: 'REV/2611000002', date: '2026-11-20', reason: 'Again' }), /Already reversed/);
});
