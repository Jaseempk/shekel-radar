/** Read-only: open a post or profile and print its visible text (who the author is, how contested the post is). */
import { openTab, sleep } from './cdp.mjs';

function readPage() {
  const dialogs = [...document.querySelectorAll('[role=dialog]')];
  const post = dialogs.find((d) => /(’|')s post/.test(d.innerText));
  const text = (post ?? document.querySelector('[role=main]'))?.innerText ?? '';
  const comments = (text.match(/(\d+)\s+comments?/) || [])[0] || 'no comment count';
  return `[${comments}] ` + text.replace(/(Facebook\s*)+/g, ' ').replace(/\n+/g, ' | ').slice(0, 2500);
}

const tab = await openTab();
for (const url of process.argv.slice(2)) {
  await tab.send('Page.navigate', { url });
  await sleep(6500 + Math.random() * 3000);
  const r = await tab.send('Runtime.evaluate', { expression: `(${readPage})()`, returnByValue: true });
  console.log('=====', url, '\n', r.result?.value ?? r.exceptionDetails?.text);
}
await tab.close();
