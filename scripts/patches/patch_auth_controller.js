const fs = require('fs');
const path = './src/auth/auth.controller.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  /async confirmEmailVerification\(@Body\(\) dto: ConfirmEmailDto\) \{\s*return this\.authService\.confirmEmailVerification\(dto\.token\);\s*\}/,
  `async confirmEmailVerification(@Body() dto: ConfirmEmailDto) {
    return this.authService.confirmEmailVerification(dto.token, dto.email, dto.otp);
  }`
);

fs.writeFileSync(path, code);
