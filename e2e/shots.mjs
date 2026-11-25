// Takes the screenshots used in the README and the case study. Usage: node e2e/shots.mjs <url> <outdir>
import puppeteer from 'puppeteer-core';
const U = process.argv[2] || 'http://localhost:3100', out = (process.argv[3] || '/tmp/shots/').replace(/\/?$/, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: 'new' });
const errs = [];
async function session(pin, lang, w, h, fn) {
  const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: w, height: h, deviceScaleFactor: w < 500 ? 2 : 1 });
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
  await p.goto(U + '/?lang=' + lang, { waitUntil: 'networkidle0' }); await p.type('#pin', pin); await p.keyboard.press('Enter'); await p.waitForSelector('.top'); await sleep(500);
  await fn(p); await ctx.close();
}
const go = async (p, r) => { await p.evaluate((r) => (location.hash = '#/' + r), r); await sleep(500); };
const shot = (p, n, full) => p.screenshot({ path: out + n + '.png', fullPage: !!full });
const set = async (p, sel, v) => { await p.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, v); await sleep(300); };
await session('1111', 'en', 1440, 1000, async (p) => {
  await shot(p, 'dashboard');
  await go(p, 'overdue'); await shot(p, 'overdue');
  await go(p, 'fees'); await p.$eval('[data-in=overdueOnly]', (e) => e.click()); await sleep(300); await p.click('[data-act=pay]'); await sleep(300); await shot(p, 'pay');
  await p.click('[data-act=pay-go]'); await sleep(500); await shot(p, 'receipt');
  await p.click('[data-act=close]'); await go(p, 'timetable'); await set(p, '[data-in=tt]', 'c4'); await shot(p, 'timetable');
  await go(p, 'students'); await shot(p, 'students');
});
await session('2222', 'en', 1440, 1000, async (p) => {
  await go(p, 'attendance'); await p.click('[data-act=att-all]'); await sleep(200);
  for (const i of [3, 8]) await p.$$eval('[data-act=att-mark][data-m=A]', (e, i) => e[i].click(), i); await sleep(200);
  await p.$$eval('[data-act=att-mark][data-m=L]', (e) => e[5].click()); await sleep(300); await shot(p, 'attendance');
  await go(p, 'grades'); await set(p, '[data-in=gr-subject]', 'math'); await set(p, '[data-in=gr-kind]', 'final'); await shot(p, 'grades');
});
await session('4444', 'ar', 1440, 1000, async (p) => { await shot(p, 'parent-ar'); await p.setViewport({ width: 1440, height: 1250 }); await go(p, 'progress'); await sleep(300); await shot(p, 'report-card-ar'); await go(p, 'fees'); await shot(p, 'parent-fees-ar'); });
await session('4444', 'en', 1440, 1250, async (p) => { await go(p, 'progress'); await sleep(300); await shot(p, 'report-card'); });
await session('4444', 'ar', 390, 844, async (p) => { await shot(p, 'parent-mobile-ar', true); });
console.log('errors:', errs);
await b.close();
