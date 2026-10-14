import assert from "node:assert/strict"
import { chromium } from "playwright"

const base = process.env.HX_UI_BASE_URL
if (!base) throw new Error("HX_UI_BASE_URL required; all API requests are mocked")
const browser = await chromium.launch({ executablePath: process.env.HX_UI_CHROMIUM || "/usr/bin/chromium" })
try {
for (const width of [1440, 390]) {
 const page = await browser.newPage({ viewport: { width, height: 950 } })
 await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { value: {writeText: async value => { window.__copied = value }} }) })
 const errors = []
 page.on("pageerror", error => errors.push(error.stack))
 let releaseNodes
 const gate = new Promise(resolve => { releaseNodes = resolve })
 let nodeFinished = false
 const operations = []
 const settings = { tun: { enabled:false, proxy_group_id:"" }, quality:{check_interval_seconds:600,timeout_seconds:5,batch_size:10,probe_concurrency:2,test_url:"https://example.com",health_targets:[]},dns:{enabled:true,ipv6:false,enhanced_mode:"normal",default_nameserver:[],nameserver:["1.1.1.1"],fallback:[]}, performance:{tcp_concurrent:true, unified_delay:true,keep_alive_idle_seconds:30,keep_alive_interval_seconds:30,find_process_mode:"off",log_level:"info"},shared_inbound:{mode:"per_service",mixed_bind_address:"127.0.0.1",mixed_port:7890,ws_port:7891},guard:{deny_api_group_create:false},log_retention_days:30 }
 const group = {id:"group-test",name:"Test Exit",enabled:true,version:1,strategy:"select",source_spec:{include_direct:true,node_ids:[],group_ids:[],subscription_ids:[]},empty_behavior:"direct"}
 const listener = {id:"listener-test",name:"Test Docker Entry",kind:"mixed",bind_address:"0.0.0.0",port:17890,enabled:true,version:1,proxy_group_id:group.id,public_endpoint:{host:"public.example.com"},transport:{},auth:{configured:false}}
 await page.route("**/api/v1/**", async route => {
  const path = new URL(route.request().url()).pathname
  let body = {items:[]}
  if (path.endsWith("/auth/status")) body = {configured:true,authenticated:true,username:"test",csrf_token:"test"}
  else if (path.endsWith("/nodes")) { await gate; body={items:[],total:0}; nodeFinished=true }
  else if (path.endsWith("/proxy-groups")) body={items:[group]}
  else if (path.endsWith("/listeners")) body={items:[listener]}
  else if (path.endsWith("/settings")) body=settings
  else if (path.endsWith("/routing-rules")) body={rule_sets:[]}
  else if (path.endsWith("/dataplane/status")) body={running:true,healthy:true,proxy_count:0}
  else if (path.endsWith("/system/network")) body={docker_gateway:"172.17.0.1",lan_addresses:["172.17.0.1"]}
  else if (path.endsWith("/network/inspect")) body={tun_available:true,ipv4_forwarding:false,interfaces:[{name:"docker0",kind:"docker",up:true,addresses:["172.17.0.1/16"]},{name:"other-tun",kind:"tun",up:true,addresses:["198.18.0.1/30"]}]}
  else if (path.endsWith("/network/operations")) {operations.push(route.request().postDataJSON());body={exit_code:0,stdout:"diagnostic fixture",stderr:""}}
  else if (path.endsWith("/connections")) body={total:1,sampled_at:new Date().toISOString(),items:[{id:"c",origin:"docker",source_ip:"172.17.0.2",source_port:"40000",destination:"1.1.1.1",destination_port:"443",network:"tcp",inbound:"Mixed",upload:10,download:20}]}
  await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)})
 })
 await page.goto(base+"/#/routing",{waitUntil:"domcontentloaded"})
 await page.getByText("Test Docker Entry",{exact:true}).waitFor({timeout:10000}).catch(async error => { console.error(errors, await page.locator("body").innerText()); throw error })
 assert.equal(nodeFinished,false,"service rows must not wait for node inventory")
 await page.screenshot({path:`../docs/screenshots/routing-progressive-${width}.png`})
 releaseNodes()
 await page.getByRole("combobox").filter({hasText:"服务操作"}).click()
 await page.getByRole("option",{name:"复制 Docker 使用地址",exact:true}).click()
 await page.waitForFunction(() => window.__copied === "172.17.0.1:17890")
 await page.getByRole("button",{name:"新建代理服务",exact:true}).click()
 const dialog = page.getByRole("dialog")
 await dialog.getByRole("button",{name:"住宅代理",exact:true}).click()
 await dialog.getByRole("link",{name:"配置住宅供应商账号、密码与渠道"}).waitFor()
 await page.screenshot({path:`../docs/screenshots/residential-create-${width}.png`})
 await page.keyboard.press("Escape")
 await page.getByRole("button",{name:"活跃连接 展开"}).click()
 await page.getByText("172.17.0.2:40000",{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,"routing horizontal overflow")
 await page.goto(base+"/#/settings",{waitUntil:"domcontentloaded"})
 await page.getByRole("tab",{name:"运行",exact:true}).click()
 const tun = page.getByRole("checkbox",{name:"启用当前环境 TUN（保存并应用后生效）"})
 assert.equal(await tun.isChecked(),false)
 await page.getByText(/other-tun/).waitFor()
 await page.getByRole("button",{name:"网络诊断",exact:true}).click()
 await page.getByText(/diagnostic fixture/).waitFor()
 assert.equal(operations[0].action,"diagnose")
 page.once("dialog",dialog=>dialog.dismiss())
 await page.getByRole("button",{name:"修复：开启 IPv4 转发",exact:true}).click()
 assert.equal(operations.length,1,"cancelled repair must not send a request")
 await page.screenshot({path:`../docs/screenshots/network-settings-${width}.png`,fullPage:true})
 assert.deepEqual(errors,[])
 await page.close()
 console.log(`network-routing-regression: ${width}px passed`)
}
} finally {await browser.close()}
