const fs = require('fs');
const path = './src/queues/processors/mail.processor.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  /await this\.mailService\.sendVerificationEmail\(job\.data\.email, job\.data\.token\);/,
  `await this.mailService.sendVerificationEmail(job.data.email, job.data.token, job.data.otp);`
);

fs.writeFileSync(path, code);
