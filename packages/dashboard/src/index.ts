import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Logger } from "pino";
import type { OperatorPolicySettings } from "../../shared/src/index.js";
import type { OperatorStore } from "../../storage/src/index.js";

export interface DashboardServerOptions {
  store: OperatorStore;
  logger: Logger;
  port?: number;
  getPolicy: () => OperatorPolicySettings;
  updatePolicy: (patch: Partial<OperatorPolicySettings>, updatedBy: string) => OperatorPolicySettings;
  health: () => Promise<Record<string, unknown>>;
}

export class DashboardServer {
  private readonly token = randomBytes(32).toString("base64url");
  private server: ReturnType<typeof createServer> | undefined;
  private baseUrl: string | undefined;

  constructor(private readonly options: DashboardServerOptions) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("dashboard did not bind a TCP port");
    this.server = server;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    this.options.logger.info({ dashboard: this.baseUrl }, "Loopback Operator dashboard ready");
  }

  link(): string | undefined {
    return this.baseUrl ? `${this.baseUrl}/#token=${encodeURIComponent(this.token)}` : undefined;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.baseUrl = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, securityHeaders("text/html; charset=utf-8"));
        response.end(DASHBOARD_HTML);
        return;
      }
      if (!this.authorized(request)) {
        this.json(response, 401, { error: "invalid_or_missing_dashboard_capability" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        this.json(response, 200, await this.state());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/policy") {
        const body = await readJsonBody(request, 16_000);
        const policy = this.options.updatePolicy(body as Partial<OperatorPolicySettings>, "dashboard");
        this.options.store.appendEvent("policy.updated", { payload: { source: "dashboard" } });
        this.json(response, 200, { policy });
        return;
      }
      this.json(response, 404, { error: "not_found" });
    } catch (error) {
      this.options.logger.warn({ errorCode: "DASHBOARD_REQUEST_FAILED" }, "Dashboard request failed");
      this.json(response, 400, { error: error instanceof Error ? error.message.slice(0, 300) : "invalid_request" });
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    return header === `Bearer ${this.token}`;
  }

  private async state(): Promise<Record<string, unknown>> {
    const threads = this.options.store.listThreads();
    const automations = this.options.store.listAutomations();
    const outbox = this.options.store.telegramOutboxCounts();
    const recentEvents = this.options.store.db
      .prepare("SELECT event_type,created_at FROM daemon_events ORDER BY created_at DESC LIMIT 12")
      .all() as Array<{ event_type: string; created_at: string }>;
    return {
      generatedAt: new Date().toISOString(),
      health: await this.options.health(),
      counts: {
        projects: this.options.store.listProjects().length,
        threads: threads.length,
        activeWorkers: threads.filter((thread) => ["queued", "running", "waiting_approval", "waiting_user"].includes(thread.status)).length,
        teamMembers: this.options.store.listTeamMembers().length,
        automations: automations.filter((item) => item.status === "active").length,
        outboxPending: outbox.pending + outbox.sending,
      },
      policy: this.options.getPolicy(),
      automations: automations.slice(0, 20).map((item) => ({
        id: item.id,
        name: item.name,
        status: item.status,
        nextRunAt: item.nextRunAt,
        lastRunAt: item.lastRunAt,
      })),
      providers: this.options.store.listProviderPerformance(),
      recentEvents: recentEvents.map((event) => ({ type: event.event_type, at: event.created_at })),
    };
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
    response.end(JSON.stringify(value));
  }
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  };
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>T3 Operator cockpit</title>
<style>
:root{--fog:#eef5f5;--paper:#fbfdfc;--ink:#15343b;--muted:#60777c;--line:#c8d8d8;--telegram:#229ed9;--signal:#ff6b4a;--moss:#3d7b5a;--shadow:0 18px 50px rgba(21,52,59,.09)}
*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--fog);font-family:Charter,"Iowan Old Style",Georgia,serif}button,input{font:inherit}.shell{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:32px 0 64px}
.mast{display:grid;grid-template-columns:1.3fr .7fr;gap:28px;align-items:end;margin-bottom:26px}.eyebrow,.label{font:700 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.15em;text-transform:uppercase;color:var(--muted)}h1{font:650 clamp(48px,8vw,94px)/.82 "Avenir Next Condensed","Arial Narrow",sans-serif;letter-spacing:-.045em;margin:12px 0 0;max-width:760px}.lede{font-size:18px;line-height:1.45;margin:0;border-left:3px solid var(--signal);padding-left:18px}
.rail{position:relative;background:var(--ink);color:white;padding:18px 22px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px;box-shadow:var(--shadow);overflow:hidden}.rail:before{content:"";position:absolute;left:12%;right:12%;top:35px;height:1px;background:rgba(255,255,255,.35)}.node{position:relative;font:700 11px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;text-align:center}.node:before{content:"";display:block;width:13px;height:13px;border:3px solid var(--ink);outline:1px solid rgba(255,255,255,.55);background:var(--telegram);border-radius:50%;margin:10px auto 16px}.node:nth-child(2):before{background:var(--signal);animation:pulse 2.4s ease-in-out infinite}.node:nth-child(3):before{background:#8ed0aa}@keyframes pulse{50%{box-shadow:0 0 0 8px rgba(255,107,74,.2)}}
.grid{display:grid;grid-template-columns:1.55fr .8fr;gap:22px;margin-top:22px}.panel{background:var(--paper);border:1px solid var(--line);box-shadow:var(--shadow);padding:24px}.panel h2{font:650 30px/1 "Avenir Next Condensed","Arial Narrow",sans-serif;letter-spacing:-.02em;margin:5px 0 20px}.counts{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--line);border-left:1px solid var(--line)}.count{padding:18px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.count b{display:block;font:650 35px/1 "Avenir Next Condensed","Arial Narrow",sans-serif}.count span{font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);text-transform:uppercase;letter-spacing:.09em}.status{display:flex;gap:9px;align-items:center;font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace}.dot{width:9px;height:9px;border-radius:50%;background:var(--moss)}
.policy{display:grid;gap:15px}.field{display:grid;gap:6px}.field span{font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}input{width:100%;border:1px solid var(--line);background:white;color:var(--ink);padding:10px 12px;outline:none}input:focus{border-color:var(--telegram);box-shadow:0 0 0 3px rgba(34,158,217,.12)}.toggle{display:flex;align-items:center;gap:10px}.toggle input{width:auto}.save{border:0;background:var(--signal);color:#fff;padding:12px 16px;font:800 12px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.1em;cursor:pointer}.save:hover{filter:brightness(.94)}.save:focus-visible{outline:3px solid var(--telegram);outline-offset:3px}
.list{display:grid;gap:0}.row{display:grid;grid-template-columns:1fr auto;gap:18px;padding:13px 0;border-top:1px solid var(--line)}.row strong{font-size:15px}.meta{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}.badge{align-self:start;font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;color:var(--moss)}.error{color:#9b2d20}.empty{color:var(--muted);font-style:italic}.foot{margin-top:16px;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
@media(max-width:780px){.mast,.grid{grid-template-columns:1fr}.counts{grid-template-columns:repeat(2,1fr)}h1{font-size:58px}.shell{width:min(100% - 20px,1180px);padding-top:20px}.panel{padding:18px}}
@media(prefers-reduced-motion:reduce){.node:nth-child(2):before{animation:none}}
</style></head><body><main class="shell">
<header class="mast"><div><div class="eyebrow">Local control surface · T3 / Telegram</div><h1>Operator cockpit</h1></div><p class="lede">See what is moving through the relay, then tune the few policies that change how work is dispatched.</p></header>
<section class="rail" aria-label="Work relay"><div class="node">Telegram</div><div class="node">Operator</div><div class="node">T3 workers</div></section>
<div class="grid"><div>
<section class="panel"><div class="label">System manifest</div><h2>What is active now</h2><div id="health" class="status"><i class="dot"></i><span>Loading capability…</span></div><div id="counts" class="counts" style="margin-top:20px"></div></section>
<section class="panel" style="margin-top:22px"><div class="label">Scheduled relay</div><h2>Automations</h2><div id="automations" class="list"></div></section>
<section class="panel" style="margin-top:22px"><div class="label">Observed routing</div><h2>Provider performance</h2><div id="providers" class="list"></div></section>
</div><aside>
<section class="panel"><div class="label">Live controls</div><h2>Dispatch policy</h2><form id="policy" class="policy">
<label class="field"><span>Auto-allow categories</span><input name="approvalAutoAllow" placeholder="safe-read"></label>
<label class="field"><span>Parallel workers (2–4)</span><input name="maxParallelWorkers" type="number" min="2" max="4"></label>
<label class="field"><span>Progress interval, ms</span><input name="progressIntervalMs" type="number" min="5000" max="600000"></label>
<label class="toggle"><input name="providerOptimizationEnabled" type="checkbox"> Optimize provider selection</label>
<label class="field"><span>Cost weight</span><input name="providerCostWeight" type="number" min="0" max="1" step="0.05"></label>
<label class="field"><span>Latency weight</span><input name="providerLatencyWeight" type="number" min="0" max="1" step="0.05"></label>
<label class="field"><span>Reliability weight</span><input name="providerReliabilityWeight" type="number" min="0" max="1" step="0.05"></label>
<button class="save" type="submit">Save policy</button><div id="save-status" class="meta" role="status"></div></form></section>
<section class="panel" style="margin-top:22px"><div class="label">Event tape</div><h2>Recent transitions</h2><div id="events" class="list"></div></section>
</aside></div><div class="foot">Bound to 127.0.0.1 · capability stays in this browser fragment · data is never cached</div></main>
<script>
const token=new URLSearchParams(location.hash.slice(1)).get('token')||'';const headers={Authorization:'Bearer '+token};let state;
const esc=v=>String(v??'');const row=(title,meta,badge='')=>{const d=document.createElement('div');d.className='row';const a=document.createElement('div');const s=document.createElement('strong');s.textContent=title;const m=document.createElement('div');m.className='meta';m.textContent=meta;a.append(s,m);const b=document.createElement('div');b.className='badge';b.textContent=badge;d.append(a,b);return d};
async function load(){try{const r=await fetch('/api/state',{headers});if(!r.ok)throw new Error('Capability rejected. Open the full dashboard link from /dashboard.');state=await r.json();render()}catch(e){document.querySelector('#health').innerHTML='<span class="error"></span>';document.querySelector('#health span').textContent=e.message}}
function render(){const h=document.querySelector('#health');h.querySelector('span').textContent=Object.values(state.health).every(v=>v!==false)?'Relay is responding':'One or more adapters need attention';const counts=document.querySelector('#counts');counts.replaceChildren();for(const [k,v] of Object.entries(state.counts)){const d=document.createElement('div');d.className='count';const b=document.createElement('b');b.textContent=v;const s=document.createElement('span');s.textContent=k.replace(/([A-Z])/g,' $1');d.append(b,s);counts.append(d)}
const autos=document.querySelector('#automations');autos.replaceChildren(...(state.automations.length?state.automations.map(a=>row(a.name,a.nextRunAt?'Next '+a.nextRunAt:(a.lastRunAt?'Last '+a.lastRunAt:'No run recorded'),a.status)):[row('No automations','Create one with /automation or the scheduler tool')]));
const providers=document.querySelector('#providers');providers.replaceChildren(...(state.providers.length?state.providers.map(p=>row(p.providerInstanceId+' / '+p.model,Math.round(p.averageLatencyMs)+' ms average · '+p.successes+'/'+p.samples+' successful','$'+Number(p.estimatedCostUsd).toFixed(3))):[row('No observed runs','Provider scoring starts after worker completions')]));
const events=document.querySelector('#events');events.replaceChildren(...state.recentEvents.slice(0,8).map(e=>row(e.type,e.at)));
for(const [k,v] of Object.entries(state.policy)){const el=document.querySelector('[name="'+k+'"]');if(!el)continue;if(el.type==='checkbox')el.checked=Boolean(v);else el.value=Array.isArray(v)?v.join(', '):v}}
document.querySelector('#policy').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const patch={approvalAutoAllow:String(f.get('approvalAutoAllow')||'').split(',').map(v=>v.trim()).filter(Boolean),maxParallelWorkers:Number(f.get('maxParallelWorkers')),progressIntervalMs:Number(f.get('progressIntervalMs')),providerOptimizationEnabled:e.currentTarget.providerOptimizationEnabled.checked,providerCostWeight:Number(f.get('providerCostWeight')),providerLatencyWeight:Number(f.get('providerLatencyWeight')),providerReliabilityWeight:Number(f.get('providerReliabilityWeight'))};const status=document.querySelector('#save-status');status.textContent='Saving…';const r=await fetch('/api/policy',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(patch)});if(!r.ok){const x=await r.json();status.textContent=x.error||'Policy rejected';status.className='meta error';return}status.textContent='Policy saved';status.className='meta';await load()});load();setInterval(load,15000);
</script></body></html>`;
