import {parsePaisa,validDate} from './logic.mjs';

export const roleAccess=Object.freeze({
  customers_read:['ADMIN','SALES','SERVICE','FINANCE'],
  customers_write:['ADMIN','SALES','SERVICE'],
  sales_read:['ADMIN','SALES','FINANCE'],
  sales_write:['ADMIN','SALES'],
  service_read:['ADMIN','SERVICE','FINANCE','PARTS'],
  service_write:['ADMIN','SERVICE'],
  parts_read:['ADMIN','PARTS','SERVICE','FINANCE'],
  parts_write:['ADMIN','PARTS'],
  invoice_read:['ADMIN','FINANCE','SERVICE'],
  invoice_write:['ADMIN','FINANCE'],
  ar_read:['ADMIN','FINANCE']
});
export function roleAllowed(role,action){return !!roleAccess[action]?.includes(role);}
export const uuidPattern=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function stringField(value,label,max=140,min=2){
  if(typeof value!=='string')throw Error(label+' required');
  const s=value.trim();
  if(s.length<min||s.length>max)throw Error(label+' must contain '+min+'–'+max+' characters');
  return s;
}
export function optionalString(value,label,max=140){
  if(value===undefined||value===null||value==='')return null;
  return stringField(value,label,max,1);
}
export function paisaField(value,label){
  const n=parsePaisa(value);
  if(!Number.isSafeInteger(n)||n<=0)throw Error(label+' must be a positive PKR amount (up to 2 decimal places)');
  return n;
}
export function quantityField(value){
  if(!Number.isSafeInteger(value)||value<=0||value>1000000)throw Error('Quantity must be an integer from 1 to 1,000,000');
  return value;
}
export function dateField(value,label){
  if(!validDate(value))throw Error(label+' must be a valid YYYY-MM-DD date');
  return value;
}
export function nextJobStatus(status,next){
  const nextOf={OPEN:'IN_PROGRESS',IN_PROGRESS:'COMPLETED'};
  if(nextOf[status]!==next)throw Error('Invalid job status transition');
  return next;
}
export function daysOverdue(dueDate,asOfDate){
  const due=dateField(dueDate,'Due date'),asOf=dateField(asOfDate,'As-of date');
  return Math.max(0,Math.round((Date.parse(asOf)-Date.parse(due))/86400000));
}
export function agingBucket(days){
  if(!Number.isSafeInteger(days)||days<0)throw Error('Invalid aging days');
  if(days===0)return 'CURRENT';
  if(days<=30)return '1-30';
  if(days<=60)return '31-60';
  if(days<=90)return '61-90';
  return '90+';
}
