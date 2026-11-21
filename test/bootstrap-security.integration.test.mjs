import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {verifyPassword} from '../server/api.mjs';

test('Bootstrap is create-only, cannot reset admin credentials or elevate existing users, and audit log is immutable',{
  skip:!process.env.DATABASE_URL
},async()=>{
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL});
 const tag=randomBytes(6).toString('hex'),code='S'+tag,email='bootstrap-'+tag+'@example.test';
 const env={...process.env,
  BOOTSTRAP_COMPANY_CODE:code,
  BOOTSTRAP_COMPANY_NAME:'Bootstrap Security QA',
  BOOTSTRAP_ADMIN_EMAIL:email,
  BOOTSTRAP_ADMIN_PASSWORD:'Safe-Initial-Password-987654321'
 };
 const script=fileURLToPath(new URL('../scripts/bootstrap.mjs',import.meta.url));
 const run=(extra={})=>spawnSync(process.execPath,[script],{
   encoding:'utf8',timeout:30000,env:{...env,...extra}
 });
 try {
  const first=run();
  assert.equal(first.status,0,first.stderr);
  const company=await db.query('SELECT id,name FROM companies WHERE code=$1',[code]);
  assert.equal(company.rowCount,1);
  const companyId=company.rows[0].id;
  const firstUser=await db.query('SELECT id,password_hash FROM app_users WHERE email=$1',[email]);
  assert.equal(firstUser.rowCount,1);
  const userId=firstUser.rows[0].id;
  assert.equal(verifyPassword(env.BOOTSTRAP_ADMIN_PASSWORD,firstUser.rows[0].password_hash),true);
  const member=await db.query('SELECT role FROM memberships WHERE company_id=$1 AND user_id=$2',[companyId,userId]);
  assert.equal(member.rows[0].role,'ADMIN');
  // A second run may not silently rehash the password, rename the company or
  // overwrite the existing privileged membership.
  const second=run({
    BOOTSTRAP_ADMIN_PASSWORD:'Attempted-Reset-Password-1234',
    BOOTSTRAP_COMPANY_NAME:'Hijacked Company Name'
  });
  assert.notEqual(second.status,0,'Re-running bootstrap must fail');
  assert.match(second.stderr,/already exists/i);
  const after=await db.query('SELECT id,password_hash FROM app_users WHERE email=$1',[email]);
  assert.equal(after.rows[0].password_hash,firstUser.rows[0].password_hash);
  const companyAfter=await db.query('SELECT name FROM companies WHERE id=$1',[companyId]);
  assert.equal(companyAfter.rows[0].name,'Bootstrap Security QA');
  // An existing user from another company must never be turned into an Admin
  // at the new company by running this privileged setup script.
  const reuse=run({
    BOOTSTRAP_COMPANY_CODE:'N'+tag,
    BOOTSTRAP_ADMIN_EMAIL:email
  });
  assert.notEqual(reuse.status,0);
  const forbidden=await db.query('SELECT id FROM companies WHERE code=$1',['N'+tag]);
  assert.equal(forbidden.rowCount,0,'Duplicate-email bootstrap transaction must rollback');
  const noCode=run({BOOTSTRAP_COMPANY_CODE:''});
  assert.notEqual(noCode.status,0);
  // Append-only event provenance: SQL edits and deletions must both be blocked.
  const audit=await db.query(
    "SELECT id FROM audit_events WHERE company_id=$1 AND action='COMPANY_BOOTSTRAPPED'",[companyId]);
  assert.equal(audit.rowCount,1);
  await assert.rejects(
    db.query("UPDATE audit_events SET action='REWRITTEN' WHERE id=$1",[audit.rows[0].id]),
    /Audit history is immutable/
  );
  await assert.rejects(
    db.query('DELETE FROM audit_events WHERE id=$1',[audit.rows[0].id]),
    /Audit history is immutable/
  );
 }finally{await db.end();}
});
