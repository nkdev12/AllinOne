const fs = require('fs');
const path = './src/auth/auth.service.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  /const result = await this\.prisma\.\$transaction\(async \(tx\) => \{([\s\S]*?)    \}\);/m,
  `let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
$1    });
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new ConflictException("User with this email already exists");
      }
      throw error;
    }`
);

fs.writeFileSync(path, code);
