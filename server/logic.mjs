/** Shared deterministic rules. All money is integer paisa. Real authorization is server-side. */
export const VOUCHER_TYPES = Object.freeze(['JV','CB/R','CB/P','BB/R','BB/P']);
export const DEPARTMENTS = Object.freeze(['SALES','SERVICE','PARTS','FINANCE']);
const actionRoles = Object.freeze({
  'vouchers:read': ['ADMIN','FINANCE','VIEWER'],
  'vouchers:create': ['ADMIN','FINANCE'],
  'vouchers:post': ['ADMIN','FINANCE'],
  'vouchers:reverse': ['ADMIN','FINANCE'],
  'reports:read': ['ADMIN','FINANCE','VIEWER'],
  'company:manage': ['ADMIN']
});
export function permitted(role, action) {
  return !!actionRoles[action]?.includes(role);
}
export function parsePaisa(raw) {
  if (typeof raw !== 'string') return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim().replaceAll(',', ''));
  if (!match) return null;
  const value = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2,'0') || 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function validDate(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(raw)) return false;
  const d=new Date(raw+'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10)===raw;
}
export function validateDraft(payload) {
  if (!VOUCHER_TYPES.includes(payload?.type)) throw new Error('Unsupported voucher type');
  if (!DEPARTMENTS.includes(payload.department)) throw new Error('Select a valid department');
  if (!validDate(payload.date)) throw new Error('Valid voucher date required');
  if (typeof payload.narrative !== 'string' || !payload.narrative.trim() || payload.narrative.length > 2000) throw new Error('Narration required (max 2,000 characters)');
  if (!Array.isArray(payload.lines) || payload.lines.length < 2 || payload.lines.length > 100) throw new Error('Voucher needs 2–100 lines');
  let debit=0, credit=0;
  const lines=payload.lines.map(l => {
    if (typeof l.accountCode !== 'string' || l.accountCode.length > 50) throw new Error('Invalid account code');
    const dr=parsePaisa(l.debit); const cr=parsePaisa(l.credit);
    if (dr===null || cr===null || (dr>0)===(cr>0)) throw new Error('Each line needs exactly one valid debit or credit');
    debit+=dr; credit+=cr;
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) throw new Error('Voucher exceeds safe amount');
    return {code:l.accountCode, debit:dr, credit:cr};
  });
  if (!debit || debit!==credit) throw new Error('Total debits must equal total credits');
  return {type:payload.type,department:payload.department,date:payload.date,narrative:payload.narrative.trim(),lines,debit,credit};
}
export function periodOf(date) { if(!validDate(date)) throw new Error('Invalid date'); return date.slice(0,7); }
export function voucherNumber(type,date,n) {
  if (!['JV','CB/R','CB/P','BB/R','BB/P','REV'].includes(type)) throw new Error('Unknown voucher type');
  if (!validDate(date) || !Number.isSafeInteger(n) || n<1 || n>999999) throw new Error('Invalid voucher sequence');
  return type + '/' + date.slice(2,4) + date.slice(5,7) + String(n).padStart(6,'0');
}
export function menuFor(role) {
  const common=[{id:'dashboard',label:'Dashboard',area:'Overview'}];
  const accounting=[
    {id:'vouchers',label:'Voucher Register',area:'Financials / Accounts'},
    ...VOUCHER_TYPES.map(type=>({id:'create:'+type,label:({JV:'Journal Voucher','CB/R':'Cash Book Receipt','CB/P':'Cash Book Payment','BB/R':'Bank Book Receipt','BB/P':'Bank Book Payment'})[type],area:'Financials / Accounts'})),
    {id:'trial',label:'Trial Balance',area:'Financial Reports'},
    {id:'ledger',label:'General Ledger',area:'Financial Reports'}
  ];
  const scoped={SALES:['Order Form','Sales Note'],SERVICE:['Appointment','Estimate','Job Card','Service Invoice'],PARTS:['Requisition','Purchase Order','GRN','Part Issue']};
  const operations=Object.entries(scoped).flatMap(([dept,labels])=>labels.map(label=>({id:'planned:'+dept+':'+label,label,area:dept+' Operations',planned:true,role:dept})));
  if (role==='ADMIN') return [...common,...accounting,...operations];
  if (role==='FINANCE' || role==='VIEWER') return [...common,...accounting.filter(x=>role==='FINANCE'||!x.id.startsWith('create:'))];
  return [...common,...operations.filter(x=>x.role===role)];
}
