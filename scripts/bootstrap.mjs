import {poolFromEnv,hashPassword} from '../server/api.mjs';
const {
  BOOTSTRAP_ADMIN_EMAIL:rawEmail,
  BOOTSTRAP_ADMIN_PASSWORD:password,
  BOOTSTRAP_COMPANY_NAME:name,
  BOOTSTRAP_COMPANY_CODE:code
}=process.env;
const email=rawEmail?.trim().toLowerCase();
if(!email||!email.includes('@')||email.length>254||
   typeof password!=='string'||password.length<12||password.length>256||
   !name||!name.trim()||name.length>200||
   !code||!/^[A-Za-z0-9_-]{2,30}$/.test(code)){
  console.error('Bootstrap requires a NEW BOOTSTRAP_COMPANY_CODE, BOOTSTRAP_COMPANY_NAME, BOOTSTRAP_ADMIN_EMAIL and 12–256 character BOOTSTRAP_ADMIN_PASSWORD');
  process.exit(1);
}
const pool=poolFromEnv(),db=await pool.connect();
try {
  await db.query('BEGIN');
  // Bootstrap is CREATE-ONLY. This script must NEVER be an account reset,
  // role-elevation, company rename or cross-company membership mechanism.
  const existingCompany=await db.query(
    'SELECT id FROM companies WHERE code=$1 FOR UPDATE',[code]);
  if(existingCompany.rowCount)throw Error('Company code already exists. Bootstrap cannot modify an existing company or its admin.');
  const existingUser=await db.query(
    'SELECT id FROM app_users WHERE email=$1 FOR UPDATE',[email]);
  if(existingUser.rowCount)throw Error('Admin email already exists. Use a separately approved user-provisioning workflow.');
  const company=(await db.query(
    'INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id',[code,name.trim()]
  )).rows[0].id;
  for(const department of ['SALES','SERVICE','PARTS','FINANCE']){
    await db.query(
      'INSERT INTO departments(company_id,code,name) VALUES($1,$2,$3)',
      [company,department,department]
    );
  }
  const defaultAccounts=[
    ['1020101001','CASH IN HAND','ASSET'],
    ['1020402001','BANK ACCOUNT','ASSET'],
    ['1020301001','ACCOUNTS RECEIVABLE','ASSET'],
    ['2010101001','ACCOUNTS PAYABLE','LIABILITY'],
    ['3010101001','OWNER CAPITAL','EQUITY'],
    ['4010101001','SERVICE REVENUE','INCOME'],
    ['4010201001','PARTS REVENUE','INCOME'],
    ['5010101001','OFFICE EXPENSE','EXPENSE'],
    ['5010201001','UTILITY EXPENSE','EXPENSE'],
    ['1020501001','VEHICLE INVENTORY - CONTROL','ASSET'],
    ['1020601001','SPARE PARTS INVENTORY - CONTROL','ASSET'],
    ['4010301001','VEHICLE SALES REVENUE','INCOME'],
    ['5010401001','COST OF VEHICLES SOLD','EXPENSE'],
    ['5010501001','PARTS CONSUMPTION / COGS','EXPENSE'],
    ['5010601001','PURCHASE PRICE VARIANCE','EXPENSE'],
    ['2010201001','SALES TAX CONTROL','LIABILITY']
  ];
  for(const [code,name,kind] of defaultAccounts){
    await db.query(
      'INSERT INTO accounts(company_id,code,name,kind) VALUES($1,$2,$3,$4)',
      [company,code,name,kind]
    );
  }
  const month=new Date().toISOString().slice(0,7);
  await db.query('INSERT INTO fiscal_periods(company_id,period) VALUES($1,$2)',[company,month]);
  const user=(await db.query(
    'INSERT INTO app_users(email,password_hash) VALUES($1,$2) RETURNING id',
    [email,hashPassword(password)]
  )).rows[0].id;
  await db.query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',
    [company,user,'ADMIN']);
  await db.query(
    'INSERT INTO audit_events(company_id,actor_id,action,entity_id,meta) VALUES($1,$2,$3,$4,$5::jsonb)',
    [company,user,'COMPANY_BOOTSTRAPPED',company,JSON.stringify({companyCode:code})]
  );
  await db.query('COMMIT');
  console.log('New AQVORA Plus company initialized (creation only). No financial entries were seeded.');
}catch(error){
  await db.query('ROLLBACK');
  console.error('Bootstrap refused:',error.message);
  process.exitCode=1;
}finally {
  db.release();await pool.end();
}
