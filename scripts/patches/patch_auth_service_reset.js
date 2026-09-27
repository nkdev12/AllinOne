const fs = require('fs');
const path = './src/auth/auth.service.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  /await this\.mailQueue\.add\("send-password-reset-email", \{[\s\S]*?email: user\.email,[\s\S]*?token,[\s\S]*?\}\);/m,
  `await this.mailQueue.add("send-password-reset-email", {
        email: user.email,
        token,
      });

      // LOG RESET LINK TO TERMINAL FOR LOCAL TESTING
      console.log("\\n=======================================================");
      console.log(\`🔔 PASSWORD RESET LINK FOR \${user.email}:\`);
      console.log(\`\${this.configService.appUrl}/auth/reset-password?token=\${token}\`);
      console.log("=======================================================\\n");`
);

fs.writeFileSync(path, code);
