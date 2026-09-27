const fs = require('fs');
const path = './src/auth/auth.service.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  /const otp = Math\.floor\(100000 \+ Math\.random\(\) \* 900000\)\.toString\(\);/,
  `const otp = Math.floor(100000 + Math.random() * 900000).toString();
      
      // LOG OTP TO TERMINAL FOR LOCAL TESTING
      console.log("\\n=======================================================");
      console.log(\`🔔 OTP CODE FOR \${user.email}: \${otp}\`);
      console.log("=======================================================\\n");`
);

fs.writeFileSync(path, code);
