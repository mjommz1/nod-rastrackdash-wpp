// Manual discovery: excluded from normal Vitest glob; called only by owned runner.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import { seed, independentClient, deferred, http, activeLicense } from "./support/pipedrive-pg-harness";
import { PipedriveWebhookService } from "../src/pipedrive/pipedrive-webhook.service";
import { ConversionEventsService } from "../src/conversion-events/conversion-events.service";
import { PipedriveService } from "../src/pipedrive/pipedrive.service";
import { ConversionEventProcessor } from "../src/common/queue/conversion-event.processor";

type H = Awaited<ReturnType<typeof seed>>;
type Result = { name:string; status:"PASS"|"FAIL"; code?:string; assertions?:number };
const safe = (e:any) => /^[A-Z0-9_]{2,70}$/.test(e?.meta?.code??e?.code??"") ? (e.meta?.code??e.code) : "PRIVATE_FAILURE";
async function retire(h:H) {
  // Leave rows for inspection; prevent the global production sweep from mixing test cases.
  await h.client.pipedriveWebhookEvent.updateMany({where:{workspaceId:h.workspaceId,status:{in:["received","retry","processing"]}},data:{status:"failed",leaseToken:null,leaseExpiresAt:null,nextAttemptAt:null}});
  await h.client.pipedriveConversionDedupe.updateMany({where:{workspaceId:h.workspaceId,mode:"production"},data:{publicationNextAttemptAt:new Date("2099-01-01T00:00:00Z")}});
}
async function count(h:H) {return{canonical:await h.client.conversionEventLog.count({where:{workspaceId:h.workspaceId}}),dedupe:await h.client.pipedriveConversionDedupe.count({where:{workspaceId:h.workspaceId}})};}
async function materialize(h:H,deal=1) {const {event}=await h.receive(deal);await h.webhooks.process(event.id,h.workspaceId);await h.webhooks.sweep();const ledger=await h.client.pipedriveConversionDedupe.findFirstOrThrow({where:{workspaceId:h.workspaceId,dealId:String(deal),mode:"production"}});assert.ok(ledger.conversionEventLogId);return ledger;}
async function sqlState(client:PrismaClient,sql:string,args:unknown[],expected:string) {
  let actual="NO_ERROR";
  try {await client.$executeRawUnsafe(sql,...args);}catch(e:any){actual=e.meta?.code??e.code;}
  assert.equal(actual,expected);
}
async function waitForLock(observer:PrismaClient,pid:number) {
  const until=Date.now()+4000;
  while(Date.now()<until) {
    const r=await observer.$queryRaw<Array<{blocked:boolean}>>`SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked`;
    if(r[0]?.blocked)return;
    await new Promise(resolve=>setTimeout(resolve,15));
  }
  throw Object.assign(Error("LOCK_BARRIER_TIMEOUT"),{code:"LOCK_BARRIER_TIMEOUT"});
}
/** Locks are held by independent PG sessions; pg_blocking_pids proves actual waiting. */
async function blockRow(h:H,url:string,table:"PipedriveConnection"|"Lead",id:string,action:()=>Promise<unknown>,mutate?: (tx:any)=>Promise<unknown>) {
  const blocker=independentClient(url),observer=independentClient(url);const acquired=deferred(),release=deferred();
  const [{pid}]=await h.client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;
  const holding=blocker.$transaction(async tx=>{await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id"=$1 FOR UPDATE`,id);acquired.resolve();await release.promise;if(mutate)await mutate(tx);},{timeout:12000});
  let work:Promise<unknown>|undefined;
  try {await acquired.promise;work=action();await waitForLock(observer,pid);release.resolve();await holding;await work;}
  finally {release.resolve();await holding.catch(()=>{});if(work)await work.catch(()=>{});await Promise.all([blocker.$disconnect(),observer.$disconnect()]);}
}
export async function runMatrix(url:string,run:string,expectedMigrations:Array<{name:string;checksum:string}>) {
  const results:Result[]=[];const control=independentClient(url);
  try {
    const identity=await control.$queryRaw<Array<{db:string;role:string;super:boolean;owner:string}>>`SELECT current_database() AS db,current_user AS role,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS super,(SELECT run FROM public.pipedrive_qa_marker LIMIT 1) AS owner`;
    assert.deepEqual(identity,[{db:"pipedrive_qa",role:"qa_runtime",super:false,owner:run}]);
    async function plain(name:string,fn:()=>Promise<void>) {try{await fn();results.push({name,status:"PASS"});}catch(e){results.push({name,status:"FAIL",code:safe(e)});}}
    async function test(name:string,fn:(h:H)=>Promise<void>) {
      await plain(name,async()=>{const client=independentClient(url);let h:H|undefined;try{h=await seed(client);await fn(h);}finally{try{if(h)await retire(h);}finally{if(h)await h.app.close();await client.$disconnect();}}});
    }
    await plain("migration_chain_checksums_catalog_and_existing_triggers",async()=>{
      const migrations=await control.$queryRaw<Array<{name:string;checksum:string}>>`SELECT migration_name AS name,checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
      assert.deepEqual(migrations,expectedMigrations);
      await sqlState(control,'DELETE FROM client_reset_private.receipt WHERE false',[],"42501");
      const constraints=await control.$queryRaw<Array<{name:string}>>`SELECT conname AS name FROM pg_constraint WHERE conrelid IN ('"PipedriveConnection"'::regclass,'"PipedriveConversionRule"'::regclass,'"PipedriveWebhookEvent"'::regclass,'"PipedriveConversionDedupe"'::regclass)`;
      for(const name of ["PipedriveConnection_revision_check","PipedriveConnection_webhook_check","PipedriveConversionRule_mode_check","PipedriveWebhookEvent_state_check","PipedriveConversionDedupe_publication_check","PipedriveConversionDedupe_workspaceId_conversionEventLogId_fkey"])assert.ok(constraints.some(c=>c.name===name));
      const indexes=await control.$queryRaw<Array<{name:string}>>`SELECT indexname AS name FROM pg_indexes WHERE tablename IN ('PipedriveWebhookEvent','PipedriveConversionDedupe','ConversionEventLog')`;
      for(const name of ["PipedriveWebhookEvent_connectionId_deliveryKey_key","PipedriveConversionDedupe_semantic_mode_key","ConversionEventLog_workspace_id_key"])assert.ok(indexes.some(i=>i.name===name));
      const triggers=await control.$queryRaw<Array<{name:string}>>`SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'D'`;
      assert.ok(triggers.some(t=>t.name==="client_reset_retain_completed_audit"));
      for(const name of ["ProviderConversionDecisionAudit_append_only","ProviderConversionShadowComparison_forbid_update","ProviderConversionShadowComparison_forbid_delete"])assert.ok(triggers.some(t=>t.name===name));
    });
    const negatives:Array<[string,string,string]>=[
      ["rule_activation_null","PipedriveConversionRule",'"productionActivatedAt"=NULL'],
      ["observation_activation","PipedriveConversionRule",'"mode"=\'observation\''],
      ["invalid_mode","PipedriveConversionRule",'"mode"=\'invalid\''],
      ["processing_without_lease","PipedriveWebhookEvent",'"status"=\'processing\',"nextAttemptAt"=NULL'],
      ["received_without_next","PipedriveWebhookEvent",'"nextAttemptAt"=NULL'],
      ["retry_without_next","PipedriveWebhookEvent",'"status"=\'retry\',"nextAttemptAt"=NULL'],
      ["nonprocessing_with_lease","PipedriveWebhookEvent",'"leaseToken"=\'qa\',"leaseExpiresAt"=now()'],
      ["partial_lease_null","PipedriveWebhookEvent",'"status"=\'processing\',"leaseToken"=\'qa\',"leaseExpiresAt"=NULL'],
      ["value_present_null","PipedriveWebhookEvent",'"valueCents"=NULL,"valuePresent"=true'],
      ["value_present_false","PipedriveWebhookEvent",'"valuePresent"=false'],
      ["generation_zero","PipedriveWebhookEvent",'"credentialGeneration"=0'],
      ["secret_version_zero","PipedriveWebhookEvent",'"webhookSecretVersion"=0'],
      ["negative_attempts","PipedriveWebhookEvent",'"attempts"=-1'],
      ["revision_negative","PipedriveConnection",'"mutationRevision"=-1'],
      ["connection_generation_zero","PipedriveConnection",'"credentialGeneration"=0'],
    ];
    for(const [name,table,set] of negatives)await test("sql_check_"+name,async h=>{const {event}=await h.receive();await sqlState(h.client,`UPDATE "${table}" SET ${set} WHERE "id"=$1`,[table==="PipedriveConnection"?h.c.id:table==="PipedriveConversionRule"?h.rule.id:event.id],"23514");});
    await test("sql_positive_null_pairs_and_inactive_production",async h=>{
      const {event}=await h.receive();await h.client.pipedriveWebhookEvent.update({where:{id:event.id},data:{valueCents:null,valuePresent:false}});
      await h.client.pipedriveConversionRule.update({where:{id:h.rule.id},data:{active:false,productionActivatedAt:null}});
      await h.client.pipedriveConversionRule.update({where:{id:h.rule.id},data:{mode:"observation",productionActivatedAt:null,active:true}});
    });
    const publications:Array<[string,string]>=[
      ["sender_two",'"senderAttempts"=2'],["sender_retry",'"senderRetryable"=true'],["sender_lease_no_attempt",'"senderLeaseToken"=\'qa\''],
      ["intent_array",'"publicationIntent"=\'[]\'::jsonb'],["intent_sql_null",'"publicationIntent"=NULL'],["intent_json_null",'"publicationIntent"=\'null\'::jsonb'],
      ["canonical_null",'"conversionEventLogId"=NULL'],["publication_invalid",'"publicationStatus"=\'invalid\''],["publication_attempts_negative",'"publicationAttempts"=-1'],
      ["publication_half_lease",'"publicationLeaseToken"=\'qa\',"publicationLeaseExpiresAt"=NULL'],["observation_has_canonical",'"mode"=\'observation\''],
    ];
    for(const [name,set] of publications)await test("sql_publication_"+name,async h=>{const d=await materialize(h);await sqlState(h.client,`UPDATE "PipedriveConversionDedupe" SET ${set} WHERE "id"=$1`,[d.id],"23514");});
    await test("sql_positive_publication_states_and_complete_lease_pairs",async h=>{
      const d=await materialize(h);
      for(const status of ["materialized","publication_pending","queued","sent","revoked","publication_failed","delivery_unknown"])await h.client.pipedriveConversionDedupe.update({where:{id:d.id},data:{publicationStatus:status}});
      await h.client.pipedriveConversionDedupe.update({where:{id:d.id},data:{publicationLeaseToken:"qa",publicationLeaseExpiresAt:new Date(+h.now+90000),senderAttempts:1,senderLeaseToken:"qa",senderRetryable:false}});
      await h.client.pipedriveConversionDedupe.update({where:{id:d.id},data:{publicationLeaseToken:null,publicationLeaseExpiresAt:null}});
    });
    await test("sql_compound_foreign_keys_and_restrict",async h=>{
      const {event}=await h.receive();await sqlState(h.client,'UPDATE "PipedriveWebhookEvent" SET "matchedLeadId"=$1 WHERE "id"=$2',[h.foreignLead.id,event.id],"23503");
      await sqlState(h.client,'UPDATE "PipedrivePipelineCatalog" SET "workspaceId"=$1 WHERE "connectionId"=$2',[h.foreignId,h.c.id],"23503");
      await sqlState(h.client,'UPDATE "PipedriveStageCatalog" SET "workspaceId"=$1 WHERE "connectionId"=$2',[h.foreignId,h.c.id],"23503");
      await sqlState(h.client,'UPDATE "PipedriveConversionRule" SET "workspaceId"=$1 WHERE "id"=$2',[h.foreignId,h.rule.id],"23503");
      await sqlState(h.client,'UPDATE "PipedriveWebhookEvent" SET "workspaceId"=$1 WHERE "id"=$2',[h.foreignId,event.id],"23503");
      await h.webhooks.process(event.id,h.workspaceId);const d=await h.client.pipedriveConversionDedupe.findFirstOrThrow({where:{workspaceId:h.workspaceId}});
      const foreign=await h.client.conversionEventLog.create({data:{workspaceId:h.foreignId,sourceTrigger:"qa",eventName:"QualifiedLead",status:"queued"}});
      await sqlState(h.client,'UPDATE "PipedriveConversionDedupe" SET "conversionEventLogId"=$1 WHERE "id"=$2',[foreign.id,d.id],"23503");
      await sqlState(h.client,'UPDATE "PipedriveConversionDedupe" SET "dealId"=\'other\' WHERE "id"=$1',[d.id],"23503");
      await sqlState(h.client,'DELETE FROM "PipedriveWebhookEvent" WHERE "id"=$1',[event.id],"23503");
      await sqlState(h.client,'DELETE FROM "ConversionEventLog" WHERE "id"=$1',[d.conversionEventLogId],"23503");
      await sqlState(h.client,'DELETE FROM "PipedriveConnection" WHERE "id"=$1',[h.c.id],"23503");
    });
    await test("sql_delivery_unique_and_mode_separation",async h=>{
      const {event}=await h.receive();const {id,createdAt,updatedAt,...data}=event;
      let code="";try{await h.client.pipedriveWebhookEvent.create({data:{...data,results:data.results as Prisma.InputJsonValue}});}catch(e:any){code=e.code;}assert.equal(code,"P2002");
      await h.webhooks.process(event.id,h.workspaceId);const d=await h.client.pipedriveConversionDedupe.findFirstOrThrow({where:{workspaceId:h.workspaceId}});
      await h.client.pipedriveConversionDedupe.create({data:{workspaceId:h.workspaceId,sourceEventId:event.id,verifiedAccountId:d.verifiedAccountId,dealId:d.dealId,eventName:d.eventName,mode:"observation"}});
      assert.equal((await count(h)).dedupe,2);
      await sqlState(h.client,'UPDATE "PipedriveConversionDedupe" SET "mode"=\'production\',"conversionEventLogId"=$1,"publicationIntent"=\'{}\'::jsonb,"publicationStatus"=\'materialized\' WHERE "workspaceId"=$2 AND "mode"=\'observation\'',[d.conversionEventLogId,h.workspaceId],"23505");
    });
    await test("two_sessions_same_receipt_and_same_lease",async h=>{
      const b=independentClient(url);try{
        const pidA=await h.client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;const pidB=await b.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;assert.notEqual(pidA[0].pid,pidB[0].pid);
        const svc=new PipedriveService(b as any,(h.service as any).adapter);svc.now=()=>h.now;
        const worker=new PipedriveWebhookService(b as any,(h.service as any).adapter,svc,h.conversions,h.queue);worker.now=()=>h.now;
        const body=Buffer.from(JSON.stringify(h.payload(1,"same-delivery")));
        await Promise.all([h.webhooks.receive(h.c.id,h.secret,body,"application/json"),worker.receive(h.c.id,h.secret,body,"application/json")]);
        assert.equal(await h.client.pipedriveWebhookEvent.count({where:{workspaceId:h.workspaceId}}),1);
        const event=await h.client.pipedriveWebhookEvent.findFirstOrThrow({where:{workspaceId:h.workspaceId}});
        const before=await h.client.lead.findUniqueOrThrow({where:{id:h.lead.id}});
        await Promise.all([h.webhooks.process(event.id,h.workspaceId),worker.process(event.id,h.workspaceId)]);
        assert.deepEqual(await count(h),{canonical:1,dedupe:1});assert.equal(h.personCalls,1);
        assert.deepEqual(await h.client.lead.findUniqueOrThrow({where:{id:h.lead.id}}),before);
      }finally{await b.$disconnect();}
    });
    await test("two_sessions_distinct_receipts_same_semantic",async h=>{
      const b=independentClient(url);try{const svc=new PipedriveService(b as any,(h.service as any).adapter);svc.now=()=>h.now;const worker=new PipedriveWebhookService(b as any,(h.service as any).adapter,svc,h.conversions,h.queue);worker.now=()=>h.now;
        const a=await h.receive(1,"semantic-a"),c=await h.receive(1,"semantic-b");
        await Promise.all([h.webhooks.process(a.event.id,h.workspaceId),worker.process(c.event.id,h.workspaceId)]);
        h.setNow(new Date(+h.now+120000));await h.webhooks.sweep();assert.deepEqual(await count(h),{canonical:1,dedupe:1});const events=await h.client.pipedriveWebhookEvent.findMany({where:{workspaceId:h.workspaceId}});assert.equal(events.length,2);assert.ok(events.every(e=>["materialized","duplicate"].includes(e.status)));
      }finally{await b.$disconnect();}
    });
    await test("expired_lease_reclaim_and_old_completion_fenced",async h=>{
      const started=deferred(),release=deferred();let first=true;
      h.setPersonHook(async()=>{if(first){first=false;started.resolve();await release.promise;}});
      const {event}=await h.receive();const old=h.webhooks.process(event.id,h.workspaceId);
      try{await started.promise;h.setNow(new Date(+h.now+120000));const reclaimed=await h.webhooks.process(event.id,h.workspaceId);release.resolve();assert.equal((await old).status,"lease_lost");assert.ok(["materialized","duplicate"].includes(reclaimed.status));assert.deepEqual(await count(h),{canonical:1,dedupe:1});const row=await h.client.pipedriveWebhookEvent.findUniqueOrThrow({where:{id:event.id}});assert.equal(row.attempts,2);assert.equal(row.leaseToken,null);}finally{release.resolve();await old.catch(()=>{});}
    });
    await plain("real_transaction_completion_failure_rolls_back_all_materialization",async()=>{
      const real=independentClient(url);let inject=true;const extended=real.$extends({query:{pipedriveWebhookEvent:{async updateMany({args,query}){const out=await query(args);if(inject&&args.data.status==="materialized")throw Object.assign(Error("INJECTED_COMPLETION_FAILURE"),{code:"INJECTED_COMPLETION_FAILURE"});return out;}}}});
      let h:H|undefined;try{h=await seed(extended as any);const {event}=await h.receive();await assert.rejects(h.webhooks.process(event.id,h.workspaceId),(e:any)=>e.getStatus?.()===503);assert.deepEqual(await count(h),{canonical:0,dedupe:0});const row=await real.pipedriveWebhookEvent.findUniqueOrThrow({where:{id:event.id}});assert.equal(row.status,"processing");assert.equal(row.matchedLeadId,null);assert.deepEqual(row.results,[]);inject=false;h.setNow(new Date(+h.now+120000));await h.webhooks.process(event.id,h.workspaceId);assert.deepEqual(await count(h),{canonical:1,dedupe:1});}finally{try{if(h)await retire(h);}finally{if(h)await h.app.close();await real.$disconnect();}}
    });
    await test("publication_failure_restart_reuses_canonical",async h=>{
      h.setQueueFailure(true);const d=await materialize(h);assert.equal(h.jobs.size,0);h.setQueueFailure(false);h.setNow(new Date(+h.now+120000));
      const restarted=new PipedriveWebhookService(h.client as any,(h.service as any).adapter,h.service,h.conversions,h.queue,activeLicense as any);restarted.now=()=>h.now;await restarted.sweep();
      const after=await h.client.pipedriveConversionDedupe.findUniqueOrThrow({where:{id:d.id}});assert.equal(after.conversionEventLogId,d.conversionEventLogId);assert.equal(after.publicationStatus,"queued");assert.equal(h.jobs.size,1);assert.deepEqual(await count(h),{canonical:1,dedupe:1});
    });
    await test("concurrent_sender_and_persistent_unknown_no_resend",async h=>{
      const d=await materialize(h);const b=independentClient(url);const other=new ConversionEventsService(b as any,(h.conversions as any).metaCapiAdapter,(h.conversions as any).metaTokenEncryption,(h.conversions as any).connectionResolver,activeLicense as any);const started=deferred(),release=deferred();h.setMetaHook(async()=>{started.resolve();await release.promise;throw Error("SYNTHETIC_RESPONSE_LOST");});
      const first=h.conversions.sendReadyEvent(d.conversionEventLogId!,{workspaceId:h.workspaceId});
      try{await started.promise;await other.sendReadyEvent(d.conversionEventLogId!,{workspaceId:h.workspaceId});release.resolve();await first;assert.equal(h.metaCalls,1);h.setMetaHook(undefined);await h.conversions.sendReadyEvent(d.conversionEventLogId!,{workspaceId:h.workspaceId});assert.equal(h.metaCalls,1);const after=await h.client.pipedriveConversionDedupe.findUniqueOrThrow({where:{id:d.id}});assert.equal(after.publicationStatus,"delivery_unknown");assert.equal(after.senderAttempts,1);assert.equal(after.senderRetryable,false);}finally{release.resolve();await first.catch(()=>{});await b.$disconnect();}
    });
    await test("crash_after_persisted_sender_claim_no_fetch_on_restart",async h=>{
      const d=await materialize(h);await h.client.pipedriveConversionDedupe.update({where:{id:d.id},data:{senderAttempts:1,senderLeaseToken:randomUUID()}});
      assert.equal(await h.conversions.preparePipedriveSenderRetry(d.conversionEventLogId!,h.workspaceId),"delivery_unknown");await h.conversions.sendReadyEvent(d.conversionEventLogId!,{workspaceId:h.workspaceId});assert.equal(h.metaCalls,0);const after=await h.client.pipedriveConversionDedupe.findUniqueOrThrow({where:{id:d.id}});assert.equal(after.publicationStatus,"delivery_unknown");
    });
    await test("connection_row_lock_revocation_blocks_materialization",async h=>{const {event}=await h.receive();await blockRow(h,url,"PipedriveConnection",h.c.id,()=>h.webhooks.process(event.id,h.workspaceId),tx=>tx.pipedriveConnection.update({where:{id:h.c.id},data:{status:"paused"}}));assert.deepEqual(await count(h),{canonical:0,dedupe:0});});
    await test("lead_row_lock_status_rechecked",async h=>{const {event}=await h.receive();await blockRow(h,url,"Lead",h.lead.id,()=>h.webhooks.process(event.id,h.workspaceId),tx=>tx.lead.update({where:{id:h.lead.id},data:{status:"lost"}}));assert.deepEqual(await count(h),{canonical:0,dedupe:0});});
    await test("dispatch_row_lock_revocation_rechecked_before_fetch",async h=>{const d=await materialize(h);await blockRow(h,url,"PipedriveConnection",h.c.id,()=>h.conversions.sendReadyEvent(d.conversionEventLogId!,{workspaceId:h.workspaceId}),tx=>tx.pipedriveConnection.update({where:{id:h.c.id},data:{status:"paused"}}));h.setNow(new Date(+h.now+120000));await h.webhooks.sweep();assert.equal(h.metaCalls,0);assert.equal((await h.client.pipedriveConversionDedupe.findUniqueOrThrow({where:{id:d.id}})).publicationStatus,"revoked");});
    await test("real_nest_durable_202_tick_processor_scoping_and_replay",async h=>{
      const cap=await http(h.app,"GET",h.base+"/capabilities");assert.equal(cap.status,200);assert.equal(cap.body.productionEnabled,true);
      assert.equal((await http(h.app,"PATCH",h.base+"/rules/"+h.rule.id,{mode:"observation"})).status,200);
      const activated=await http(h.app,"PATCH",h.base+"/rules/"+h.rule.id,{mode:"production"});assert.equal(activated.status,200);assert.equal(activated.body.mode,"production");assert.ok(activated.body.productionActivatedAt);
      const oldSecret=h.secret;const rotated=await http(h.app,"POST",h.base+"/webhook-secret/rotate");assert.equal(rotated.status,201);const secret=new URL(rotated.body.webhookUrl).searchParams.get("token")!;assert.notEqual(secret,oldSecret);
      h.setNow(new Date(+h.now+1000));const body=h.payload(1,"api-delivery");const route=`/webhooks/pipedrive/v1/${h.c.id}?token=${secret}`;
      const accepted=await http(h.app,"POST",route,body);assert.equal(accepted.status,202);assert.equal(h.personCalls,0);assert.deepEqual(await count(h),{canonical:0,dedupe:0});assert.equal(await h.client.pipedriveWebhookEvent.count({where:{workspaceId:h.workspaceId}}),1);
      await h.webhooks.sweep();const d=await h.client.pipedriveConversionDedupe.findFirstOrThrow({where:{workspaceId:h.workspaceId}});const processor=new ConversionEventProcessor(h.conversions,h.client as any);
      const sent=await processor.process({id:"synthetic-job",name:"send-ready-event",data:{conversionEventLogId:d.conversionEventLogId,workspaceId:h.workspaceId},attemptsMade:0} as any);assert.equal(sent.status,"sent");assert.equal(h.metaCalls,1);
      const visible=await http(h.app,"GET",h.base+"/events");assert.equal(visible.status,200);assert.equal(visible.body[0].results[0].deliveryStatus,"sent");
      assert.equal((await http(h.app,"POST",route,body)).status,202);await h.webhooks.sweep();assert.deepEqual(await count(h),{canonical:1,dedupe:1});assert.equal(h.metaCalls,1);
      h.session.workspaces[0].role="member";assert.equal((await http(h.app,"PATCH",h.base+"/status",{status:"paused"})).status,403);
      h.session.workspaces=[{id:h.foreignId,role:"owner"}];assert.equal((await http(h.app,"GET",h.base+"/events")).status,403);
      assert.equal((await http(h.app,"GET",`/workspaces/${h.foreignId}/pipedrive/connections/${h.c.id}/events`)).status,404);
      assert.equal((await http(h.app,"POST",`/webhooks/pipedrive/v1/${h.c.id}?token=${oldSecret}`,body)).status,404);
    });
    await plain("real_nest_scoped_404_vs_injected_storage_503",async()=>{
      const real=independentClient(url);let fault=false;
      const extended=real.$extends({query:{pipedriveConnection:{async findFirst({args,query}){if(fault)throw Error("SYNTHETIC_STORAGE_FAULT");return query(args);}}}});
      let h:H|undefined;try{h=await seed(extended as any);assert.equal((await http(h.app,"GET",h.base.replace(h.c.id,"missing")+"/capabilities")).status,404);fault=true;assert.equal((await http(h.app,"GET",h.base+"/capabilities")).status,503);assert.equal(h.personCalls,0);assert.equal(h.metaCalls,0);}finally{fault=false;try{if(h)await retire(h);}finally{if(h)await h.app.close();await real.$disconnect();}}
    });
    // The SaaS client-swap reset case is not ported: the student edition has no client swap.
  }finally{await control.$disconnect();}
  return{phase:"postgresql_nest",mocks:["auth session","Pipedrive adapter","BullMQ handoff","Meta resolver","Meta fetch response"],results,passed:results.filter(r=>r.status==="PASS").length,failed:results.filter(r=>r.status==="FAIL").length,skipped:0};
}
