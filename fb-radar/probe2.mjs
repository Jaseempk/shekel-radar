import fs from 'node:fs';
import { openTab, captureGraphql, sleep } from './cdp.mjs';
const [kind, arg] = process.argv.slice(2);
const tab = await openTab();
await tab.send('Network.enable');
const got = [];
captureGraphql(tab, got);
const url = kind === 'groups'
  ? 'https://www.facebook.com/search/groups/?q=' + encodeURIComponent(arg)
  : `https://www.facebook.com/groups/${arg}/search/?q=` + encodeURIComponent(process.argv[4] || 'invoices');
await tab.send('Page.navigate', { url });
await sleep(7000);
await tab.send('Runtime.evaluate', { expression: 'window.scrollBy(0, 3000)' });
await sleep(4000);
const ssr = await tab.send('Runtime.evaluate', { expression: '[...document.querySelectorAll(\'script[type="application/json"]\')].map(s => s.textContent).filter(t => t.includes("serpResponse") || t.includes("SearchPost")).join("\\n")', returnByValue: true });
fs.writeFileSync('probe/ssr.json', ssr.result?.value ?? '');
got.forEach((g, i) => fs.writeFileSync(`probe/${i}_${g.name}.json`, g.body));
const txt = await tab.send('Runtime.evaluate', { expression: 'location.href + " || " + (document.querySelector("[role=main]")?.innerText ?? "").replace(/\\n+/g," | ").slice(0,1500)', returnByValue: true });
console.log(txt.result?.value);
console.log(got.map((g) => g.name).filter((n) => /Search/.test(n)).join(', '), '| ssr bytes', (ssr.result?.value ?? '').length);
await tab.close();
