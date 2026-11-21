import {poolFromEnv,hashPassword} from '../server/api.mjs';
const {BOOTSTRAP_ADMIN_EMAIL:email,BOOTSTRAP_ADMIN_PASSWORD:password,BOOTSTRAP_COMPANY_NAME:name='AQVORA Plus Demo Motors',BOOTSTRAP_COMPANY_CODE:code='DEMO'}=process.env;
if(!email||!email.includes('@')||!password||password.length<12){
  console.error('Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (minimum 12 characters) securely');
  process.exit(1);
}
const pool=poolFromEnv(),db=await pool.connect();
try{
  await db.query('BEGIN');
  const company=(await db.query(
    'INSERT INTO companies(code,name) VALUES($1,$2) ON CONFLICT(code) DO UPDATE SET name=excluded.name RETURNING id',
    [code,name])).rows[0].id;
  for(const department of ['SALES','SERVICE','PARTS','FINANCE'])await db.query(
    'INSERT INTO departments(company_id,code,name) VALUES($1,$2,$3) ON CONFLICT(company_id,code) DO NOTHING',[company,department,department]);
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
  for(const [a,b,c] of defaultAccounts)await db.query(
    'INSERT INTO accounts(company_id,code,name,kind) VALUES($1,$2,$3,$4) ON CONFLICT(company_id,code) DO NOTHING',[company,a,b,c]);
  const month=new Date().toISOString().slice(0,7);
  await db.query('INSERT INTO fiscal_periods(company_id,period) VALUES($1,$2) ON CONFLICT DO NOTHING',[company,month]);
  const user=(await db.query(
    'INSERT INTO app_users(email,password_hash) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash RETURNING id',
    [email.toLowerCase(),hashPassword(password)])).rows[0].id;
  await db.query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(company_id,user_id) DO UPDATE SET role=excluded.role',[company,user,'ADMIN']);
  await db.query('COMMIT');
  console.log('Company bootstrap complete. No financial transactions have been seeded.');
}catch(error){await db.query('ROLLBACK');console.error(error);process.exitCode=1;}
finally{db.release();await pool.end();}
