import fs from 'node:fs';
import { openTab, captureGraphql, sleep } from './cdp.mjs';
const q = process.argv[2] || 'looking for someone to automate';
const tab = await openTab();
await tab.send('Network.enable');
const got = [];
captureGraphql(tab, got);
await tab.send('Page.navigate', { url: 'https://www.facebook.com/search/posts/?q=' + encodeURIComponent(q) });
await sleep(7000);
for (let i = 0; i < 2; i++) { await tab.send('Runtime.evaluate', { expression: 'window.scrollBy(0, 3000)' }); await sleep(4000); }
const html = await tab.send('Runtime.evaluate', { expression: 'document.title + " | " + location.href + " | " + document.body.innerText.slice(0, 600)', returnByValue: true });
console.log('PAGE:', html.result?.value?.replace(/\n/g, ' ').slice(0, 700));
got.forEach((g, i) => { fs.writeFileSync(`probe/${i}_${g.name}.json`, g.body); console.log(i, g.name, g.body.length); });
await tab.close();
