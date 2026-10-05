const fs = require('fs');
const path = require('path');

// One-off PostgreSQL -> MongoDB sweep left over from commit 538cc50. It also
// points at `scripts/PROJECT_STATUS.md`, which does not exist (the file lives at
// the repo root), so it currently throws ENOENT. Kept only as history and gated:
// its "Why PostgreSQL?" -> "Why MongoDB?" rewrite replaces the annotated section
// with claims about sharding and read/write performance that nothing here has
// measured.
if (process.env.RUN_ONE_OFF !== '1') {
  console.error(
    'scripts/update_docs.js is a completed one-off migration and will not run.\n' +
      'Set RUN_ONE_OFF=1 only if you mean to re-apply the blanket replacement.'
  );
  process.exit(1);
}

const projectStatusPath = path.join(__dirname, 'PROJECT_STATUS.md');
let content = fs.readFileSync(projectStatusPath, 'utf8');

// Architecture diagram
content = content.replace('│  PostgreSQL  Redis  MinIO   │', '│   MongoDB  Redis  MinIO     │');
content = content.replace(/PostgreSQL\s+↓/g, 'MongoDB\n    ↓');

// Tech stack
content = content.replace(/\| \*\*Database\*\* \| PostgreSQL 16 \| PostgreSQL \|/, '| **Database** | MongoDB 7.0 | Server Side Public License |');

// Env setup
content = content.replace(/SQLITE_URL=postgresql:\/\/allinone:allinone@localhost:5432\/allinone_dev/g, 'DATABASE_URL=mongodb://localhost:27017/allinone_dev?replicaSet=rs0&directConnection=true');
content = content.replace(/DATABASE_URL=postgresql:\/\/user:pass@postgres:5432\/allinone_prod/g, 'DATABASE_URL=mongodb://user:pass@mongo:27017/allinone_prod?replicaSet=rs0&directConnection=true');

// Why section
const whyPostgresRegex = /### Why PostgreSQL\?[\s\S]*?(?=### Why Prisma\?)/;
const whyMongo = `### Why MongoDB?
- Flexible document schema
- Excellent read/write performance
- Built-in horizontal scaling (sharding)
- Rich querying capabilities
- Mature & battle-tested NoSQL database

`;
content = content.replace(whyPostgresRegex, whyMongo);

fs.writeFileSync(projectStatusPath, content);
console.log('Updated PROJECT_STATUS.md');

