import {test} from 'node:test';
import assert from 'node:assert/strict';
import {roleAllowed,stringField,paisaField,quantityField,dateField,nextJobStatus,agingBucket,daysOverdue} from '../server/automotive-rules.mjs';
test('Sales cannot post finance or parts',()=>{
 assert.equal(roleAllowed('SALES','sales_write'),true);
 assert.equal(roleAllowed('SALES','invoice_write'),false);
 assert.equal(roleAllowed('SERVICE','parts_write'),false);
 assert.equal(roleAllowed('FINANCE','ar_read'),true);
});
test('Operational monetary values validate exact paisa',()=>{
 assert.equal(paisaField('123,456.70','Price'),12345670);
 assert.throws(()=>paisaField('0','Amount'),/positive/);
 assert.throws(()=>paisaField('12.999','Amount'),/positive/);
});
test('Service workflow only accepts forward transitions',()=>{
 assert.equal(nextJobStatus('OPEN','IN_PROGRESS'),'IN_PROGRESS');
 assert.equal(nextJobStatus('IN_PROGRESS','COMPLETED'),'COMPLETED');
 assert.throws(()=>nextJobStatus('OPEN','COMPLETED'),/Invalid/);
});
test('Quantities and required fields reject invalid payloads',()=>{
 assert.equal(quantityField(10),10);
 assert.throws(()=>quantityField(0),/Quantity/);
 assert.throws(()=>quantityField(1.2),/Quantity/);
 assert.equal(stringField(' Person ','Name'),'Person');
 assert.throws(()=>stringField(' ','Name'),/Name/);
});
test('AR aging buckets are deterministic',()=>{
 assert.equal(daysOverdue('2026-11-19','2026-11-20'),1);
 assert.equal(daysOverdue('2026-11-25','2026-11-20'),0);
 assert.equal(agingBucket(0),'CURRENT');
 assert.equal(agingBucket(14),'1-30');
 assert.equal(agingBucket(40),'31-60');
 assert.equal(agingBucket(80),'61-90');
 assert.equal(agingBucket(130),'90+');
 assert.throws(()=>dateField('2026-02-30','Date'),/valid/);
});
