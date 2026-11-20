import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePaisa,validDate,validateDraft,voucherNumber,permitted,menuFor} from '../server/logic.mjs';
const input={
 type:'JV',department:'SERVICE',date:'2026-11-20',narrative:'Training only',
 lines:[{accountCode:'101',debit:'20,000.00',credit:'0'},{accountCode:'301',debit:'0',credit:'20000'}]
};
test('money validates exact two decimal digits',()=>{
 assert.equal(parsePaisa('1,234.50'),123450);
 assert.equal(parsePaisa('1.999'),null);
 assert.equal(parsePaisa('-1'),null);
 assert.equal(parsePaisa('2.1'),210);
});
test('rejects impossible calendar date',()=>{assert.equal(validDate('2026-02-31'),false);assert.equal(validDate('2026-11-20'),true);});
test('balanced entry validates',()=>assert.equal(validateDraft(input).debit,2000000));
test('blocks unbalanced entry',()=>assert.throws(()=>validateDraft({...input,lines:[input.lines[0],{...input.lines[1],credit:'19999'}]}),/equal/));
test('blocks double sided and zero lines',()=>{
 assert.throws(()=>validateDraft({...input,lines:[{...input.lines[0],credit:'1'},input.lines[1]]}),/exactly one/);
});
test('voucher identity uses type and month',()=>assert.equal(voucherNumber('BB/R','2026-11-20',12),'BB/R/2611000012'));
test('permissions prevent Sales from posting',()=>{
 assert.equal(permitted('SALES','vouchers:post'),false);
 assert.equal(permitted('FINANCE','vouchers:post'),true);
 assert.equal(permitted('VIEWER','vouchers:reverse'),false);
});
test('role-specific navigation',()=>{
 assert.ok(menuFor('SERVICE').some(x=>x.label==='Job Card'));
 assert.ok(!menuFor('SERVICE').some(x=>x.label==='Journal Voucher'));
 assert.ok(menuFor('FINANCE').some(x=>x.label==='Trial Balance'));
});
