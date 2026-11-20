import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {poolFromEnv} from '../server/api.mjs';

const pool=poolFromEnv(),client=await pool.connect();
try {
  // A single advisory transaction lock prevents concurrent migration runners.
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for(const file of ['001_initial.sql','002_automotive.sql']){
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(710341,2026)');
      const done=await client.query('SELECT 1 FROM schema_migrations WHERE name=$1',[file]);
      if(done.rowCount){await client.query('COMMIT');continue;}
      // Backward-compatible adoption of the existing Phase 2 database, which
      // predates schema_migrations. Never silently adopt an incomplete schema.
      if(file==='001_initial.sql'){
        const existing=await client.query("SELECT "+
          "to_regclass('public.companies') IS NOT NULL AS companies,"+
          "to_regclass('public.app_users') IS NOT NULL AS app_users,"+
          "to_regclass('public.memberships') IS NOT NULL AS memberships,"+
          "to_regclass('public.accounts') IS NOT NULL AS accounts,"+
          "to_regclass('public.fiscal_periods') IS NOT NULL AS fiscal_periods,"+
          "to_regclass('public.vouchers') IS NOT NULL AS vouchers,"+
          "to_regclass('public.voucher_lines') IS NOT NULL AS voucher_lines,"+
          "to_regclass('public.audit_events') IS NOT NULL AS audit_events");
        const flags=Object.values(existing.rows[0]);
        if(flags.some(Boolean)){
          if(!flags.every(Boolean))throw Error('Partially initialized legacy database: manual recovery required');
          await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);
          await client.query('COMMIT');
          console.log('Adopted existing '+file);
          continue;
        }
      }
      const url=new URL('../db/'+file,import.meta.url);
      const sql=(await readFile(fileURLToPath(url),'utf8'))
        .replace(/^\s*BEGIN;\s*$/gmi,'')
        .replace(/^\s*COMMIT;\s*$/gmi,'');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);
      await client.query('COMMIT');
      console.log('Applied '+file);
    } catch(error){await client.query('ROLLBACK');throw error;}
  }
  console.log('All AQVORA Plus schema migrations applied');
}catch(error){console.error('Migration failed:',error);process.exitCode=1;}
finally{client.release();await pool.end();}
