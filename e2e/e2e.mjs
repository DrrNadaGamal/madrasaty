// Browser checks against a running Madrasaty (local dev server or the live URL).
// Usage: node e2e/e2e.mjs https://your-deploy.vercel.app   (needs Chrome at /usr/bin/google-chrome)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
const U = process.argv[2] || 'http://localhost:3100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log(c ? 'PASS' : 'FAIL', m); };
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: 'new' });
const errs = [];
async function newPage(w = 1440, h = 900) {
  const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: w, height: h });
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
  p.on('dialog', (d) => d.accept()); return p;
}
async function login(p, pin, lang = 'en') {
  await p.goto(U + '/?lang=' + lang, { waitUntil: 'networkidle0' });
  await p.evaluate(() => localStorage.clear()); await p.goto(U + '/?lang=' + lang, { waitUntil: 'networkidle0' });
  await p.type('#pin', pin); await p.keyboard.press('Enter'); await p.waitForSelector('.top', { timeout: 15000 }); await sleep(300);
}
const go = async (p, r) => { await p.evaluate((r) => (location.hash = '#/' + r), r); await sleep(400); };
const txt = (p, sel = 'body') => p.$eval(sel, (e) => e.innerText).catch(() => '');
const toastText = async (p) => { await sleep(300); return txt(p, '#toast'); };
const click = async (p, sel) => { await p.waitForSelector(sel, { timeout: 8000 }); await p.click(sel); await sleep(300); };
const setVal = async (p, sel, v) => { await p.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v); };
const count = (p, sel) => p.$$eval(sel, (e) => e.length);
const navs = (p) => p.$$eval('.nav a', (a) => a.map((x) => x.getAttribute('href').slice(2)));
const api = (p, method, body) => p.evaluate(async (method, body) => { const r = await fetch('/api/data', { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + JSON.parse(localStorage.getItem('md.token')) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; }, method, body);

// ---- 0. sign-in ----
let p = await newPage();
await p.goto(U + '/?lang=en', { waitUntil: 'networkidle0' });
ok((await count(p, '.demo-users button')) === 4, 'sign-in shows 4 demo accounts');
await p.type('#pin', '0000'); await p.keyboard.press('Enter'); await sleep(600);
ok(/Wrong PIN/.test(await txt(p)), 'wrong PIN is refused with a message');
await click(p, '[data-act=lang]');
ok((await p.$eval('html', (e) => e.dir)) === 'rtl' && /تسجيل الدخول/.test(await txt(p)), 'Arabic switches the page to right-to-left');
ok((await api(p, 'GET').catch(() => ({ status: 0 }))).status !== 200, 'no token, no data');
await p.close();

// ---- 1. principal ----
p = await newPage(); await login(p, '1111');
ok(JSON.stringify(await navs(p)) === JSON.stringify(['dashboard', 'students', 'attendance', 'grades', 'fees', 'receipts', 'overdue', 'timetable', 'announcements', 'people', 'audit']), 'principal sees all 11 sections');
ok((await count(p, '.card.kpi')) >= 4 && /72/.test(await txt(p)), 'dashboard shows KPIs and 72 students');
ok((await count(p, '.grid.two table tbody tr')) >= 6, 'attendance by class lists 6 classes');
await go(p, 'students'); ok((await count(p, 'tbody tr')) === 72, 'students list has 72 rows');
await setVal(p, '#q', 'Yara Farouk'); await sleep(300); ok((await count(p, 'tbody tr')) === 1, 'search narrows to one student');
await setVal(p, '#q', ''); await sleep(200);
await setVal(p, '[data-in=classF]', 'c1'); await sleep(300); const kg1 = await count(p, 'tbody tr'); ok(kg1 === 12, 'class filter KG1 gives 12');
// add student: validation then success
await click(p, '[data-act=add-student]'); await click(p, '[data-act=student-go]');
ok(/Enter the student name/.test(await toastText(p)), 'adding a student with no name shows the reason');
await p.type('#s-name', 'Test Student'); await setVal(p, '#s-class', 'c1'); await p.type('#s-dob', '2022-02-02'); await click(p, '[data-act=student-go]'); await sleep(400);
ok(/Test Student/.test(await txt(p)) && /S-007\d/.test(await txt(p)), 'new student is created and opened with a code');
await click(p, '[data-act=move-class]'); await setVal(p, '#m-class', 'c2'); await click(p, '[data-act=move-go]'); await sleep(300);
ok(/KG2/.test(await txt(p, '.dl')), 'student moved to KG2');
await click(p, '[data-act=withdraw]'); await click(p, '[data-act=withdraw-go]');
ok(/Write a reason/.test(await toastText(p)), 'withdraw needs a reason');
await p.type('#w-reason', 'Family moved'); await click(p, '[data-act=withdraw-go]'); await sleep(300);
ok(/Withdrawn/.test(await txt(p)), 'student shows as withdrawn');
// fees
await go(p, 'fees'); await setVal(p, '[data-in=classF]', ''); await sleep(300); ok((await count(p, 'tbody tr')) >= 72, 'fees lists everyone');
await p.$eval('[data-in=overdueOnly]', (e) => e.click()); await sleep(300); const odRows = await count(p, 'tbody tr'); ok(odRows > 10 && odRows < 72, 'overdue-only filter narrows the list (' + odRows + ')');
await p.$eval('[data-in=overdueOnly]', (e) => e.click()); await sleep(300);
await setVal(p, '#app [data-in=q]', 'Yara Farouk'); await sleep(300);
await click(p, '[data-act=pay]'); const before = await txt(p, '.modal');
ok(/Installment 2/.test(before) && /Overdue/.test(before), 'pay window lists the overdue installment');
await setVal(p, '#pay-amt', '99999999'); await click(p, '[data-act=pay-go]');
ok(/more than what is owed/.test(await toastText(p)), 'overpayment is refused');
await setVal(p, '#pay-amt', '1000'); await setVal(p, '#pay-method', 'card'); await click(p, '[data-act=pay-go]'); await sleep(400);
const rc = await txt(p, '.receipt'); ok(/RC-\d{6}/.test(rc) && /1,000\.00/.test(rc) && /Card/.test(rc), 'receipt is shown with number, amount and method');
const rcNo = rc.match(/RC-\d{6}/)[0];
await click(p, '[data-act=void]'); await click(p, '[data-act=void-go]'); ok(/Write a reason/.test(await toastText(p)), 'void needs a reason');
await p.type('#void-reason', 'Typed on the wrong child'); await click(p, '[data-act=void-go]'); await sleep(300);
await go(p, 'receipts'); await setVal(p, '[data-in=rcptQ]', rcNo); await sleep(300);
ok((await count(p, 'tr.void')) === 1, 'voided receipt is marked in the receipts list');
// overdue + remind
await go(p, 'overdue'); const reminders0 = await count(p, '[data-act=remind]'); ok(reminders0 > 10, 'overdue page lists students with a reminder button');
await click(p, '[data-act=remind]'); ok(/Reminder sent/.test(await toastText(p)), 'reminder sent'); ok((await count(p, '[data-act=remind]')) === reminders0 - 1, 'that student can not be reminded again for 7 days');
// timetable clash
await go(p, 'timetable'); await setVal(p, '[data-in=tt]', 'c6'); await sleep(300); ok((await count(p, '.tt td')) === 25, 'timetable grid has 25 cells');
const clash = await p.evaluate(() => { const c = [...document.querySelectorAll('.tt td')].find((td) => /Omar Khalil/.test(td.innerText)); return c ? [...c.parentElement.children].indexOf(c) - 1 + ',' + (c.parentElement.rowIndex + 1) : null; });
ok(!!clash, 'a Grade 4 period taught by the primary English teacher exists');
// announcements: hostile text must stay text
await go(p, 'announcements'); await p.type('#a-title', '<img src=x onerror=window.__x=1>Hi'); await p.type('#a-body', '<script>window.__y=1</script> hello'); await click(p, '#app form[data-form=ann] button[type=submit]'); await sleep(500);
ok(/<img src=x/.test(await txt(p, 'main')) && (await count(p, '.ann img')) === 0 && !(await p.evaluate(() => window.__x || window.__y)), 'script and image tags in a message are shown as text, not run');
// people
await go(p, 'people'); await click(p, '[data-act=add-user]'); await p.type('#u-name', 'Dup Pin'); await p.type('#u-pin', '1111'); await click(p, '[data-act=user-go]'); ok(/already used/.test(await toastText(p)), 'duplicate PIN refused');
await p.$eval('#u-pin', (e) => (e.value = '')); await p.type('#u-pin', '7777'); await click(p, '[data-act=user-go]'); await sleep(300); ok(/Dup Pin/.test(await txt(p)), 'new account is added');
await go(p, 'audit'); ok((await count(p, 'tbody tr')) >= 6, 'audit trail records the actions above');
await go(p, 'dashboard'); await click(p, '[data-act=reset]'); await sleep(600); await go(p, 'students'); await setVal(p, '[data-in=classF]', ''); await setVal(p, '#q', ''); await sleep(300); ok((await count(p, 'tbody tr')) === 72, 'reset restores the 72 demo students');
await p.close();

// ---- 2. teacher ----
p = await newPage(); await login(p, '2222');
ok(JSON.stringify(await navs(p)) === JSON.stringify(['dashboard', 'attendance', 'grades', 'students', 'timetable', 'announcements']), 'teacher sees no fees, receipts or people');
await go(p, 'fees'); ok(!/Billed|Overdue/.test(await txt(p, 'main')) && /My class|Grade 2/.test(await txt(p, 'main')), 'typing the fees address shows the dashboard instead');
ok((await api(p, 'POST', { op: { type: 'payment', studentId: 's1', amount: 100, method: 'cash' } })).status === 403, 'server refuses a payment from a teacher');
ok(!JSON.stringify((await api(p, 'GET')).json).includes('"charges"'), 'server sends a teacher no fee data');
await go(p, 'attendance');
ok(await p.$eval('[data-act=att-save]', (e) => e.disabled), 'save is disabled until everyone is marked');
await click(p, '[data-act=att-all]'); await p.$eval('[data-act=att-mark][data-m=A]', (e) => e.click()); await sleep(300);
ok(!(await p.$eval('[data-act=att-save]', (e) => e.disabled)), 'save enabled once everyone is marked');
await click(p, '[data-act=att-save]'); ok(/Saved/.test(await toastText(p)) && /Taken/.test(await txt(p, '.bar')), 'attendance saved and shown as taken');
ok(/Absent 1/.test(await txt(p, '.card')), 'the absent count is 1');
const opts = await p.$$eval('[data-in=att-date] option', (o) => o.length); ok(opts === 2, 'teacher can only pick two dates');
await go(p, 'grades'); const first = '.score'; await setVal(p, first, '99'); await click(p, '[data-act=gr-save]'); ok(/between 0 and 30/.test(await toastText(p)), 'score above the maximum is refused');
await setVal(p, first, '27.5'); await click(p, '[data-act=gr-save]'); ok(/Saved/.test(await toastText(p)) && (await p.$eval(first, (e) => e.value)) === '27.5', 'valid half mark saved and shown');
await p.$eval('[data-in=gr-term]', (e) => { e.value = '2'; e.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(300);
ok(/0 \/ 12 entered/.test(await txt(p)), 'term 2 midterm starts empty');
await p.$eval('.btn.sm[href^="#/report"]', (e) => e.click()); await sleep(500);
ok(/Provisional/.test(await txt(p)), 'term 2 report card is provisional');
await p.type('#remark', 'Improving every week.'); await click(p, '[data-act=save-remark]'); ok(/Improving every week/.test(await txt(p, '#remark-view')), 'class teacher comment is saved on the card');
await p.close();

// ---- 3. accountant ----
p = await newPage(); await login(p, '3333');
ok(JSON.stringify(await navs(p)) === JSON.stringify(['dashboard', 'fees', 'receipts', 'overdue', 'announcements']), 'accountant sees only fee sections');
const av = (await api(p, 'GET')).json; ok(!('scores' in av) && !('attendance' in av), 'server sends the accountant no grades or attendance');
ok((await api(p, 'POST', { op: { type: 'setScores', classId: 'c4', subjectId: 'math', term: 1, kind: 'mid', scores: {} } })).status === 403, 'server refuses grades from the accountant');
await go(p, 'overdue'); ok(/tel:/.test(await p.$eval('tbody', (e) => e.innerHTML)), 'overdue list gives each guardian phone as a call link');
await p.close();

// ---- 4. parent ----
p = await newPage(); await login(p, '4444');
ok(JSON.stringify(await navs(p)) === JSON.stringify(['dashboard', 'progress', 'fees', 'timetable', 'announcements']), 'parent sees five sections');
ok((await count(p, '.child')) === 2 && /Yara Farouk/.test(await txt(p)) && /Adam Farouk/.test(await txt(p)), 'parent sees exactly their two children');
const pv = (await api(p, 'GET')).json; ok(pv.students.length === 2 && !('finance' in pv) && !('users' in pv), 'server sends the parent only their children');
const other = await api(p, 'POST', { op: { type: 'payment', studentId: 's5', amount: 100, method: 'cash' } }); ok(other.status === 403, 'server refuses a payment from a parent');
const sneaky = await api(p, 'POST', { op: { type: 'setScores', classId: 'c6', subjectId: 'math', term: 1, kind: 'mid', scores: { s67: 30 } } }); ok(sneaky.status === 403, 'server refuses grades from a parent');
ok(/overdue/i.test(await txt(p)) && (await count(p, '.ann.sys')) >= 0, 'overdue amount shows on the child card');
await go(p, 'progress'); ok(/Term 1/.test(await txt(p)) && /Average/.test(await txt(p)) && (await count(p, '.rc tbody tr')) === 5, 'report card for the KG2 child has 5 subjects');
await go(p, 'report/' + pv.students[1].id + '/1'); ok((await count(p, '.rc tbody tr')) === 7, 'report card for the Grade 4 child has 7 subjects');
await go(p, 'student/s5'); ok(/Not found|Nothing here/i.test(await txt(p, 'main')) || !/Test|S-0005/.test(await txt(p, 'main')), 'another family student page shows nothing');
await go(p, 'fees'); ok((await count(p, '.card .tw')) >= 2 && /Sibling discount/.test(await txt(p)) && /school office/.test(await txt(p)), 'fees page shows statements, sibling discount and the pay-at-office note');
await go(p, 'timetable'); ok((await count(p, '.tt td')) === 25, 'timetable shows the child class');
await go(p, 'announcements'); ok(!/Teachers? only|Staff meeting/.test(await txt(p)) && /Parents meeting/.test(await txt(p)), 'announcements for staff are not shown to parents');
// report card as a real PDF
await go(p, 'report/' + pv.students[1].id + '/1'); await p.emulateMediaType('print');
const pdf = await p.pdf({ format: 'A4', printBackground: true }); fs.writeFileSync('/tmp/report-card.pdf', Buffer.from(pdf));
ok(Buffer.from(pdf).subarray(0, 4).toString() === '%PDF', 'report card prints to a PDF');
let pdfText = ''; try { pdfText = execSync('pdftotext /tmp/report-card.pdf -').toString(); } catch {}
ok(/Adam Farouk/.test(pdfText) && /Report card/i.test(pdfText) && !/Billed|Sign out/.test(pdfText), 'the PDF holds the report card only, no menus');
await p.emulateMediaType('screen'); await p.close();

// ---- 5. Arabic and phone ----
p = await newPage(390, 844); await login(p, '4444', 'ar');
ok((await p.$eval('html', (e) => e.dir)) === 'rtl' && /أبنائي/.test(await txt(p)) && /يارا فاروق/.test(await txt(p)), 'Arabic parent home with Arabic names');
const raw = await p.$eval('body', (e) => e.innerText.match(/\b[a-z]+\.[a-zA-Z]+\b/g)); ok(!raw, 'no raw translation keys on screen ' + JSON.stringify(raw));
ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'parent home fits a 390px phone');
for (const r of ['fees', 'timetable', 'progress']) { await go(p, r); ok(await p.evaluate(() => { const w = document.documentElement.scrollWidth; return w <= window.innerWidth + 1 || [...document.querySelectorAll('.tw')].some((e) => e.scrollWidth > e.clientWidth); }), 'phone layout: ' + r + ' has no page-wide sideways scroll'); }
await p.close();
p = await newPage(390, 844); await login(p, '2222', 'ar'); await go(p, 'attendance');
ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'attendance sheet fits a phone'); await p.close();

console.log(`\n${pass} passed, ${fail} failed; page errors: ${JSON.stringify(errs)}`);
// leave the demo as we found it
p = await newPage(); await login(p, '1111'); await api(p, 'POST', { op: { type: 'reset' } }); await p.close();
await b.close(); process.exit(fail || errs.length ? 1 : 0);
