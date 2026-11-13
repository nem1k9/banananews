// node render.js <match|player|quote|news> <data.json> <out.png>
const {chromium}=require('playwright');const fs=require('fs');const path=require('path');
const [tpl,dataFile,out]=process.argv.slice(2);
const fix=v=>typeof v==='string'&&/\.(png|jpe?g|webp|svg)$/i.test(v)&&!/^(https?|file|data):/.test(v)&&fs.existsSync(v)?'file://'+path.resolve(v):v;
const walk=o=>Array.isArray(o)?o.map(walk):o&&typeof o==='object'?Object.fromEntries(Object.entries(o).map(([k,v])=>[k,walk(v)])):fix(o);
(async()=>{const data=walk(JSON.parse(fs.readFileSync(dataFile,'utf8')));
const b=await chromium.launch();const p=await b.newPage({viewport:{width:1080,height:1350}});
await p.addInitScript(d=>{window.DATA=d},data);
await p.goto('file://'+path.resolve(__dirname,'templates',tpl+'.html'));
await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(400);
await p.locator('#card').screenshot({path:out});await b.close();console.log(out)})();
