import fs from 'node:fs';
if (process.env.EXISTING_TOKEN !== 'fixture-existing-only'
  || !/^[a-f0-9]{64}$/.test(process.env.SESSION_KEY || '')
  || process.env.USER_TOKEN !== 'fixture-user-only'
  || process.env.MODE !== 'development') process.exit(1);
fs.writeFileSync('consumer-ran', 'ok');
console.log('consumer ok');
