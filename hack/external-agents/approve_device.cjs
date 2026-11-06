// Disposable-account consent driver. Reads the code printed by the real client.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');
(async()=>{
 for (const key of ['AGENTZ_E2E_STORAGE_STATE','AGENTZ_E2E_LOGIN_LOG','AGENTZ_E2E_ORIGIN','AGENTZ_E2E_MODEL'])
  if(!process.env[key]) throw new Error('Missing '+key);
 const text=fs.readFileSync(process.env.AGENTZ_E2E_LOGIN_LOG,'utf8');
 const code=text.match(/Code: (\S+)/)?.[1];
 const url=code ? process.env.AGENTZ_E2E_ORIGIN+'/oauth/authorize?user_code='+encodeURIComponent(code) : text.match(/https?:\/\/\S+/)?.[0];
 if(!url) throw new Error('Client has not printed a sign-in URL or code');
 const b=await chromium.launch({headless:true});
 try {
  const context=await b.newContext({storageState:process.env.AGENTZ_E2E_STORAGE_STATE});
  const p=await context.newPage();
  await p.goto(url);
  await p.getByRole('combobox',{name:'Models',exact:true}).click();
  await p.getByRole('option').filter({hasText:process.env.AGENTZ_E2E_MODEL}).click();
  await p.keyboard.press('Escape');
  await p.getByRole('button',{name:'Authorize',exact:true}).click();
  if(code) await p.getByRole('heading',{name:'Application connected',exact:true}).waitFor();
  else await p.getByText('Sign-in complete. You may close this window.',{exact:true}).waitFor();
  console.log('PASS real consent completed');
 } finally {await b.close()}
})().catch(e=>{console.error(e.message);process.exit(1)});
