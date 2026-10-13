'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const cheerio = require('cheerio');
const admin = require('firebase-admin');

const BASE = 'https://nszo.hu';
const SECTIONS = ['belfold','kulfold','gazdasag','velemeny','sport','kultura','mozaik'];
const PAGE_URLS = [`${BASE}/`, ...SECTIONS.map(s => `${BASE}/rovat/${s}/`)];
const STATE_FILE = 'state/seen.json';
const DAY = 86400000;
const LIMIT = 20;
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));

function newsFromAnchor(href, label) {
  let u;
  try { u = new URL(href,BASE); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'nszo.hu') return null;
  const match = u.pathname.match(/^\/(20\d\d)\/(\d\d)\/(\d\d)\/([a-z0-9-]+)\/([^/]+)\/?$/i);
  if (!match) return null;
  const section = match[4].toLowerCase();
  if (!SECTIONS.includes(section)) return null;
  const date = Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]));
  if (date > Date.now()+DAY || date < Date.now()-3*DAY) return null;
  const title = String(label||'').replace(/\s+/g,' ').trim();
  if (title.length < 12 || title.length > 240) return null;
  u.search=''; u.hash='';
  const url = u.toString().replace(/\/$/,'')+'/';
  return {id:crypto.createHash('sha256').update(url).digest('hex'),url,title,section};
}
async function fetchStories(url) {
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(),15000);
  let html;
  try {
    const res = await fetch(url,{signal:ctrl.signal,headers:{'User-Agent':'NSZO-Reader/0.4 (+public headline monitor; GitHub Actions)','Accept':'text/html,application/xhtml+xml'}});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } finally {clearTimeout(t);}
  const $ = cheerio.load(html);
  const found = new Map();
  const selectors = 'h1 a[href],h2 a[href],h3 a[href],h4 a[href],article a[href],.not-found-item a[href],.latest-news a[href]';
  function add(_,e) {
    const el=$(e);
    const title=el.text().trim()||el.attr('aria-label')||el.attr('title')||el.closest('article').find('h2,h3,h4').first().text();
    const news=newsFromAnchor(el.attr('href'),title);
    if(news) found.set(news.id,news);
  }
  $(selectors).each(add);
  if(!found.size) $('a[href]').each(add);
  console.log(`Read ${url}: ${found.size} eligible links`);
  return [...found.values()];
}
function loadState() {
  try {return JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));}
  catch(err) {if(err.code==='ENOENT') return null; throw err;}
}
function saveState(state) {
  fs.mkdirSync('state',{recursive:true});
  fs.writeFileSync(STATE_FILE,JSON.stringify(state,null,2)+'\n');
}
async function main() {
  const results=await Promise.allSettled(PAGE_URLS.map(fetchStories));
  const all = new Map();
  let successes=0;
  results.forEach((r,i)=>{
    if(r.status==='fulfilled'){successes++;r.value.forEach(n=>all.set(n.id,n));}
    else console.warn(`Failed ${PAGE_URLS[i]}: ${r.reason}`);
  });
  if(!successes) throw new Error('No pages could be fetched; no state change');
  const state=loadState();
  const now=new Date().toISOString();
  if(!state){
    const baseline={lastRun:now,seen:Object.fromEntries([...all.keys()].map(id=>[id,now]))};
    saveState(baseline);
    console.log(`Silent baseline created (${all.size} stories); no pushes sent`);
    return;
  }
  // Prune history after 14 days to keep git changes small.
  state.seen ||= {};
  for(const [id,date] of Object.entries(state.seen)) if(Date.now()-Date.parse(date)>14*DAY) delete state.seen[id];
  const additions=[...all.values()].filter(n=>!state.seen[n.id]).slice(0,LIMIT);
  console.log(`${all.size} current stories; ${additions.length} new`);
  if(additions.length){
    const raw=process.env.FIREBASE_SERVICE_ACCOUNT;
    if(!raw) throw new Error('GitHub secret FIREBASE_SERVICE_ACCOUNT missing');
    const credentials=JSON.parse(raw);
    admin.initializeApp({credential:admin.credential.cert(credentials)});
    for(const n of additions){
      try {
        const id=await admin.messaging().send({topic:n.section,data:{title:`Népszabadság · ${n.section}`,body:n.title,article_url:n.url,section:n.section},android:{priority:'high'}});
        console.log(`Sent ${n.section}: ${n.title} (${id})`);
        state.seen[n.id]=now;
      }catch(err){
        console.error(`FCM failed ${n.url}: ${err.message}`);
        // Leave unseen for retry on next scan.
      }
      await sleep(100);
    }
  }
  state.lastRun=now;
  saveState(state);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
