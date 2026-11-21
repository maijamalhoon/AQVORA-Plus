/**
 * Setup only new financial control accounts for ONE explicitly selected company.
 * Existing accounts are not edited; no passwords or user memberships are touched.
 */
import {poolFromEnv} from '../server/api.mjs';
const companyCode=process.env.PHASE4_COMPANY_CODE;
if(!companyCode || !/^[A-Za-z0-9_-]{2,30}$/.test(companyCode)){
  console.error('Provide PHASE4_COMPANY_CODE matching one existing AQVORA Plus company');
  process.exit(1);
}
const items=[
 ['1020501001','VEHICLE INVENTORY - CONTROL','ASSET'],
 ['1020601001','SPARE PARTS INVENTORY - CONTROL','ASSET'],
 ['4010301001','VEHICLE SALES REVENUE','INCOME'],
 ['5010401001','COST OF VEHICLES SOLD','EXPENSE'],
 ['5010501001','PARTS CONSUMPTION / COGS','EXPENSE'],
 ['5010601001','PURCHASE PRICE VARIANCE','EXPENSE'],
 ['2010201001','SALES TAX CONTROL','LIABILITY']
];
const pool=poolFromEnv(),client=await pool.connect();
try{
 await client.query('BEGIN');
 const result=await client.query('SELECT id FROM companies WHERE code=$1 FOR UPDATE',[companyCode]);
 if(!result.rowCount)throw Error('Company not found: '+companyCode);
 const id=result.rows[0].id;
 for(const [code,name,kind] of items){
   const existing=await client.query('SELECT id,name,kind FROM accounts WHERE company_id=$1 AND code=$2',[id,code]);
   if(existing.rowCount){
     if(existing.rows[0].kind!==kind)throw Error('Conflicting account type at code '+code);
   }else await client.query(
     'INSERT INTO accounts(company_id,code,name,kind) VALUES($1,$2,$3,$4)',
     [id,code,name,kind]);
 }
 await client.query('COMMIT');
 console.log('Phase 4 control accounts prepared for '+companyCode);
}catch(error){
 await client.query('ROLLBACK');
 console.error('Account setup failed: '+error.message);process.exitCode=1;
}finally{client.release();await pool.end();}
