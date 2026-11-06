const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');const fs=require('fs');
const out=process.env.AGENTZ_E2E_OUTPUT; for(const key of ['AGENTZ_E2E_STORAGE_STATE','AGENTZ_E2E_AGENTS_URL','AGENTZ_E2E_OUTPUT']) if(!process.env[key]) throw new Error('Missing '+key); fs.mkdirSync(out,{recursive:true});
(async()=>{const b=await chromium.launch({headless:true});const c=await b.newContext({storageState:process.env.AGENTZ_E2E_STORAGE_STATE,viewport:{width:1440,height:1000},recordVideo:{dir:out+'/registration-video'}});const p=await c.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));await p.goto(process.env.AGENTZ_E2E_AGENTS_URL);
const clients=[['Claude Code','claude'],['Codex CLI','codex'],['ChatGPT desktop','chatgpt-desktop'],['Claude desktop','claude-desktop'],['GitHub Copilot CLI','github-copilot-cli'],['GitHub Copilot desktop','github-copilot-desktop']];const results=[];
for(const [label,kind] of clients){
 await p.mouse.move(20,950);await p.getByRole('button',{name:'Add agent',exact:true}).click();await p.getByRole('combobox').click();await p.getByRole('option',{name:label,exact:true}).click();await p.locator('#external-agent-name').fill('E2E '+label);await p.getByRole('dialog').getByRole('button',{name:'Add agent',exact:true}).click();
 await p.getByText('Agent added',{exact:true}).waitFor({timeout:45000});
 const dialog=p.getByRole('dialog');await dialog.getByRole('tab',{name:'Setup',exact:true}).click().catch(()=>{});
 await dialog.getByText('2. Save your configuration',{exact:true}).waitFor({timeout:10000});
 const text=await dialog.innerText();fs.writeFileSync(out+'/'+kind+'-setup.txt',text);
 await p.screenshot({path:out+'/'+kind+'-setup.png'});
 results.push({kind,created:true,setupIncludesProvider:text.includes('provider: '+kind)});
 await dialog.getByRole('button',{name:'Close',exact:true}).click();await p.mouse.move(20,950);await p.getByText('Agent added',{exact:true}).waitFor({state:'hidden',timeout:10000}).catch(()=>{});
}
await p.screenshot({path:out+'/registered-clients.png'});fs.writeFileSync(out+'/registration-results.json',JSON.stringify({results,errors},null,2));console.log(JSON.stringify({results,errors}));await c.close();await b.close();if(errors.length)process.exit(1);
})().catch(e=>{console.error(e);process.exit(1)});
