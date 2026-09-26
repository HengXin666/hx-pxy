import { chromium } from "playwright"

/*
 * 终端页两个子页(Docker / 运维)的滚动与端口映射门禁。
 *
 * 这两页挂在 App 的 main 里, 而 main 在终端页是 lg:h-full lg:overflow-hidden。
 * 曾经把 padding 留在 main 上, 于是子页 h-full 超出可用高度、溢出被直接裁掉,
 * 而且**没有任何元素成为滚动容器** —— 表现是"看不到端口映射也滚不动"。
 *
 * 门禁用注入数据强制溢出, 断言三件在浏览器里才看得见的事:
 *   1. 存在真正的滚动容器, 且能滚到底;
 *   2. 端口映射单元格不被 ellipsis 截断, 每条映射各占一行;
 *   3. 整页不出现横向溢出。
 *
 *   HX_UI_BASE_URL=http://127.0.0.1:28352 HX_UI_USER=... HX_UI_PASS=... \
 *     node e2e/terminal-scroll.mjs
 */
const baseURL = process.env.HX_UI_BASE_URL
const username = process.env.HX_UI_USER
const password = process.env.HX_UI_PASS
if (!baseURL || !username || !password) throw new Error("HX_UI_BASE_URL, HX_UI_USER and HX_UI_PASS are required")

const containers = []
for (let index = 0; index < 40; index += 1) {
  containers.push({
    id: "c" + index,
    name: "hx-service-" + index,
    image: "hx/proxygroup:" + index,
    state: index % 4 === 0 ? "exited" : "running",
    status: index % 4 === 0 ? "Exited (0) 2 hours ago" : "Up 3 hours",
    ports: "0.0.0.0:2834" + index + "->8000/tcp, [::]:2834" + index + "->8000/tcp, 127.0.0.1:1909" + index + "->9090/tcp",
    created: "2026-09-18 12:00:00 +0800 CST",
    cpu_perc: "1.0%", mem_usage: "12.5MiB / 1GiB", mem_perc: "1.2%",
    net_io: "1.2kB / 3.4kB", block_io: "0B / 4.1kB",
  })
}

const browser = await chromium.launch({ executablePath: process.env.HX_UI_CHROMIUM || "/usr/bin/chromium", headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text().slice(0, 160)) })

await page.route("**/api/v1/docker/containers", (route) => route.fulfill({
  status: 200, contentType: "application/json", body: JSON.stringify({ containers }),
}))

await page.goto(baseURL, { waitUntil: "networkidle" })
await page.waitForTimeout(1000)
await page.getByLabel("用户名").fill(username)
await page.getByLabel("密码").fill(password)
await page.getByRole("button", { name: "登录" }).click()
await page.waitForTimeout(3500)

await page.goto(baseURL + "/#/terminal", { waitUntil: "networkidle" })
await page.waitForTimeout(2500)
await page.getByRole("tab", { name: "Docker" }).click()
await page.waitForTimeout(2500)

const measured = await page.evaluate(() => {
  const scroller = [...document.querySelectorAll("div")].find((element) => {
    const style = getComputedStyle(element)
    return (style.overflowY === "auto" || style.overflowY === "scroll") && element.scrollHeight > element.clientHeight + 4
  })
  const before = scroller ? scroller.scrollTop : 0
  if (scroller) scroller.scrollTop = scroller.scrollHeight
  const after = scroller ? scroller.scrollTop : 0

  const portCells = [...document.querySelectorAll("td")].filter((cell) => (cell.textContent || "").includes("->"))
  const truncated = portCells.filter((cell) => {
    const inner = cell.querySelector("span") || cell
    return getComputedStyle(inner).textOverflow === "ellipsis" && inner.scrollWidth > inner.clientWidth + 1
  }).length

  return {
    hasScroller: scroller !== null,
    scrolled: after > before,
    portCells: portCells.length,
    truncatedPortCells: truncated,
    linesPerPortCell: portCells[0] ? portCells[0].querySelectorAll("span").length : 0,
    documentOverflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
  }
})

const problems = []
if (!measured.hasScroller) problems.push("没有形成滚动容器")
if (!measured.scrolled) problems.push("滚动容器无法滚到内容末尾")
if (measured.portCells === 0) problems.push("没有渲染出端口映射单元格")
if (measured.truncatedPortCells > 0) problems.push(measured.truncatedPortCells + " 个端口映射被截断")
if (measured.linesPerPortCell < 3) problems.push("端口映射没有逐条分行显示")
if (measured.documentOverflowX) problems.push("整页横向溢出")
if (errors.length > 0) problems.push("控制台错误: " + errors.slice(0, 2).join(" / "))

await page.screenshot({ path: "../docs/screenshots/terminal-docker.png", fullPage: true })
await browser.close()

if (problems.length > 0) {
  console.log("FAIL 终端子页滚动: " + problems.join("; "))
  process.exit(1)
}
console.log("ok   终端子页滚动与端口映射 (滚动容器 " + measured.portCells + " 个端口单元格, 每条 " + measured.linesPerPortCell + " 行)")
