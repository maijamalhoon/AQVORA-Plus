import {readFile,access} from 'node:fs/promises';
const requiredFiles=[
 'db/001_initial.sql','db/002_automotive.sql','db/003_accounted_finance.sql',
 'db/004_tax_returns_delivery.sql','db/005_refund_approvals.sql',
 'db/006_supplier_refunds.sql','db/007_audit_immutability.sql','db/008_staff_first_login.sql',
 'db/009_bank_reconciliation.sql',
 'server/api.mjs','server/ledger-controls.mjs','server/automotive.mjs',
 'server/finance-operations.mjs','server/phase5.mjs','server/phase6.mjs',
 'server/phase7.mjs','server/bank-reconciliation.mjs','scripts/bootstrap.mjs','scripts/migrate.mjs',
 'docs/RELEASE_READINESS.md','test/bootstrap-security.integration.test.mjs',
 'test/ledger-controls.integration.test.mjs','test/staff-onboarding.integration.test.mjs','test/bank-reconciliation.integration.test.mjs'
];
const checks=[];
for(const file of requiredFiles){
 try{await access(new URL('../'+file,import.meta.url));checks.push({check:'file:'+file,pass:true});}
 catch{checks.push({check:'file:'+file,pass:false});}
}
const migrate=await readFile(new URL('./migrate.mjs',import.meta.url),'utf8');
for(let version=1;version<=9;version++){
 const expected=String(version).padStart(3,'0')+'_';
 checks.push({check:'migration:'+expected,pass:migrate.includes(expected)});
}
const bootstrap=await readFile(new URL('./bootstrap.mjs',import.meta.url),'utf8');
checks.push({check:'bootstrap:create-only',pass:bootstrap.includes('Bootstrap is CREATE-ONLY')&&!bootstrap.includes('DO UPDATE SET password_hash')});
const audit=await readFile(new URL('../db/007_audit_immutability.sql',import.meta.url),'utf8');
checks.push({check:'append-only-audit',pass:audit.includes('BEFORE UPDATE OR DELETE ON audit_events')});
const passes=checks.every(x=>x.pass);
const blockers=[
 'Independent security/penetration assessment and MFA not completed',
 'Bank statements, payment evidence and actual bank-transfer confirmations not integrated',
 'Real dealership end-to-end workflows, full vehicle returns and legal delivery not complete',
 'Production backup/restore drill and live observability not verified',
 'Company-specific tax compliance and statutory invoice verification incomplete',
 'Full data migration, approval authorization limits, RLS and finance cutover not certified'
];
const report={product:'AQVORA Plus',tier:'development-demo',structure_ok:passes,
  checks:checks.length,passed:checks.filter(x=>x.pass).length,failed:checks.filter(x=>!x.pass),
  production_ready:false,production_blockers:blockers};
console.log(JSON.stringify(report,null,2));
if(!passes)process.exitCode=1;
if(process.env.AQVORA_RELEASE_MODE==='production'){
 console.error('AQVORA Plus production promotion blocked: independent production gate not satisfied.');
 process.exitCode=1;
}
