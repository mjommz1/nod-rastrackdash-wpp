import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { PrismaClient } from "@prisma/client";
import { PipedriveController } from "../../src/pipedrive/pipedrive.controller";
import { PipedriveWebhookController } from "../../src/pipedrive/pipedrive-webhook.controller";
import { PipedriveService } from "../../src/pipedrive/pipedrive.service";
import { PipedriveWebhookService } from "../../src/pipedrive/pipedrive-webhook.service";
import { PipedriveAdapter } from "../../src/pipedrive/pipedrive.adapter";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { AuthService } from "../../src/auth/auth.service";
import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";
import { ConversionEventsQueueService } from "../../src/common/queue/conversion-events-queue.service";
import { MetaConnectionResolverService } from "../../src/integrations/meta/meta-connection-resolver.service";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import { INTEGRATION_ENV } from "../../src/integrations/integration.types";
import { MetaCapiAdapter } from "../../src/conversion-events/meta-capi.adapter";
import { configureInboundWebhookBodyParser } from "../../src/inbound-webhooks/inbound-webhook-body-parser";
import { hashPhoneIdentity } from "../../src/common/phone/phone-identity";
import { LicenseClientService } from "../../src/licensing-client/license-client.service";
import { RUNTIME_ENV } from "../../src/common/runtime/runtime.module";

/** Active license (student edition): background Pipedrive work requires it. */
export const activeLicense = { getLockState: async () => ({ inert: false, locked: false, reason: null, state: { status: "active" } }) };

/** Explicit invocation only. No in-memory Prisma delegates, no AppModule, timers or Redis. */
export function independentClient(url: string) {
  return new PrismaClient({ datasources: { db: { url } }, log: [] });
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
export async function http(app: NestExpressApplication, method: string, url: string, data?: unknown) {
  const body = data === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(data));
  const chunks: Buffer[] = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  const req = new IncomingMessage(socket as any);
  req.method = method; req.url = url; req.httpVersion = "1.1";
  req.headers = { "content-type": "application/json", "content-length": String(body.length), authorization: "Bearer synthetic-session" };
  const res = new ServerResponse(req); res.assignSocket(socket as any);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("HTTP_TIMEOUT"), {code:"HTTP_TIMEOUT"})), 5000);
      res.once("finish", resolve); res.once("error", reject);
    });
    app.getHttpAdapter().getInstance()(req, res); req.complete = true; req.push(body); req.push(null);
    await completed;
    const raw = Buffer.concat(chunks).toString().split("\r\n\r\n").slice(1).join("\r\n\r\n");
    return { status: res.statusCode, body: raw ? JSON.parse(raw) : null };
  } finally { if (timer) clearTimeout(timer); socket.destroy(); }
}
export async function narrowApplication(client: PrismaClient, boundaries: {adapter:any;queue:ConversionEventsQueueService;resolver:any;session:any;fetcher:any}) {
  const {adapter,queue,resolver,session,fetcher}=boundaries;
  const mod=await Test.createTestingModule({controllers:[PipedriveController,PipedriveWebhookController],providers:[PipedriveService,PipedriveWebhookService,ConversionEventsService,{provide:PrismaService,useValue:client},{provide:AuthService,useValue:{getSession:async()=>session}},{provide:PipedriveAdapter,useValue:adapter},{provide:ConversionEventsQueueService,useValue:queue},{provide:MetaConnectionResolverService,useValue:resolver},{provide:MetaTokenEncryptionService,useValue:{}},{provide:INTEGRATION_ENV,useValue:process.env},{provide:RUNTIME_ENV,useValue:process.env},{provide:LicenseClientService,useValue:activeLicense},{provide:MetaCapiAdapter,useValue:new MetaCapiAdapter({},fetcher as any)}]}).compile();
  const app=mod.createNestApplication<NestExpressApplication>({bodyParser:false,logger:false});configureInboundWebhookBodyParser(app);await app.init();
  return {mod,app};
}

export async function seed(client: PrismaClient, suffix = randomUUID()) {
  const workspaceId = `qa-${suffix}`; const foreignId = `qa-foreign-${suffix}`;
  const owner = await client.user.create({ data: { email: `${suffix}@example.invalid`, name: "Synthetic QA owner" } });
  await client.workspace.create({ data: { id:workspaceId, slug:workspaceId, name:"Synthetic fixture", members:{ create:{userId:owner.id,role:"owner"} } } });
  await client.workspace.create({ data: { id:foreignId,slug:foreignId,name:"Synthetic foreign fixture" } });
  const instance = await client.whatsappInstance.create({data:{ workspaceId,name:"Fixture",provider:"gupshup",status:"active" }});
  const parser = await client.inboundWebhookParserRelease.upsert({where:{provider_version:{provider:"gupshup",version:"qa-"+suffix}},create:{provider:"gupshup",version:"qa-"+suffix,status:"certified",certifiedAt:new Date()},update:{}});
  const activeAt = new Date(Date.now()-10000);
  const inbound = await client.inboundWebhookConnection.create({data:{workspaceId,provider:"gupshup",displayName:"Synthetic",parserReleaseId:parser.id,status:"production",productionActivatedAt:activeAt}});
  const channel = await client.inboundWebhookChannel.create({data:{workspaceId,connectionId:inbound.id,organizationId:"qa",providerChannelId:suffix,connectedPhone:"5500000000000",status:"active",productionActivatedAt:activeAt,whatsappInstanceId:instance.id}});
  const credential = await client.metaCredential.create({data:{workspaceId,source:"manual",label:"Synthetic",encryptedAccessToken:"fixture",tokenIv:"fixture",tokenTag:"fixture",fingerprint:suffix,tokenLast4:"0000",scopes:[],status:"active"}});
  const business = await client.metaBusinessConnection.create({data:{workspaceId,credentialId:credential.id,businessManagerId:suffix,businessManagerName:"Synthetic",status:"active"}});
  const destination = await client.metaConversionDestination.create({data:{workspaceId,pixelId:"synthetic-pixel",pixelName:"Synthetic",pageId:"synthetic-page",pageName:"Synthetic",status:"configured"}});
  const reporting = await client.metaReportingAccount.create({data:{workspaceId,businessId:suffix,businessName:"Synthetic",adAccountId:"act_synthetic",adAccountName:"Synthetic",businessConnectionId:business.id,conversionDestinationId:destination.id}});
  const route = await client.inboundWebhookChannelRoute.create({data:{workspaceId,channelId:channel.id,routeKey:suffix,active:true,validationStatus:"valid",metaBusinessConnectionWorkspaceId:workspaceId,metaBusinessConnectionId:business.id,metaReportingAccountWorkspaceId:workspaceId,metaReportingAccountId:reporting.id,metaConversionDestinationWorkspaceId:workspaceId,metaConversionDestinationId:destination.id}});
  await client.metaAd.create({data:{workspaceId,adId:"synthetic-ad",campaignId:"synthetic-campaign",adSetId:"synthetic-adset",name:"Synthetic"}});
  await client.metaAdDestinationAssignment.create({data:{workspaceId,adId:"synthetic-ad",reportingAccountId:reporting.id,conversionDestinationId:destination.id}});
  const lead = await client.lead.create({data:{workspaceId,whatsappInstanceId:instance.id,phoneHash:hashPhoneIdentity("5500000000000")!,adId:"synthetic-ad",campaignId:"synthetic-campaign",adSetId:"synthetic-adset",ctwaClid:"synthetic-existing-ctwa",firstMessageAt:activeAt,lastMessageAt:activeAt}});
  const foreignLead=await client.lead.create({data:{workspaceId:foreignId,phoneHash:"synthetic-foreign"}});
  let personCalls=0, metaCalls=0; let personHook: (()=>Promise<void>)|undefined;
  let metaHook: (()=>Promise<void>)|undefined; let queueFailure=false;
  const adapter = { verify:async()=>({id:"1",subdomain:"synthetic"}),listPipelines:async()=>[{id:"1",name:"Synthetic",stages:[{id:"11",name:"Won"},{id:"12",name:"Before"}]}],getPerson:async(_origin:string,_token:string,id:string)=>{personCalls++;if(personHook)await personHook();return{id,phones:["5500000000000"]};} };
  const resolver={hasNormalizedConnections:async()=>true,resolveCapiRoute:async()=>({source:"manual",accessToken:"synthetic-only",pixelId:destination.pixelId,pageId:destination.pageId,reportingAccountId:reporting.id,adAccountId:reporting.adAccountId,businessConnectionId:business.id,conversionDestinationId:destination.id})};
  const fetcher=async()=>{metaCalls++;if(metaHook)await metaHook();return new Response('{"events_received":1,"messages":[],"fbtrace_id":"synthetic-trace"}',{status:200});};
  const jobs=new Map<string,unknown>();
  const queue=new ConversionEventsQueueService({getJob:async()=>null,add:async(_name:string,data:any,options:any)=>{if(queueFailure)throw Error("SYNTHETIC_QUEUE_FAILURE");jobs.set(options.jobId,data);return{id:options.jobId};}} as any);
  const session:any={user:{id:owner.id,platformRole:"user"},workspaces:[{id:workspaceId,role:"owner"}],supportContext:null};
  const {mod,app}=await narrowApplication(client,{adapter,queue,resolver,session,fetcher});
  const service=mod.get(PipedriveService); const webhooks=mod.get(PipedriveWebhookService);const conversions=mod.get(ConversionEventsService);
  let now=new Date();service.now=()=>now;webhooks.now=()=>now;
  const actor={userId:owner.id,type:"user" as const};
  const c=await service.create(workspaceId,actor,{displayName:"Synthetic CRM",accountOrigin:"https://synthetic.pipedrive.com",apiToken:"synthetic-token-123456",allowedChannelRouteIds:[route.id]});
  const base=`/workspaces/${workspaceId}/pipedrive/connections/${c.id}`;
  const rotated=await http(app,"POST",base+"/webhook-secret/rotate");
  if(rotated.status!==201)throw Object.assign(Error("ROTATE_HTTP_FAILED"),{code:"ROTATE_HTTP_FAILED"});
  const secret=new URL(rotated.body.webhookUrl).searchParams.get("token")!;
  const rule=await webhooks.createRule(workspaceId,c.id,actor,{name:"Synthetic production",pipelineId:"1",stageId:"11",eventName:"QualifiedLead",mode:"production",active:true,valueMode:"deal"});
  now=new Date(+now+1000);
  function payload(deal=1,delivery:string=randomUUID()) {return{meta:{action:"change",entity:"deal",version:"2.0",company_id:1,host:"synthetic.pipedrive.com",id:delivery,timestamp:now.toISOString()},data:{id:deal,pipeline_id:1,stage_id:11,person_id:1,value:12.5,currency:"BRL"},previous:{stage_id:12}};}
  async function receive(deal=1,delivery:string=randomUUID()) { const result=await webhooks.receive(c.id,secret,Buffer.from(JSON.stringify(payload(deal,delivery))),"application/json"); const event=await client.pipedriveWebhookEvent.findFirstOrThrow({where:{workspaceId,connectionId:c.id,dealId:String(deal)},orderBy:{createdAt:"desc"}});return{result,event}; }
  return{client,app,workspaceId,foreignId,foreignLead,owner,actor,c,base,secret,rule,lead,route,session,service,webhooks,conversions,queue,jobs,payload,receive,get now(){return now;},setNow:(v:Date)=>{now=v;},get personCalls(){return personCalls;},get metaCalls(){return metaCalls;},setPersonHook:(v:typeof personHook)=>{personHook=v;},setMetaHook:(v:typeof metaHook)=>{metaHook=v;},setQueueFailure:(v:boolean)=>{queueFailure=v;}};
}
