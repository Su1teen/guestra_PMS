import {createRequire} from "node:module";
const postgres=createRequire(new URL("../packages/database/package.json",import.meta.url))("postgres");
import {readFile} from "node:fs/promises";
import {createHash,randomUUID} from "node:crypto";
const url=process.env.DATABASE_URL,environment=process.env.INTEGRATION_ENVIRONMENT;
if(!url)throw new Error("Explicit DATABASE_URL is required");
const target=new URL(url);
if(!["test","sandbox"].includes(environment)||!["localhost","127.0.0.1","[::1]"].includes(target.hostname)||!/_integration_test$|_sandbox$/.test(target.pathname))
 throw new Error("Automated setup only supports explicitly named loopback test/sandbox databases. Production requires a reviewed manual DBA migration.");
const name="0001_domain_event_capture_v2.sql";
const sql=await readFile(new URL("../integration-migrations/"+name,import.meta.url),"utf8");
const digest=createHash("sha256").update(sql).digest("hex");
const pool=postgres(url,{max:1});
const execute=async(body)=>pool.begin(async tx=>body(async(query,params=[])=>tx.unsafe(query,params)));
try {
 await execute(async query=>{
  await query("CREATE TABLE IF NOT EXISTS guestra_integration_migrations(name text PRIMARY KEY,digest text NOT NULL,installed_at timestamptz NOT NULL DEFAULT now())");
  const result=await query("SELECT digest FROM guestra_integration_migrations WHERE name=$1 FOR UPDATE",[name]);
  const rows=result.rows??result;
  if(rows[0]&&rows[0].digest!==digest)throw new Error("Migration checksum changed; review a new version instead of rewriting a deployed migration");
  if(!rows.length){await query(sql);await query("INSERT INTO guestra_integration_migrations(name,digest) VALUES($1,$2)",[name,digest]);}
  const marker=await query("SELECT environment FROM guestra_integration_deployment");
  const markers=marker.rows??marker;
  if(markers[0]&&markers[0].environment!==environment)throw new Error("Database environment attestation mismatch");
  await query("INSERT INTO guestra_integration_deployment(id,environment,deployment_id) VALUES(true,$1,$2) ON CONFLICT(id) DO NOTHING",[environment,randomUUID()]);
 });
 console.log("Optional integration migration verified on isolated "+environment+" database.");
}finally{await pool.end();}
